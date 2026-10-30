/* Ponte com a Deepgram (https://deepgram.com), API pública de reconhecimento
 * de fala em tempo real com suporte a português do Brasil.
 *
 * O navegador grava o microfone e manda o áudio para o NOSSO backend; o backend
 * repassa para a Deepgram com a chave secreta (que nunca vai para o navegador)
 * e devolve o texto reconhecido. Documentação da API:
 * https://developers.deepgram.com/docs/live-streaming-audio
 */
'use strict';
const WebSocket = require('ws');

function openDeepgram(cfg, { onText, onError, onClose }) {
  const params = new URLSearchParams({
    model: cfg.DEEPGRAM_MODEL,
    language: cfg.DEEPGRAM_LANGUAGE,
    interim_results: 'true',   // resultados parciais enquanto a pessoa fala
    smart_format: 'true',      // números e datas formatados ("12 bilhões")
    punctuate: 'true',
    endpointing: '300'         // fecha a frase após 300 ms de silêncio
  });
  const ws = new WebSocket(cfg.DEEPGRAM_URL + '?' + params.toString(), {
    headers: { Authorization: 'Token ' + cfg.DEEPGRAM_API_KEY }
  });
  const queue = [];
  let closed = false, closeRequested = false, lastAudio = Date.now();

  ws.on('open', () => { while (queue.length) ws.send(queue.shift()); });
  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
    if (msg.type !== 'Results') return;
    const alt = msg.channel && msg.channel.alternatives && msg.channel.alternatives[0];
    if (alt && alt.transcript) onText(alt.transcript, !!msg.is_final);
  });
  ws.on('unexpected-response', (req, res) => {
    const reason = res.statusCode === 401 ? 'Chave da Deepgram inválida.' : 'Deepgram respondeu HTTP ' + res.statusCode + '.';
    onError(new Error(reason));
  });
  ws.on('error', (err) => { if (!closed) onError(err); });
  ws.on('close', (code, reason) => {
    closed = true;
    clearInterval(keep);
    if (onClose) onClose(!closeRequested, code, reason.toString());
  });

  
  const keep = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN && Date.now() - lastAudio > 5000) ws.send(JSON.stringify({ type: 'KeepAlive' }));
  }, 4000);

  return {
    send(chunk) {
      lastAudio = Date.now();
      if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
      else if (ws.readyState === WebSocket.CONNECTING) queue.push(chunk);
    },
    close() {
      if (closed) return;
      closeRequested = true;
      closed = true; clearInterval(keep);
      try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'CloseStream' })); } catch (e) { /* noop */ }
      setTimeout(() => { try { ws.close(); } catch (e) { /* noop */ } }, 300);
    }
  };
}

module.exports = { openDeepgram };
