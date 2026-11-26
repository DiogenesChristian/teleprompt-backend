/* Ponto de entrada:  npm start  (ou npm run dev) */
'use strict';
const http = require('http');
const defaults = require('./config');
const { createDb } = require('./db');
const { createApp } = require('./app');
const { createHub } = require('./realtime');

async function start(overrides = {}) {
  const cfg = Object.assign({}, defaults, overrides.cfg || {});
  const weakJwt = typeof cfg.JWT_SECRET !== 'string' || cfg.JWT_SECRET.length < 32 || cfg.JWT_SECRET === 'troque-este-segredo';
  if (weakJwt && cfg.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET ausente ou inseguro. Configure pelo menos 32 caracteres aleatórios.');
  }
  if (!cfg.EDITOR_CODE && cfg.NODE_ENV === 'production') {
    throw new Error('EDITOR_CODE ausente. Configure um código obrigatório para cadastro de editores.');
  }
  const db = overrides.db || createDb(cfg);
  await db.connect();
  const server = http.createServer();
  const hubRef = {};
  const app = createApp({ cfg, db, hub: { scriptUpdated: (...a) => hubRef.hub.scriptUpdated(...a), isLive: (id) => hubRef.hub.isLive(id) } });
  server.on('request', app);
  hubRef.hub = createHub({ server, cfg, db, openSpeech: overrides.openSpeech });
  await new Promise((r) => server.listen(overrides.port != null ? overrides.port : cfg.PORT, r));
  const port = server.address().port;
  let stopping;
  async function shutdown() {
    const drained = new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    hubRef.hub.close();
    await drained;
    await db.close();
  }
  return {
    port, server, db, hub: hubRef.hub,
    stop() { return stopping || (stopping = shutdown()); }
  };
}

if (require.main === module) {
  let stopping = false;
  const startup = start();
  async function stop() {
    if (stopping) return;
    stopping = true;
    try {
      const running = await startup;
      await running.stop();
    } catch (error) {
      console.error('Falha ao encerrar o backend:', error.message);
      process.exitCode = 1;
    }
  }
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  startup.then(({ port, db }) => {
    console.log('Globo Flow backend em http://localhost:' + port);
    console.log('Banco: ' + db.kind + ' · Voz: ' + (defaults.DEEPGRAM_API_KEY ? 'Deepgram (' + defaults.DEEPGRAM_LANGUAGE + ')' : 'reconhecimento do navegador (sem DEEPGRAM_API_KEY)'));
    console.log('Serviço de IA: ' + defaults.AI_SERVICE_URL);
  }).catch((e) => { console.error('Não foi possível iniciar:', e.message); process.exit(1); });
}

module.exports = { start };