/* Banco em memória, salvo num arquivo JSON.
 * Usado quando MONGODB_URI está vazio: permite rodar o projeto sem instalar
 * o MongoDB (desenvolvimento, testes e apresentação). Mesma interface do mongo.js.
 */
'use strict';
const fs = require('fs');
const path = require('path');

function createMemoryDb(file) {
  const data = { users: [], scripts: [], sessions: [] };
  if (file && fs.existsSync(file)) {
    try { Object.assign(data, JSON.parse(fs.readFileSync(file, 'utf8'))); } catch (e) { /* arquivo corrompido: começa vazio */ }
  }
  let timer = null;
  function save() {
    if (!file) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(data, null, 2));
    }, 100);
  }
  const clone = (o) => (o == null ? o : JSON.parse(JSON.stringify(o)));

  return {
    kind: 'memória',
    async connect() {},
    async close() { clearTimeout(timer); },
    users: {
      async findByName(name) {
        const n = String(name).trim().toLowerCase();
        return clone(data.users.find((u) => u.name.toLowerCase() === n) || null);
      },
      async findById(id) { return clone(data.users.find((u) => u.id === id) || null); },
      async create(u) { data.users.push(clone(u)); save(); return clone(u); }
    },
    scripts: {
      async list() { return clone(data.scripts).sort((a, b) => b.updatedAt - a.updatedAt); },
      async get(id) { return clone(data.scripts.find((s) => s.id === id) || null); },
      async upsert(s) {
        const i = data.scripts.findIndex((x) => x.id === s.id);
        if (i >= 0) data.scripts[i] = clone(s); else data.scripts.push(clone(s));
        save(); return clone(s);
      },
      async remove(id) {
        const before = data.scripts.length;
        data.scripts = data.scripts.filter((s) => s.id !== id);
        save(); return data.scripts.length < before;
      }
    },
    sessions: {
      async list() { return clone(data.sessions).sort((a, b) => b.startedAt - a.startedAt); },
      async add(s) {
        if (!data.sessions.some((x) => x.id === s.id)) data.sessions.push(clone(s));
        save(); return clone(s);
      }
    }
  };
}

module.exports = { createMemoryDb };
