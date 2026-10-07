/*
 * ao-vivo.js — modo celular + sincronização ao vivo da apresentação.
 *
 * Apresentador: abra  index.html?apresentador
 * Público:      abra  index.html
 *
 * O apresentador publica (slide, passo) em servidores MQTT públicos (vários
 * ao mesmo tempo, para um cair sem parar a transmissão); o público assina o
 * mesmo tópico e acompanha. A mensagem fica retida, então quem entra depois
 * já cai no slide atual. Só o apresentador passa os slides: o público
 * não navega por toque, teclado nem pelas abas.
 *
 * No celular em pé, o canvas vira vertical (720px de largura) e o
 * vertical.css reorganiza cada slide em coluna.
 */
(() => {
  // O runtime da apresentação pode reavaliar scripts do <helmet>.
  if (window.__aoVivo) return;
  window.__aoVivo = true;

  const params = new URLSearchParams(location.search);
  const ROOM = 'conedu2026/rayllon/' + (params.get('sala') || 'principal');
  const T_STATE = ROOM + '/estado';    // retido: slide atual + batimento
  const T_HELLO = ROOM + '/publico';   // público avisa que está assistindo
  const IS_PRESENTER = params.has('apresentador');
  const MQTT_SRC = 'https://unpkg.com/mqtt@5.10.1/dist/mqtt.min.js';
  const BROKERS = [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://test.mosquitto.org:8081/mqtt',
    'wss://broker.hivemq.com:8884/mqtt',
  ];
  const BEAT_MS = 5000;
  const COARSE = matchMedia('(pointer: coarse)');

  let stage = null;
  const V_WIDTH = 720;
  let applying = false;      // true enquanto aplicamos estado vindo da rede
  let connected = false;     // público: recebendo o apresentador

  // ── Estilos ───────────────────────────────────────────────────────────
  const css = document.createElement('style');
  css.textContent = `
    #av-layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483600; }
    #av-pill {
      position: absolute; top: 12px; right: 12px; pointer-events: auto;
      display: flex; align-items: center; gap: 8px; padding: 7px 14px;
      font: 700 13px/1 Manrope, system-ui, sans-serif; letter-spacing: .04em;
      color: #fff; background: rgba(8,23,46,.82); border: 1px solid rgba(255,255,255,.18);
      border-radius: 999px; cursor: pointer; user-select: none; -webkit-user-select: none;
      transition: opacity .4s ease;
    }
    #av-pill i { width: 9px; height: 9px; border-radius: 50%; background: #8A97AB; }
    #av-pill[data-s="live"] i { background: #E5484D; animation: av-pulse 1.6s infinite; }
    #av-pill[data-dim] { opacity: .25; }
    @keyframes av-pulse { 50% { opacity: .35; } }
    #av-full {
      position: absolute; top: 12px; left: 12px; pointer-events: auto;
      width: 36px; height: 36px; padding: 0; display: none; place-items: center;
      color: #fff; background: rgba(8,23,46,.82); border: 1px solid rgba(255,255,255,.18);
      border-radius: 50%; cursor: pointer; -webkit-tap-highlight-color: transparent;
    }
    #av-full svg { width: 18px; height: 18px; }
    #av-full.on { display: grid; }
  `;
  document.head.appendChild(css);
  const vcss = document.createElement('link');
  vcss.rel = 'stylesheet';
  vcss.href = './vertical.css';
  document.head.appendChild(vcss);

  const layer = document.createElement('div');
  layer.id = 'av-layer';
  const pill = document.createElement('div');
  pill.id = 'av-pill';
  pill.innerHTML = '<i></i><span></span>';
  layer.appendChild(pill);

  // Botão de tela cheia (só em telas de toque; o iPhone não tem a API e fica sem)
  const ICON_ENTER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>';
  const ICON_EXIT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>';
  const root = document.documentElement;
  const fsElement = () => document.fullscreenElement || document.webkitFullscreenElement;
  const fsEnter = root.requestFullscreen || root.webkitRequestFullscreen;
  const fsExit = document.exitFullscreen || document.webkitExitFullscreen;
  const full = document.createElement('button');
  full.id = 'av-full';
  full.type = 'button';
  full.setAttribute('aria-label', 'Tela cheia');
  layer.appendChild(full);
  const renderFull = () => {
    full.classList.toggle('on', !!fsEnter && COARSE.matches);
    full.innerHTML = fsElement() ? ICON_EXIT : ICON_ENTER;
  };
  full.addEventListener('click', (e) => {
    e.stopPropagation();
    if (fsElement()) fsExit.call(document);
    else Promise.resolve(fsEnter.call(root, { navigationUI: 'hide' })).catch(() => {});
  });
  document.addEventListener('fullscreenchange', renderFull);
  document.addEventListener('webkitfullscreenchange', renderFull);
  COARSE.addEventListener && COARSE.addEventListener('change', renderFull);
  renderFull();

  const setPill = (state, text) => {
    pill.dataset.s = state;
    pill.querySelector('span').textContent = text;
  };

  // ── Estado da apresentação ────────────────────────────────────────────
  const activeSlide = () => stage && stage.querySelector('[data-deck-active]');
  const readState = () => {
    const sl = activeSlide();
    return { i: stage.index, s: sl ? parseInt(sl.dataset.stepIndex || '0', 10) : 0 };
  };

  // Passos são controlados pelo script da apresentação via teclado; simular
  // as setas reaproveita exatamente a mesma lógica (passo → próximo slide).
  const press = (dir) => {
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: dir > 0 ? 'ArrowRight' : 'ArrowLeft', bubbles: true, cancelable: true,
    }));
  };

  const applyState = ({ i, s }) => {
    if (!stage || typeof i !== 'number') return;
    applying = true;
    try {
      if (stage.index !== i) stage.goTo(i);
      const sl = activeSlide();
      if (sl && sl.hasAttribute('data-steps')) {
        const total = parseInt(sl.getAttribute('data-steps'), 10) || 1;
        const target = Math.max(0, Math.min(total - 1, s | 0));
        let cur = parseInt(sl.dataset.stepIndex || '0', 10);
        while (cur !== target) {
          press(target > cur ? 1 : -1);
          const next = parseInt(sl.dataset.stepIndex || '0', 10);
          if (next === cur) break; // segurança: nada mudou
          cur = next;
        }
      }
    } finally {
      applying = false;
    }
  };

  const locked = () => !IS_PRESENTER;

  // ── Entrada do usuário (registrado antes dos outros scripts) ──────────
  window.addEventListener('keydown', (e) => {
    if (applying || !locked()) return;
    if (/^(Arrow|Page|Home|End| |Spacebar|[0-9]|r|R)/.test(e.key)) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }, true);

  window.addEventListener('click', (e) => {
    if (!stage || applying) return;
    const path = e.composedPath();
    if (!path.includes(stage)) return;
    let link = false, dir = 0;
    for (const n of path) {
      if (n === stage) break;
      if (!n.matches) continue;
      if (n.matches('[data-step-tab]')) { if (locked()) break; link = true; break; }
      if (n.matches('a[href]')) { link = true; break; }
      if (n.matches('.next')) { dir = 1; break; }
      if (n.matches('.prev')) { dir = -1; break; }
      if (n.matches('button, input, select, textarea')) { link = true; break; }
    }
    if (link) return;
    if (!dir && !COARSE.matches && !locked()) return; // clique de mouse no slide: comportamento original
    // Botões ‹ › e toques: passam pelos passos antes de trocar de slide.
    e.preventDefault();
    e.stopImmediatePropagation();
    if (locked()) return;
    if (!dir) dir = e.clientX < window.innerWidth / 2 ? -1 : 1;
    press(dir);
  }, true);

  // ── Modo celular: canvas vertical em retrato ──────────────────────────
  let landscape = null; // tamanho original do canvas (width/height do deck)
  const layout = () => {
    if (!stage) return;
    if (!landscape) landscape = [stage.getAttribute('width'), stage.getAttribute('height')];
    const W = window.innerWidth, H = window.innerHeight;
    const vertical = H > W && W <= 900;
    document.documentElement.classList.toggle('av-vertical', vertical);
    const w = vertical ? String(V_WIDTH) : landscape[0];
    const h = vertical ? String(Math.max(1100, Math.round(V_WIDTH * H / W))) : landscape[1];
    document.documentElement.classList.toggle('av-short', vertical && Number(h) < 1400);
    if (stage.getAttribute('width') !== w) stage.setAttribute('width', w);
    if (stage.getAttribute('height') !== h) stage.setAttribute('height', h);
  };

  // ── Rede ──────────────────────────────────────────────────────────────
  const loadMqtt = () => new Promise((resolve, reject) => {
    if (window.mqtt) return resolve(window.mqtt);
    const s = document.createElement('script');
    s.src = MQTT_SRC;
    s.onload = () => resolve(window.mqtt);
    s.onerror = reject;
    document.head.appendChild(s);
  });

  // Uma conexão por servidor; cada uma se reconecta sozinha a cada 3s.
  // reset() derruba e recria todas (toque no selo).
  const openBrokers = (mqtt, onMessage, onChange) => {
    let clients = [];
    const open = () => {
      clients = BROKERS.map((url) => {
        const c = mqtt.connect(url, {
          clientId: 'av-' + Math.random().toString(36).slice(2, 12),
          reconnectPeriod: 3000, connectTimeout: 8000, keepalive: 30, clean: true,
        });
        c.on('connect', () => onChange(c, true));
        c.on('close', () => onChange(c, false));
        c.on('offline', () => onChange(c, false));
        c.on('error', () => {});
        c.on('message', (topic, buf) => {
          let msg;
          try { msg = JSON.parse(buf.toString()); } catch (e) { return; }
          onMessage(topic, msg);
        });
        return c;
      });
    };
    open();
    return {
      live: () => clients.filter((c) => c.connected),
      reset: () => { clients.forEach((c) => c.end(true)); open(); },
    };
  };

  const startPresenter = (mqtt) => {
    const viewers = new Map();  // id do público → último aviso
    let net = null;
    let dimTimer;
    const render = () => {
      const now = Date.now();
      viewers.forEach((t, id) => { if (now - t > 3 * BEAT_MS + 2000) viewers.delete(id); });
      const up = net ? net.live().length : 0;
      if (!up) {
        setPill('off', 'SEM CONEXÃO · toque p/ reconectar');
        pill.removeAttribute('data-dim');
        clearTimeout(dimTimer);
        return;
      }
      const n = viewers.size;
      const msg = `APRESENTADOR · ${n} assistindo`;
      if (pill.dataset.s === 'live' && pill.textContent === msg) return;
      setPill('live', msg);
      pill.removeAttribute('data-dim');
      clearTimeout(dimTimer);
      dimTimer = setTimeout(() => pill.setAttribute('data-dim', ''), 4000);
    };
    const publish = (clients) => {
      const st = { ...readState(), t: Date.now() };
      const body = JSON.stringify(st);
      clients.forEach((c) => c.publish(T_STATE, body, { qos: 0, retain: true }));
    };
    let last = '';
    const broadcast = () => {
      const msg = JSON.stringify(readState());
      if (msg === last) return;
      last = msg;
      publish(net.live());
    };
    let queued = false;
    const schedule = () => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => { queued = false; broadcast(); });
    };
    net = openBrokers(mqtt, (topic, m) => {
      if (topic === T_HELLO && m && m.id) { viewers.set(m.id, Date.now()); render(); }
    }, (c, up) => {
      if (up) { c.subscribe(T_HELLO); publish([c]); }
      render();
    });
    stage.addEventListener('slidechange', schedule);
    new MutationObserver(schedule).observe(stage, {
      subtree: true, attributes: true, attributeFilter: ['data-step-index'],
    });
    // Batimento: reenvia o estado para o público saber que estamos no ar.
    setInterval(() => { publish(net.live()); render(); }, BEAT_MS);
    pill.addEventListener('click', () => { setPill('off', 'RECONECTANDO…'); net.reset(); });
    render();
  };

  const renderViewerPill = () => {
    if (!connected) setPill('off', 'AGUARDANDO APRESENTADOR');
    else setPill('live', 'AO VIVO');
  };

  const startViewer = (mqtt) => {
    const me = Math.random().toString(36).slice(2, 12);
    let lastT = 0;        // carimbo do último estado aplicado
    let lastSeen = 0;     // quando recebemos algo do apresentador
    const check = () => {
      const now = connected;
      connected = Date.now() - lastSeen < 3 * BEAT_MS;
      if (now !== connected) renderViewerPill();
    };
    const net = openBrokers(mqtt, (topic, m) => {
      if (topic !== T_STATE || !m || typeof m.t !== 'number') return;
      if (m.t < lastT) return;                     // mesma mensagem por outro servidor
      // Mensagem retida antiga (apresentador fora do ar) só posiciona o slide.
      if (Date.now() - m.t < 60000) lastSeen = Date.now();
      const changed = m.t !== lastT;
      lastT = m.t;
      if (changed) applyState(m);
      check();
    }, (c, up) => {
      if (up) {
        c.subscribe(T_STATE);
        c.publish(T_HELLO, JSON.stringify({ id: me }));
      }
    });
    setInterval(() => {
      net.live().forEach((c) => c.publish(T_HELLO, JSON.stringify({ id: me })));
      check();
    }, BEAT_MS);
    pill.addEventListener('click', () => { if (!connected) net.reset(); });
    renderViewerPill();
  };

  // ── Inicialização ─────────────────────────────────────────────────────
  const boot = () => {
    stage = document.querySelector('deck-stage');
    if (!stage || !stage._canvas || typeof stage.goTo !== 'function') {
      requestAnimationFrame(boot);
      return;
    }
    document.body.appendChild(layer);
    layout();
    window.addEventListener('resize', layout);
    COARSE.addEventListener && COARSE.addEventListener('change', layout);

    loadMqtt().then((mqtt) => {
      if (IS_PRESENTER) startPresenter(mqtt);
      else startViewer(mqtt);
    }).catch(() => setPill('off', 'SEM CONEXÃO AO VIVO'));
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
