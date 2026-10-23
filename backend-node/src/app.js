/* Globo Flow — API REST (Express).
 *
 *   /api/auth      cadastro, login e usuário atual
 *   /api/scripts   roteiros (lista, leitura, gravação, exclusão, troca de uma linha)
 *   /api/sessions  histórico de apresentações
 *   /api/ai/review revisão do roteiro → serviço de IA em Python
 *   /api/speech    situação do reconhecimento de fala (Deepgram)
 *
 * O tempo real (teleprompter, voz e mudanças de última hora) fica em realtime.js.
 */
'use strict';
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { ROLES, EDITOR, sign, requireAuth } = require('./auth');

const uid = (p) => p + '-' + crypto.randomBytes(5).toString('hex');
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function createApp({ cfg, db, hub }) {
  const app = express();
  const origins = cfg.CORS_ORIGIN === '*' ? true : cfg.CORS_ORIGIN.split(',').map((s) => s.trim());
  app.use(cors({ origin: origins }));
  app.use(express.json({ limit: '2mb' }));
  const auth = requireAuth(cfg.JWT_SECRET);

  app.get('/api/health', (req, res) => res.json({ ok: true, db: db.kind, speech: cfg.DEEPGRAM_API_KEY ? 'deepgram' : 'navegador' }));

  /* ---------------- autenticação ---------------- */
  app.post('/api/auth/register', wrap(async (req, res) => {
    const { name, password, role, editorCode } = req.body || {};
    const n = String(name || '').trim();
    if (n.length < 2) return res.status(400).json({ error: 'Informe seu nome.' });
    if (String(password || '').length < 4) return res.status(400).json({ error: 'A senha precisa ter pelo menos 4 caracteres.' });
    const r = ROLES.includes(role) ? role : 'Apresentador';
    if (r === EDITOR && cfg.EDITOR_CODE && editorCode !== cfg.EDITOR_CODE) {
      return res.status(403).json({ error: 'Código de editor inválido. Peça o código à coordenação.' });
    }
    if (await db.users.findByName(n)) return res.status(409).json({ error: 'Já existe um usuário com esse nome.' });
    const user = { id: uid('u'), name: n, role: r, passwordHash: await bcrypt.hash(String(password), 10), createdAt: Date.now() };
    await db.users.create(user);
    res.status(201).json({ token: sign(user, cfg.JWT_SECRET), user: { id: user.id, name: user.name, role: user.role } });
  }));

  app.post('/api/auth/login', wrap(async (req, res) => {
    const { name, password } = req.body || {};
    const user = await db.users.findByName(String(name || ''));
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });
    if (!(await bcrypt.compare(String(password || ''), user.passwordHash))) return res.status(401).json({ error: 'Senha incorreta.' });
    res.json({ token: sign(user, cfg.JWT_SECRET), user: { id: user.id, name: user.name, role: user.role } });
  }));

  app.get('/api/auth/me', auth, (req, res) => res.json({ user: { id: req.user.sub, name: req.user.name, role: req.user.role } }));

  /* ---------------- roteiros ---------------- */
  app.get('/api/scripts', auth, wrap(async (req, res) => res.json({ scripts: await db.scripts.list() })));

  app.get('/api/scripts/:id', auth, wrap(async (req, res) => {
    const s = await db.scripts.get(req.params.id);
    if (!s) return res.status(404).json({ error: 'Roteiro não encontrado.' });
    res.json({ script: s });
  }));

  app.put('/api/scripts/:id', auth, wrap(async (req, res) => {
    const body = req.body || {};
    if (!Array.isArray(body.blocks)) return res.status(400).json({ error: 'Roteiro sem blocos.' });
    const old = await db.scripts.get(req.params.id);
    const approving = body.status === 'aprovado' && (!old || old.status !== 'aprovado' || old.approvedAt !== body.approvedAt);
    if (approving && req.user.role !== EDITOR) {
      return res.status(403).json({ error: 'Só o perfil Jornalista / Editor pode aprovar o roteiro.' });
    }
    const script = Object.assign({}, body, {
      id: req.params.id,
      anchors: Array.isArray(body.anchors) ? body.anchors : [],
      revisions: Array.isArray(body.revisions) ? body.revisions.slice(0, 200) : [],
      updatedAt: Date.now(),
      updatedBy: req.user.name
    });
    if (approving) { script.approvedBy = req.user.name + ' · ' + req.user.role; script.approvedAt = body.approvedAt || Date.now(); }
    await db.scripts.upsert(script);
    const changed = changedBlocks(old, script);
    if (old && (changed.length || old.title !== script.title || (old.anchors || []).length !== script.anchors.length)) {
      hub.scriptUpdated(script, { by: req.user.name, changed });
    }
    res.json({ script });
  }));

  /* Modo "Jornalismo ao vivo": o editor remoto troca o texto de um bloco. */
  app.patch('/api/scripts/:id/blocks/:blockId', auth, wrap(async (req, res) => {
    const s = await db.scripts.get(req.params.id);
    if (!s) return res.status(404).json({ error: 'Roteiro não encontrado.' });
    const b = s.blocks.find((x) => x.id === req.params.blockId);
    if (!b) return res.status(404).json({ error: 'Bloco não encontrado.' });
    if (typeof req.body.text !== 'string') return res.status(400).json({ error: 'Envie o novo texto.' });
    const before = b.text;
    b.text = req.body.text;
    s.updatedAt = Date.now(); s.updatedBy = req.user.name;
    s.revisions = [{ id: uid('rv'), at: s.updatedAt, by: req.user.name, type: 'ao-vivo', blockId: b.id, before, after: b.text }].concat(s.revisions || []).slice(0, 200);
    await db.scripts.upsert(s);
    hub.scriptUpdated(s, { by: req.user.name, changed: [b.id] });
    res.json({ script: s });
  }));

  app.delete('/api/scripts/:id', auth, wrap(async (req, res) => {
    await db.scripts.remove(req.params.id);
    res.status(204).end();
  }));

  /* ---------------- histórico ---------------- */
  app.get('/api/sessions', auth, wrap(async (req, res) => res.json({ sessions: await db.sessions.list() })));
  app.post('/api/sessions', auth, wrap(async (req, res) => {
    const s = req.body || {};
    if (!s.id || !s.scriptId) return res.status(400).json({ error: 'Sessão incompleta.' });
    res.status(201).json({ session: await db.sessions.add(s) });
  }));

  /* ---------------- revisão com IA ---------------- */
  // Contrato do README do frontend. O backend só repassa: quem decide é o editor (US05).
  app.post('/api/ai/review', auth, wrap(async (req, res) => {
    const { scriptId, blocks, anchors } = req.body || {};
    if (!Array.isArray(blocks)) return res.status(400).json({ error: 'Envie os blocos do roteiro.' });
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), cfg.AI_TIMEOUT_MS);
    try {
      const r = await fetch(cfg.AI_SERVICE_URL + '/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scriptId, blocks, anchors: anchors || [] }),
        signal: ctrl.signal
      });
      if (!r.ok) return res.status(503).json({ error: 'Serviço de IA indisponível.' });
      const data = await r.json();
      res.json({ suggestions: Array.isArray(data.suggestions) ? data.suggestions : [] });
    } catch (e) {
      res.status(503).json({ error: 'Serviço de IA indisponível.' });
    } finally { clearTimeout(t); }
  }));

  /* ---------------- voz ---------------- */
  app.get('/api/speech/status', (req, res) => res.json({
    provider: cfg.DEEPGRAM_API_KEY ? 'deepgram' : 'navegador',
    deepgram: !!cfg.DEEPGRAM_API_KEY,
    language: cfg.DEEPGRAM_LANGUAGE
  }));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Rota não encontrada.' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor.' });
  });
  return app;
}

function changedBlocks(old, now) {
  if (!old) return [];
  return now.blocks.filter((b) => {
    const o = (old.blocks || []).find((x) => x.id === b.id);
    return !o || o.text !== b.text;
  }).map((b) => b.id);
}

module.exports = { createApp };
