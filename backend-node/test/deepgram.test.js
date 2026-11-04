const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { WebSocketServer } = require('ws');
const { openDeepgram } = require('../src/speech/deepgram');

test('Deepgram revisa parciais e ignora final duplicado por intervalo de áudio', async () => {
  const server = new WebSocketServer({ port: 0 });
  await once(server, 'listening');
  const received = [];
  const errors = [];
  let finish;
  const done = new Promise((resolve) => { finish = resolve; });
  const connected = once(server, 'connection');
  const session = openDeepgram({ DEEPGRAM_URL: 'ws://localhost:' + server.address().port, DEEPGRAM_API_KEY: 'test', DEEPGRAM_MODEL: 'nova-3', DEEPGRAM_LANGUAGE: 'pt-BR' }, {
    onText: (text, final) => { received.push([text, final]); if (text === 'próximo trecho') finish(); },
    onError: (err) => { errors.push(err); finish(); }
  });
  try {
    const [ws] = await connected;
    const send = (text, final, start, duration) => ws.send(JSON.stringify({ type: 'Results', start, duration, is_final: final, channel: { alternatives: [{ transcript: text }] } }));
    send('a ministra', false, 0, 1);
    send('a ministra Helena', false, 0, 2);
    send('a ministra Helena', true, 0, 2);
    send('a ministra Helena', true, 0, 2);
    send('a ministra', false, 0, 1);
    send('próximo trecho', true, 2, 1);
    await done;
    assert.deepEqual(errors, []);
    assert.deepEqual(received, [['a ministra', false], ['a ministra Helena', false], ['a ministra Helena', true], ['próximo trecho', true]]);
  } finally {
    session.close();
    server.clients.forEach((ws) => ws.terminate());
    await new Promise((resolve) => server.close(resolve));
  }
});
