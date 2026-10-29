/* Autenticação com senha (bcrypt) e token JWT.
 * Resolve a limitação do relatório: agora a regra "só Jornalista / Editor aprova"
 * é verificada no servidor, e não só na interface.
 */
'use strict';
const jwt = require('jsonwebtoken');

// A função "Operador de teleprompter" foi retirada (decisão da equipe em 29/10/2026):
// a voz rola o texto e a tela reserva recebe a posição sozinha.
const ROLES = ['Apresentador', 'Jornalista / Editor', 'Produtor'];
const EDITOR = 'Jornalista / Editor';

/* Função válida. Contas antigas de Operador de teleprompter entram como Apresentador. */
function normalizeRole(role) { return ROLES.includes(role) ? role : 'Apresentador'; }

function sign(user, secret) {
  return jwt.sign({ sub: user.id, name: user.name, role: normalizeRole(user.role) }, secret, { expiresIn: '12h' });
}
function verify(token, secret) {
  try {
    const u = jwt.verify(token, secret);
    u.role = normalizeRole(u.role); // tokens emitidos antes da mudança
    return u;
  } catch (e) { return null; }
}

/* Middleware: exige Authorization: Bearer <token>. */
function requireAuth(secret) {
  return (req, res, next) => {
    const h = req.headers.authorization || '';
    const user = verify(h.replace(/^Bearer\s+/i, ''), secret);
    if (!user) return res.status(401).json({ error: 'Sessão expirada ou inválida. Entre novamente.' });
    req.user = user;
    next();
  };
}

module.exports = { ROLES, EDITOR, normalizeRole, sign, verify, requireAuth };