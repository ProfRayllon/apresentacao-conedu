/*
 * ao-vivo.js — modo celular + sincronização ao vivo da apresentação.
 *
 * Apresentador: abra  index.html?apresentador
 * Público:      abra  index.html
 *
 * O apresentador transmite (slide, passo) via WebRTC (PeerJS, sem servidor
 * próprio). Cada aparelho do público conecta-se ao navegador do apresentador
 * e acompanha a navegação. O público pode tocar no selo "AO VIVO" para
 * navegar sozinho e tocar de novo para voltar a acompanhar.
 *
 * No celular em pé, o canvas vira vertical (720px de largura) e o
 * vertical.css reorganiza cada slide em coluna.
 */
(() => {
  // O runtime da apresentação pode reavaliar scripts do <helmet>.
  if (window.__aoVivo) return;
  window.__aoVivo = true;

  const params = new URLSearchParams(location.search);
  const ROOM = 'conedu2026-rayllon-' + (params.get('sala') || 'principal');
  const IS_PRESENTER = params.has('apresentador');
  const PEERJS_SRC = 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js';
  const COARSE = matchMedia('(pointer: coarse)');

  let stage = null;
  const V_WIDTH = 720;
  let applying = false;      // true enquanto aplicamos estado vindo da rede
  let following = true;      // público: acompanhando o apresentador
  let connected = false;     // público: conexão com o apresentador aberta
  let lastRemote = null;     // público: último estado recebido

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
    #av-pill[data-s="free"] i { background: #F5A524; }
    #av-pill[data-dim] { opacity: .25; }
    @keyframes av-pulse { 50% { opacity: .35; } }
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

  const locked = () => !IS_PRESENTER && following && connected;

  // ── Entrada do usuário (registrado antes dos outros scripts) ──────────
  window.addEventListener('keydown', (e) => {
    if (applying || !locked()) return;
    if (/^(Arrow|Page|Home|End| |[0-9]|r|R)/.test(e.key)) {
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
      if (n.matches('a[href], [data-step-tab]')) { link = true; break; }
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

  pill.addEventListener('click', (e) => {
    e.stopPropagation();
    if (IS_PRESENTER) return;
    following = !following;
    if (following && lastRemote) applyState(lastRemote);
    renderViewerPill();
  });

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
  const loadPeer = () => new Promise((resolve, reject) => {
    if (window.Peer) return resolve(window.Peer);
    const s = document.createElement('script');
    s.src = PEERJS_SRC;
    s.onload = () => resolve(window.Peer);
    s.onerror = reject;
    document.head.appendChild(s);
  });

  const startPresenter = async (Peer) => {
    const conns = new Set();
    let dimTimer;
    const render = (msg) => {
      setPill('live', msg || `APRESENTADOR · ${conns.size} conectado${conns.size === 1 ? '' : 's'}`);
      pill.removeAttribute('data-dim');
      clearTimeout(dimTimer);
      dimTimer = setTimeout(() => pill.setAttribute('data-dim', ''), 4000);
    };
    let last = '';
    const broadcast = (force) => {
      const st = readState();
      const msg = JSON.stringify(st);
      if (!force && msg === last) return;
      last = msg;
      conns.forEach((c) => { if (c.open) c.send(st); });
    };
    let queued = false;
    const schedule = () => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => { queued = false; broadcast(); });
    };
    stage.addEventListener('slidechange', schedule);
    new MutationObserver(schedule).observe(stage, {
      subtree: true, attributes: true, attributeFilter: ['data-step-index'],
    });

    const connect = () => {
      const peer = new Peer(ROOM);
      peer.on('open', () => render());
      peer.on('connection', (c) => {
        c.on('open', () => { conns.add(c); c.send(readState()); render(); });
        c.on('close', () => { conns.delete(c); render(); });
        c.on('error', () => { conns.delete(c); render(); });
      });
      peer.on('disconnected', () => { render('RECONECTANDO…'); try { peer.reconnect(); } catch (e) {} });
      peer.on('error', (err) => {
        if (err.type === 'unavailable-id') {
          render('SALA EM USO — feche outra aba de apresentador');
          setTimeout(() => { peer.destroy(); connect(); }, 5000);
        } else if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error') {
          render('SEM CONEXÃO — tentando de novo…');
          setTimeout(() => { peer.destroy(); connect(); }, 4000);
        }
      });
    };
    render('CONECTANDO…');
    connect();
  };

  const renderViewerPill = () => {
    if (!connected) setPill('off', 'AGUARDANDO APRESENTADOR');
    else if (following) setPill('live', 'AO VIVO');
    else setPill('free', 'NAVEGANDO SOZINHO · toque p/ voltar');
  };

  const startViewer = (Peer) => {
    let peer = null;
    let retry;
    const again = (ms) => {
      clearTimeout(retry);
      retry = setTimeout(join, ms);
    };
    const join = () => {
      if (!peer || peer.destroyed) {
        peer = new Peer();
        peer.on('open', join);
        peer.on('disconnected', () => { try { peer.reconnect(); } catch (e) {} });
        peer.on('error', (err) => {
          if (err.type === 'peer-unavailable') again(3000);
          else { connected = false; renderViewerPill(); peer.destroy(); again(4000); }
        });
        return;
      }
      if (!peer.open) return;
      const c = peer.connect(ROOM, { reliable: true });
      c.on('open', () => { connected = true; renderViewerPill(); });
      c.on('data', (st) => {
        lastRemote = st;
        if (following) applyState(st);
      });
      c.on('close', () => { connected = false; renderViewerPill(); again(2000); });
      c.on('error', () => { connected = false; renderViewerPill(); again(3000); });
    };
    renderViewerPill();
    join();
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

    loadPeer().then((Peer) => {
      if (IS_PRESENTER) startPresenter(Peer);
      else startViewer(Peer);
    }).catch(() => setPill('off', 'SEM CONEXÃO AO VIVO'));
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
