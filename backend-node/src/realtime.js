/* Globo Flow — tempo real (WebSocket em /ws?token=...).
 *
 * Cada teleprompter aberto entra na "sala" do seu roteiro. Pela mesma conexão:
 *
 *  Navegador → servidor
 *    {type:'join', scriptId}                     entra na sala do roteiro
 *    {type:'speech:start', engine}               começa a ouvir ('deepgram' ou 'browser')
 *    <áudio binário>                             trechos do microfone (engine deepgram)
 *    {type:'speech:text', text, final}           texto reconhecido pelo navegador (engine browser)
 *    {type:'speech:stop'}
 *    {type:'clock', elapsedSec, wordIndex}       tempo decorrido e, sem voz, posição da rolagem (plano de corte)
 *    {type:'anchor', id, state}                  marcação manual de âncora
 *    {type:'position', wordIndex}                salto manual (bloco anterior/próximo)
 *    {type:'control:claim'} / {type:'control:release'}   esta tela passa a controlar / deixa de controlar
 *    {type:'mirror:state', pos, running, wpm, elapsedMs, started, startedAt}
 *                                                posição da tela que controla (repassada às telas espelho)
 *
 *  Servidor → navegador
 *    {type:'hello', speech:{deepgram}}
 *    {type:'script:updated', script, by, changed} mudança de última hora (destaque azul)
 *    {type:'speech:transcript', text, final}
 *    {type:'speech:error', message}              o navegador volta ao reconhecimento local
 *    {type:'tracker', ...}                       posição, tópico (block), leitura em andamento (reading),
 *                                                âncoras, improviso, ponte, plano de corte
 *    {type:'presence', count}
 *    {type:'control', id, by}                    quem controla a leitura (espelho); id null = ninguém (a principal caiu)
 *    {type:'mirror:state', ..., by}              posição da tela que controla, para as telas espelho
 *    {type:'scroll', wordIndex, elapsedSec, anchors, by, source, at, jump}
 *                                                posição de outra tela que está apresentando
 *    {type:'room:state', ..., live}              ao entrar: última posição conhecida da sala
 *    {type:'scroll:lost', by, source, wordIndex, elapsedSec}
 *                                                a tela que apresentava caiu (Disaster Recovery)
 *
 * Retransmissão da posição (Disaster Recovery): cada tela que está apresentando
 * (manda {type:'clock'}) tem a posição repassada às outras telas do mesmo roteiro.
 * Se ela cair, a tela reserva já sabe onde o texto estava, o tempo e as âncoras.
 * Telas que só acompanham (não mandam 'clock') não mexem na posição das outras.
 */
'use strict';
const { WebSocketServer } = require('ws');
const { verify } = require('./auth');
const { Tracker } = require('./speech/tracker');
const { openDeepgram } = require('./speech/deepgram');

function createHub({ server, cfg, db, openSpeech }) {
  const wss = new WebSocketServer({ noServer: true });
  const rooms = new Map(); // scriptId -> Set<ws>
  const controllers = new Map(); // scriptId -> ws que controla a leitura (telas espelho seguem esta)
  const roomState = new Map(); // scriptId -> última posição, tempo e âncoras de quem apresentava
  const LIVE_WINDOW_MS = 15000;     // tela sem mandar 'clock' há 15 s não está mais apresentando
  const STATE_TTL_MS = 30 * 60000;  // por quanto tempo a última posição fica guardada
  let seq = 0;
  const speechFactory = openSpeech || openDeepgram;

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/ws') return socket.destroy();
    const user = verify(url.searchParams.get('token') || '', cfg.JWT_SECRET);
    if (!user) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return socket.destroy(); }
    wss.handleUpgrade(req, socket, head, (ws) => { ws.user = user; wss.emit('connection', ws); });
  });

  function send(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }
  function presence(id) {
    const set = rooms.get(id); if (!set) return;
    set.forEach((c) => send(c, { type: 'presence', count: set.size }));
  }
  /* ---------- espelho: quem controla a leitura numa sala ---------- */
  function controlMsg(id) {
    const c = controllers.get(id);
    return { type: 'control', id: c ? c.id : null, by: c ? c.user.name : null };
  }
  function broadcastControl(id) {
    const set = rooms.get(id); if (!set) return;
    const msg = controlMsg(id);
    set.forEach((c) => send(c, msg));
  }
  function leave(ws) {
    if (!ws.scriptId) return;
    if (controllers.get(ws.scriptId) === ws) { controllers.delete(ws.scriptId); broadcastControl(ws.scriptId); } // a principal caiu
    const set = rooms.get(ws.scriptId);
    if (set) { set.delete(ws); if (!set.size) rooms.delete(ws.scriptId); else presence(ws.scriptId); }
    ws.scriptId = null;
  }
  function stopSpeech(ws) { if (ws.speech) { ws.speech.close(); ws.speech = null; } }

  /* ---------- retransmissão da posição (Disaster Recovery) ---------- */
  function presenting(ws) { return !!ws.clockAt && Date.now() - ws.clockAt < LIVE_WINDOW_MS; }
  function isLive(id) {
    const set = rooms.get(id);
    return !!set && [...set].some(presenting);
  }
  function stateOf(id) {
    const st = roomState.get(id);
    if (st && Date.now() - st.at > STATE_TTL_MS) { roomState.delete(id); return null; }
    return st || null;
  }
  /* Guarda a posição de quem apresenta e repassa às outras telas da sala. */
  function relay(ws, info) {
    const id = ws.scriptId; if (!id) return;
    const prev = stateOf(id) || {};
    const pos = info.wordIndex != null ? info.wordIndex | 0 : ws.tracker ? ws.tracker.pos : prev.wordIndex;
    const st = {
      wordIndex: pos != null ? pos : 0,
      elapsedSec: info.elapsedSec != null ? Math.max(0, +info.elapsedSec || 0) : prev.elapsedSec || 0,
      anchors: ws.tracker ? Object.assign({}, prev.anchors, ws.tracker.states) : prev.anchors || {},
      by: ws.user.name, source: ws.id, at: Date.now(), jump: !!info.jump
    };
    roomState.set(id, st);
    (rooms.get(id) || []).forEach((c) => { if (c !== ws) send(c, Object.assign({ type: 'scroll' }, st)); });
  }

  function emitTracker(ws, snap) {
    const prev = ws.lastSnap;
    ws.lastSnap = snap;
    // evita mensagens repetidas: só envia se algo mudou
    const key = JSON.stringify([snap.pos, snap.block, snap.reading, snap.anchors, snap.behind, snap.offScript, snap.bridge && snap.bridge.text, snap.cutPlan, snap.wpm]);
    if (prev && prev.key === key) return;
    snap.key = key;
    send(ws, Object.assign({ type: 'tracker' }, snap, { key: undefined }));
  }
  function onText(ws, text, final) {
    send(ws, { type: 'speech:transcript', text, final });
    if (ws.tracker) emitTracker(ws, ws.tracker.push(text, final, Date.now()));
  }

  wss.on('connection', (ws) => {
    ws.id = 'tela-' + (++seq);
    send(ws, { type: 'hello', cid: ws.id, user: { name: ws.user.name, role: ws.user.role }, speech: { deepgram: !!cfg.DEEPGRAM_API_KEY } });

    // As mensagens são tratadas em ordem (o "join" consulta o banco antes de o texto chegar ao rastreador).
    let chain = Promise.resolve();
    ws.on('message', (raw, isBinary) => {
      chain = chain.then(() => (isBinary ? ws.speech && ws.speech.send(raw) : handle(raw)));
    });
    async function handle(raw) {
      let msg; try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
      try {
        switch (msg.type) {
          case 'join': {
            leave(ws);
            const script = await db.scripts.get(String(msg.scriptId || ''));
            ws.scriptId = String(msg.scriptId || '');
            if (!rooms.has(ws.scriptId)) rooms.set(ws.scriptId, new Set());
            rooms.get(ws.scriptId).add(ws);
            ws.tracker = new Tracker(script || msg.script || { blocks: [], anchors: [] });
            presence(ws.scriptId);
            // tela que chega (ex.: reserva): recebe onde o texto estava e já acompanha a partir dali
            const st = stateOf(ws.scriptId);
            if (st) {
              ws.tracker.setPosition(st.wordIndex);
              Object.keys(st.anchors || {}).forEach((k) => ws.tracker.setAnchor(k, st.anchors[k]));
              send(ws, Object.assign({ type: 'room:state' }, st, { live: isLive(ws.scriptId) }));
            }
            send(ws, controlMsg(ws.scriptId)); // espelho: quem já está controlando esta leitura
            break;
          }
          case 'control:claim':
            if (!ws.scriptId) break;
            controllers.set(ws.scriptId, ws);
            broadcastControl(ws.scriptId);
            break;
          case 'control:release':
            if (ws.scriptId && controllers.get(ws.scriptId) === ws) { controllers.delete(ws.scriptId); broadcastControl(ws.scriptId); }
            break;
          case 'mirror:state': {
            // só a tela que controla manda a posição; vai para as outras telas da sala
            if (!ws.scriptId || controllers.get(ws.scriptId) !== ws) break;
            const set = rooms.get(ws.scriptId); if (!set) break;
            const out = {
              type: 'mirror:state', by: ws.user.name,
              pos: +msg.pos || 0, running: !!msg.running, wpm: +msg.wpm || 0,
              elapsedMs: +msg.elapsedMs || 0, started: !!msg.started, startedAt: msg.startedAt || null
            };
            set.forEach((c) => { if (c !== ws) send(c, out); });
            break;
          }
          case 'speech:start': {
            stopSpeech(ws);
            if (msg.engine === 'deepgram') {
              if (!cfg.DEEPGRAM_API_KEY) { send(ws, { type: 'speech:error', message: 'Deepgram não configurada no servidor.' }); break; }
              let session = null;
              const fail = (message) => {
                if (ws.speech !== session) return; // sessão antiga, já substituída
                send(ws, { type: 'speech:error', message });
                stopSpeech(ws);
              };
              session = speechFactory(cfg, {
                onText: (t, f) => { if (ws.speech === session) onText(ws, t, f); },
                onError: (e) => fail(e.message || 'Falha no reconhecimento de fala.'),
                // a Deepgram fechou sem pedirmos: o navegador passa para o reconhecimento local
                onClose: (unexpected) => { if (unexpected) fail('A conexão com a Deepgram caiu.'); }
              }, { script: ws.tracker && ws.tracker.script });
              ws.speech = session;
            }
            break;
          }
          case 'speech:text':
            onText(ws, String(msg.text || ''), !!msg.final);
            break;
          case 'speech:stop':
            stopSpeech(ws);
            break;
          case 'clock':
            ws.clockAt = Date.now(); // esta tela está apresentando
            if (ws.tracker) {
              ws.tracker.setClock(msg.elapsedSec);
              if (msg.wordIndex != null) ws.tracker.setPosition(msg.wordIndex); // sem voz: posição pela rolagem
              emitTracker(ws, ws.tracker.snapshot());
            }
            relay(ws, { wordIndex: msg.wordIndex, elapsedSec: msg.elapsedSec }); // com voz, vai a posição do rastreador
            break;
          case 'anchor':
            if (ws.tracker) { ws.tracker.setAnchor(String(msg.id), msg.state); emitTracker(ws, ws.tracker.snapshot()); }
            if (presenting(ws)) relay(ws, {});
            break;
          case 'position':
            if (ws.tracker) { ws.tracker.setPosition(msg.wordIndex); emitTracker(ws, ws.tracker.snapshot()); }
            if (presenting(ws)) relay(ws, { wordIndex: msg.wordIndex, jump: true }); // salto de bloco: as outras telas pulam junto
            break;
          default:
        }
      } catch (e) {
        send(ws, { type: 'error', message: 'Mensagem inválida.' });
      }
    }
    ws.on('close', () => {
      stopSpeech(ws);
      // a tela que apresentava caiu: as outras ficam sabendo onde o texto parou
      if (ws.scriptId && presenting(ws)) {
        const st = stateOf(ws.scriptId);
        (rooms.get(ws.scriptId) || []).forEach((c) => {
          if (c !== ws) send(c, { type: 'scroll:lost', by: ws.user.name, source: ws.id, wordIndex: st ? st.wordIndex : 0, elapsedSec: st ? st.elapsedSec : 0 });
        });
      }
      leave(ws);
    });
  });

  return {
    /* Chamado pela API quando um roteiro é salvo: avisa todos os teleprompters abertos. */
    scriptUpdated(script, info) {
      const set = rooms.get(script.id); if (!set) return;
      set.forEach((c) => {
        if (c.tracker) c.tracker.load(script); // a posição da voz é levada para a mesma palavra no texto novo
        send(c, { type: 'script:updated', script, by: info.by, changed: info.changed || [] });
        if (c.tracker) emitTracker(c, c.tracker.snapshot());
      });
    },
    roomSize(id) { return rooms.has(id) ? rooms.get(id).size : 0; },
    /* O roteiro está no ar: alguma tela aberta nele está apresentando. */
    isLive,
    close() { wss.clients.forEach((c) => c.terminate()); wss.close(); }
  };
}

module.exports = { createHub };