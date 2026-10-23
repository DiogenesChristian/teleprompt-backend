/* Autenticação com senha (bcrypt) e token JWT.
 * Resolve a limitação do relatório: agora a regra "só Jornalista / Editor aprova"
 * é verificada no servidor, e não só na interface.
 */
'use strict';
const jwt = require('jsonwebtoken');

const ROLES = ['Apresentador', 'Jornalista / Editor', 'Operador de teleprompter', 'Produtor'];
const EDITOR = 'Jornalista / Editor';

function sign(user, secret) {
  return jwt.sign({ sub: user.id, name: user.name, role: user.role }, secret, { expiresIn: '12h' });
}
function verify(token, secret) {
  try { return jwt.verify(token, secret); } catch (e) { return null; }
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

module.exports = { ROLES, EDITOR, sign, verify, requireAuth };
