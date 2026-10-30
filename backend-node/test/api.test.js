const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const WebSocket = require('ws');
const { start } = require('../src/server');
const { createMemoryDb } = require('../src/db/memory');


function fakeAi(handler) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => handler(req, res, body ? JSON.parse(body) : null));
    });
    s.listen(0, () => resolve(s));
  });
}


function fakeDeepgram(phrases) {
  return new Promise((resolve) => {
    const wss = new WebSocket.Server({ port: 0 }, () => resolve(wss));
    wss.on('connection', (ws, req) => {
      wss.lastAuth = req.headers.authorization;
      wss.lastUrl = req.url;
      let i = 0;
      ws.on('message', (data, isBinary) => {
        if (!isBinary) return;
        const text = phrases[i++ % phrases.length];
        ws.send(JSON.stringify({ type: 'Results', is_final: true, channel: { alternatives: [{ transcript: text }] } }));
      });
    });
  });
}

async function boot(cfg = {}) {
  return start({ port: 0, db: createMemoryDb(null), cfg: Object.assign({ JWT_SECRET: 'teste', EDITOR_CODE: '' }, cfg) });
}
function client(port) {
  const base = 'http://localhost:' + port;
  let token = null;
  async function call(method, path, body) {
    const r = await fetch(base + path, {
      method, headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null };
  }
  return {
    call,
    setToken(t) { token = t; },
    get token() { return token; },
    async register(name, role, extra) {
      const r = await call('POST', '/api/auth/register', Object.assign({ name, password: 'senha123', role }, extra));
      token = r.body.token; return r;
    }
  };
}
const sample = () => ({
  id: 'rt-1', title: 'Pacote', durationSec: 60, status: 'rascunho',
  blocks: [{ id: 'b1', title: 'Abertura', durationSec: 60, text: 'Boa noite. O governo anunciou R$ 12 bilhões para obras.' }],
  anchors: [{ id: 'a1', blockId: 'b1', text: 'R$ 12 bilhões', label: 'Valor', type: 'valor', priority: 'essencial' }]
});
function wsOpen(port, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://localhost:' + port + '/ws?token=' + token);
    const inbox = [];
    ws.on('message', (d, bin) => { if (!bin) inbox.push(JSON.parse(d.toString())); });
    ws.waitFor = (type, pred, ms = 3000) => new Promise((res, rej) => {
      const t0 = Date.now();
      (function poll() {
        const i = inbox.findIndex((m) => m.type === type && (!pred || pred(m)));
        if (i >= 0) return res(inbox.splice(i, 1)[0]);
        if (Date.now() - t0 > ms) return rej(new Error('sem mensagem ' + type));
        setTimeout(poll, 20);
      })();
    });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

test('cadastro, login e senha incorreta', async () => {
  const srv = await boot();
  try {
    const c = client(srv.port);
    const r = await c.register('Ana Souza', 'Apresentador');
    assert.equal(r.status, 201);
    assert.equal(r.body.user.role, 'Apresentador');
    assert.equal((await c.call('POST', '/api/auth/register', { name: 'ana souza', password: '1234' })).status, 409);
    assert.equal((await c.call('POST', '/api/auth/login', { name: 'Ana Souza', password: 'errada' })).status, 401);
    assert.equal((await c.call('POST', '/api/auth/login', { name: 'Ninguém', password: 'x' })).status, 404);
    const ok = await c.call('POST', '/api/auth/login', { name: 'ana souza', password: 'senha123' });
    assert.equal(ok.status, 200);
    assert.ok(ok.body.token);
  } finally { await srv.stop(); }
});

test('código de editor é exigido quando configurado', async () => {
  const srv = await boot({ EDITOR_CODE: 'globo' });
  try {
    const c = client(srv.port);
    assert.equal((await c.register('Bia', 'Jornalista / Editor')).status, 403);
    assert.equal((await c.register('Bia', 'Jornalista / Editor', { editorCode: 'globo' })).status, 201);
  } finally { await srv.stop(); }
});

test('rotas exigem login', async () => {
  const srv = await boot();
  try {
    assert.equal((await client(srv.port).call('GET', '/api/scripts')).status, 401);
  } finally { await srv.stop(); }
});

test('roteiros: criar, listar, ler e excluir', async () => {
  const srv = await boot();
  try {
    const c = client(srv.port);
    await c.register('Caio', 'Produtor');
    const put = await c.call('PUT', '/api/scripts/rt-1', sample());
    assert.equal(put.status, 200);
    assert.equal(put.body.script.updatedBy, 'Caio');
    assert.equal((await c.call('GET', '/api/scripts')).body.scripts.length, 1);
    assert.equal((await c.call('GET', '/api/scripts/rt-1')).body.script.anchors[0].text, 'R$ 12 bilhões');
    assert.equal((await c.call('DELETE', '/api/scripts/rt-1')).status, 204);
    assert.equal((await c.call('GET', '/api/scripts/rt-1')).status, 404);
  } finally { await srv.stop(); }
});

test('US05 no servidor: só Jornalista / Editor aprova', async () => {
  const srv = await boot();
  try {
    const p = client(srv.port); await p.register('Apresentadora', 'Apresentador');
    const e = client(srv.port); await e.register('Editora', 'Jornalista / Editor');
    const s = Object.assign(sample(), { status: 'aprovado', approvedAt: 123 });
    assert.equal((await p.call('PUT', '/api/scripts/rt-1', s)).status, 403);
    const ok = await e.call('PUT', '/api/scripts/rt-1', s);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.script.approvedBy, 'Editora · Jornalista / Editor');
    // salvar de novo sem mudar a aprovação continua permitido para outras funções
    assert.equal((await p.call('PUT', '/api/scripts/rt-1', ok.body.script)).status, 200);
  } finally { await srv.stop(); }
});

test('histórico de sessões', async () => {
  const srv = await boot();
  try {
    const c = client(srv.port); await c.register('Davi', 'Apresentador');
    assert.equal((await c.call('POST', '/api/sessions', { id: 'ss1', scriptId: 'rt-1', startedAt: 1 })).status, 201);
    assert.equal((await c.call('GET', '/api/sessions')).body.sessions.length, 1);
  } finally { await srv.stop(); }
});

test('revisão com IA: repassa ao serviço Python', async () => {
  const ai = await fakeAi((req, res, body) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ suggestions: [{ blockId: body.blocks[0].id, original: 'Houveram', suggestion: 'Houve', category: 'Gramática', confidence: 'alta', message: 'x' }] }));
  });
  const srv = await boot({ AI_SERVICE_URL: 'http://localhost:' + ai.address().port });
  try {
    const c = client(srv.port); await c.register('Eva', 'Jornalista / Editor');
    const r = await c.call('POST', '/api/ai/review', { scriptId: 'rt-1', blocks: sample().blocks, anchors: [] });
    assert.equal(r.status, 200);
    assert.equal(r.body.suggestions[0].suggestion, 'Houve');
  } finally { await srv.stop(); ai.close(); }
});

test('revisão com IA: serviço fora do ar ou lento → 503', async () => {
  const slow = await fakeAi(() => { /* nunca responde */ });
  const srv = await boot({ AI_SERVICE_URL: 'http://localhost:' + slow.address().port, AI_TIMEOUT_MS: 200 });
  const srv2 = await boot({ AI_SERVICE_URL: 'http://localhost:1' });
  try {
    for (const s of [srv, srv2]) {
      const c = client(s.port); await c.register('Fábio', 'Jornalista / Editor');
      assert.equal((await c.call('POST', '/api/ai/review', { blocks: sample().blocks })).status, 503);
    }
  } finally { await srv.stop(); await srv2.stop(); slow.closeAllConnections(); slow.close(); }
});

test('tempo real: mudança de última hora chega ao teleprompter aberto', async () => {
  const srv = await boot();
  try {
    const c = client(srv.port); await c.register('Gabi', 'Jornalista / Editor');
    await c.call('PUT', '/api/scripts/rt-1', sample());
    const ws = await wsOpen(srv.port, c.token);
    await ws.waitFor('hello');
    ws.send(JSON.stringify({ type: 'join', scriptId: 'rt-1' }));
    await ws.waitFor('presence');
    const r = await c.call('PATCH', '/api/scripts/rt-1/blocks/b1', { text: 'Boa noite. O governo anunciou R$ 12 bilhões para obras em 15 estados.' });
    assert.equal(r.status, 200);
    const m = await ws.waitFor('script:updated');
    assert.deepEqual(m.changed, ['b1']);
    assert.equal(m.by, 'Gabi');
    assert.match(m.script.blocks[0].text, /15 estados/);
    ws.close();
  } finally { await srv.stop(); }
});

test('tempo real: WebSocket recusa token inválido', async () => {
  const srv = await boot();
  try {
    await assert.rejects(wsOpen(srv.port, 'invalido'));
  } finally { await srv.stop(); }
});

test('voz pelo navegador: texto reconhecido vira posição e âncora dita', async () => {
  const srv = await boot();
  try {
    const c = client(srv.port); await c.register('Hugo', 'Apresentador');
    await c.call('PUT', '/api/scripts/rt-1', sample());
    const ws = await wsOpen(srv.port, c.token);
    ws.send(JSON.stringify({ type: 'join', scriptId: 'rt-1' }));
    ws.send(JSON.stringify({ type: 'speech:start', engine: 'browser' }));
    ws.send(JSON.stringify({ type: 'speech:text', text: 'boa noite o governo anunciou 12 bilhões', final: true }));
    const t = await ws.waitFor('tracker', (m) => m.anchors.a1 === 'dita');
    assert.ok(t.pos >= 6);
    ws.close();
  } finally { await srv.stop(); }
});

test('voz pela Deepgram: áudio vai para a API e a transcrição volta', async () => {
  const dg = await fakeDeepgram(['boa noite o governo anunciou', 'doze bilhões para obras']);
  const srv = await boot({ DEEPGRAM_API_KEY: 'chave-secreta', DEEPGRAM_URL: 'ws://localhost:' + dg.address().port });
  try {
    const c = client(srv.port); await c.register('Iara', 'Apresentador');
    await c.call('PUT', '/api/scripts/rt-1', sample());
    const ws = await wsOpen(srv.port, c.token);
    const hello = await ws.waitFor('hello');
    assert.equal(hello.speech.deepgram, true);
    ws.send(JSON.stringify({ type: 'join', scriptId: 'rt-1' }));
    ws.send(JSON.stringify({ type: 'speech:start', engine: 'deepgram' }));
    ws.send(Buffer.from([1, 2, 3]));
    ws.send(Buffer.from([4, 5, 6]));
    const tr = await ws.waitFor('speech:transcript');
    assert.equal(tr.text, 'boa noite o governo anunciou');
    await ws.waitFor('tracker', (m) => m.anchors.a1 === 'dita');
    assert.equal(dg.lastAuth, 'Token chave-secreta', 'a chave fica no servidor');
    assert.match(dg.lastUrl, /language=pt-BR/);
    ws.close();
  } finally { await srv.stop(); dg.close(); }
});

test('voz pela Deepgram: queda inesperada avisa o cliente para acionar o fallback', async () => {
  const dg = await fakeDeepgram([]);
  const srv = await boot({ DEEPGRAM_API_KEY: 'chave-secreta', DEEPGRAM_URL: 'ws://localhost:' + dg.address().port });
  try {
    const c = client(srv.port); await c.register('Queda de voz', 'Apresentador');
    const ws = await wsOpen(srv.port, c.token);
    ws.send(JSON.stringify({ type: 'speech:start', engine: 'deepgram' }));
    await new Promise((resolve) => dg.once('connection', resolve));
    const upstream = dg.clients.values().next().value;
    upstream.terminate();
    const error = await ws.waitFor('speech:error');
    assert.match(error.message, /Deepgram caiu/);
    ws.close();
  } finally { await srv.stop(); dg.close(); }
});

test('voz pela Deepgram sem chave: avisa o navegador para usar o reconhecimento local', async () => {
  const srv = await boot({ DEEPGRAM_API_KEY: '' });
  try {
    const c = client(srv.port); await c.register('João', 'Apresentador');
    const ws = await wsOpen(srv.port, c.token);
    ws.send(JSON.stringify({ type: 'speech:start', engine: 'deepgram' }));
    await ws.waitFor('speech:error');
    ws.close();
  } finally { await srv.stop(); }
});

test('voz mantém a posição correta no tópico após edição ao vivo', async () => {
  const srv = await boot();
  try {
    const c = client(srv.port); await c.register('Edição e voz', 'Apresentador');
    const initial = Object.assign(sample(), {
      blocks: [
        { id: 'b1', title: 'Abertura', text: 'Boa noite.' },
        { id: 'b2', title: 'Detalhes', text: 'A ministra Helena Duarte afirmou que as obras começam pelo Nordeste com prioridade para a rodovia.' }
      ],
      anchors: []
    });
    const created = await c.call('PUT', '/api/scripts/rt-1', initial);
    const ws = await wsOpen(srv.port, c.token);
    ws.send(JSON.stringify({ type: 'join', scriptId: 'rt-1' }));
    await ws.waitFor('presence');
    ws.send(JSON.stringify({ type: 'speech:start', engine: 'browser' }));
    ws.send(JSON.stringify({ type: 'speech:text', text: 'a ministra helena duarte afirmou que as obras começam pelo nordeste', final: true }));
    const before = await ws.waitFor('tracker', (message) => message.blockId === 'b2');
    assert.equal(before.blockTitle, 'Detalhes');
    assert.equal(before.pos > 0, true);

    const edited = Object.assign({}, created.body.script, {
      baseUpdatedAt: created.body.script.updatedAt,
      blocks: [
        { id: 'b1', title: 'Abertura', text: 'Informação atualizada. ' + 'Mais contexto para a abertura. '.repeat(5) + 'Boa noite.' },
        { id: 'b2', title: 'Detalhes', text: 'Atualização. ' + initial.blocks[1].text }
      ]
    });
    assert.equal((await c.call('PUT', '/api/scripts/rt-1', edited)).status, 200);
    const after = await ws.waitFor('tracker', (message) => message.blockId === 'b2' && message.pos >= before.pos);
    assert.equal(after.blockTitle, 'Detalhes');
    assert.equal(after.pos > before.pos, true);
    ws.close();
  } finally { await srv.stop(); }
});

test('plano de corte: relógio e posição da rolagem', async () => {
  const srv = await boot();
  try {
    const c = client(srv.port); await c.register('Lia', 'Apresentador');
    await c.call('PUT', '/api/scripts/rt-1', Object.assign(sample(), { durationSec: 10 }));
    const ws = await wsOpen(srv.port, c.token);
    ws.send(JSON.stringify({ type: 'join', scriptId: 'rt-1' }));
    ws.send(JSON.stringify({ type: 'clock', elapsedSec: 18, wordIndex: 0 })); 
    
    const t = await ws.waitFor('tracker', (m) => m.cutPlan.tight);
    assert.deepEqual(t.cutPlan.essential, ['a1']);
    ws.send(JSON.stringify({ type: 'clock', elapsedSec: 2, wordIndex: 4 }));
    await ws.waitFor('tracker', (m) => !m.cutPlan.tight && m.pos === 4);
    ws.close();
  } finally { await srv.stop(); }
});

test('tempo real: tela espelho segue a principal e é avisada quando ela cai (Disaster Recovery)', async () => {
  const srv = await boot();
  try {
    const c = client(srv.port); await c.register('Gabi', 'Jornalista / Editor');
    await c.call('PUT', '/api/scripts/rt-1', sample());
    const principal = await wsOpen(srv.port, c.token);
    const hp = await principal.waitFor('hello');
    principal.send(JSON.stringify({ type: 'join', scriptId: 'rt-1' }));
    assert.equal((await principal.waitFor('control')).id, null, 'ninguém controla ainda');
    principal.send(JSON.stringify({ type: 'control:claim' }));
    assert.equal((await principal.waitFor('control', (m) => m.id)).id, hp.cid);

    const espelho = await wsOpen(srv.port, c.token);
    await espelho.waitFor('hello');
    espelho.send(JSON.stringify({ type: 'join', scriptId: 'rt-1' }));
    const ctl = await espelho.waitFor('control');
    assert.equal(ctl.id, hp.cid, 'a tela nova sabe quem controla');
    assert.equal(ctl.by, 'Gabi');

    principal.send(JSON.stringify({ type: 'mirror:state', pos: 12.5, running: true, wpm: 150, elapsedMs: 3000, started: true }));
    const st = await espelho.waitFor('mirror:state');
    assert.equal(st.pos, 12.5); assert.equal(st.running, true); assert.equal(st.wpm, 150);

    // espelho não pode mandar posição sem assumir
    espelho.send(JSON.stringify({ type: 'mirror:state', pos: 99 }));
    await assert.rejects(principal.waitFor('mirror:state', null, 300));

    principal.close(); // a principal cai
    assert.equal((await espelho.waitFor('control', (m) => m.id === null)).id, null);
    espelho.send(JSON.stringify({ type: 'control:claim' }));
    const novo = await espelho.waitFor('control', (m) => m.id);
    assert.ok(novo.id && novo.id !== hp.cid, 'o espelho assumiu');
    espelho.close();
  } finally { await srv.stop(); }
});


test('tempo real: mudar título, duração ou ordem dos tópicos também avisa', async () => {
  const srv = await boot();
  try {
    const c = client(srv.port); await c.register('Andreza', 'Jornalista / Editor');
    const s = sample();
    s.blocks.push({ id: 'b2', title: 'Fim', durationSec: 10, text: 'Boa noite.' });
    await c.call('PUT', '/api/scripts/rt-1', s);
    const ws = await wsOpen(srv.port, c.token);
    ws.send(JSON.stringify({ type: 'join', scriptId: 'rt-1' }));
    await ws.waitFor('presence');

    s.blocks[0].title = 'Abertura nova';                      // só o título
    await c.call('PUT', '/api/scripts/rt-1', s);
    let m = await ws.waitFor('script:updated');
    assert.deepEqual(m.changed, ['b1']);

    s.blocks[1].durationSec = 20;                             // só a duração
    await c.call('PUT', '/api/scripts/rt-1', s);
    m = await ws.waitFor('script:updated');
    assert.deepEqual(m.changed, ['b2']);

    s.blocks.reverse();                                       // só a ordem
    await c.call('PUT', '/api/scripts/rt-1', s);
    m = await ws.waitFor('script:updated');
    assert.equal(m.script.blocks[0].id, 'b2');
    ws.close();
  } finally { await srv.stop(); }
});