/* Ponto de entrada:  npm start  (ou npm run dev) */
'use strict';
const http = require('http');
const defaults = require('./config');
const { createDb } = require('./db');
const { createApp } = require('./app');
const { createHub } = require('./realtime');

async function start(overrides = {}) {
  const cfg = Object.assign({}, defaults, overrides.cfg || {});
  const db = overrides.db || createDb(cfg);
  await db.connect();
  const server = http.createServer();
  const hubRef = {};
  const app = createApp({ cfg, db, hub: { scriptUpdated: (...a) => hubRef.hub.scriptUpdated(...a) } });
  server.on('request', app);
  hubRef.hub = createHub({ server, cfg, db, openSpeech: overrides.openSpeech });
  await new Promise((r) => server.listen(overrides.port != null ? overrides.port : cfg.PORT, r));
  const port = server.address().port;
  return {
    port, server, db, hub: hubRef.hub,
    async stop() { hubRef.hub.close(); await new Promise((r) => server.close(r)); await db.close(); }
  };
}

if (require.main === module) {
  start().then(({ port, db }) => {
    console.log('Globo Flow backend em http://localhost:' + port);
    console.log('Banco: ' + db.kind + ' · Voz: ' + (defaults.DEEPGRAM_API_KEY ? 'Deepgram (' + defaults.DEEPGRAM_LANGUAGE + ')' : 'reconhecimento do navegador (sem DEEPGRAM_API_KEY)'));
    console.log('Serviço de IA: ' + defaults.AI_SERVICE_URL);
  }).catch((e) => { console.error('Não foi possível iniciar:', e.message); process.exit(1); });
}

module.exports = { start };
