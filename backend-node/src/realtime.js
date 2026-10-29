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
 *
 *  Servidor → navegador
 *    {type:'hello', speech:{deepgram}}
 *    {type:'script:updated', script, by, changed} mudança de última hora (destaque azul)
 *    {type:'speech:transcript', text, final}
 *    {type:'speech:error', message}              o navegador volta ao reconhecimento local
 *    {type:'tracker', ...}                       posição, tópico (block), leitura em andamento (reading),
 *                                                âncoras, improviso, ponte, plano de corte
 *    {type:'presence', count}
 */
'use strict';
const { WebSocketServer } = require('ws');
const { verify } = require('./auth');
const { Tracker } = require('./speech/tracker');
const { openDeepgram } = require('./speech/deepgram');

function createHub({ server, cfg, db, openSpeech }) {
  const wss = new WebSocketServer({ noServer: true });
  const rooms = new Map(); // scriptId -> Set<ws>
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
  function leave(ws) {
    if (!ws.scriptId) return;
    const set = rooms.get(ws.scriptId);
    if (set) { set.delete(ws); if (!set.size) rooms.delete(ws.scriptId); else presence(ws.scriptId); }
    ws.scriptId = null;
  }
  function stopSpeech(ws) { if (ws.speech) { ws.speech.close(); ws.speech = null; } }

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
    send(ws, { type: 'hello', user: { name: ws.user.name, role: ws.user.role }, speech: { deepgram: !!cfg.DEEPGRAM_API_KEY } });

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
            break;
          }
          case 'speech:start': {
            stopSpeech(ws);
            if (msg.engine === 'deepgram') {
              if (!cfg.DEEPGRAM_API_KEY) { send(ws, { type: 'speech:error', message: 'Deepgram não configurada no servidor.' }); break; }
              ws.speech = speechFactory(cfg, {
                onText: (t, f) => onText(ws, t, f),
                onError: (e) => { send(ws, { type: 'speech:error', message: e.message || 'Falha no reconhecimento de fala.' }); stopSpeech(ws); },
                onClose: () => {}
              });
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
            if (ws.tracker) {
              ws.tracker.setClock(msg.elapsedSec);
              if (msg.wordIndex != null) ws.tracker.setPosition(msg.wordIndex); // sem voz: posição pela rolagem
              emitTracker(ws, ws.tracker.snapshot());
            }
            break;
          case 'anchor':
            if (ws.tracker) { ws.tracker.setAnchor(String(msg.id), msg.state); emitTracker(ws, ws.tracker.snapshot()); }
            break;
          case 'position':
            if (ws.tracker) { ws.tracker.setPosition(msg.wordIndex); emitTracker(ws, ws.tracker.snapshot()); }
            break;
          default:
        }
      } catch (e) {
        send(ws, { type: 'error', message: 'Mensagem inválida.' });
      }
    }
    ws.on('close', () => { stopSpeech(ws); leave(ws); });
  });

  return {
    /* Chamado pela API quando um roteiro é salvo: avisa todos os teleprompters abertos. */
    scriptUpdated(script, info) {
      const set = rooms.get(script.id); if (!set) return;
      set.forEach((c) => {
        if (c.tracker) c.tracker.load(script);
        send(c, { type: 'script:updated', script, by: info.by, changed: info.changed || [] });
      });
    },
    roomSize(id) { return rooms.has(id) ? rooms.get(id).size : 0; },
    close() { wss.clients.forEach((c) => c.terminate()); wss.close(); }
  };
}

module.exports = { createHub };
