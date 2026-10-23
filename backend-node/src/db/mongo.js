/* MongoDB (documentação, seção de arquitetura). Mesma interface do memory.js.
 * Os roteiros são guardados no mesmo formato que o frontend usa
 * (blocos, âncoras e revisões dentro do documento).
 */
'use strict';
const mongoose = require('mongoose');

const opts = { versionKey: false, strict: false, minimize: false };

const User = mongoose.model('User', new mongoose.Schema({
  id: { type: String, unique: true, index: true },
  name: { type: String, required: true },
  nameKey: { type: String, unique: true, index: true },
  role: String,
  passwordHash: String,
  createdAt: Number
}, opts));

const Script = mongoose.model('Script', new mongoose.Schema({
  id: { type: String, unique: true, index: true },
  title: String,
  program: String,
  presenter: String,
  mode: { type: String, default: 'jornalismo' },
  status: { type: String, default: 'rascunho' },
  approvedBy: String,
  approvedAt: Number,
  scheduledAt: Number,
  durationSec: Number,
  updatedAt: { type: Number, index: true },
  updatedBy: String,
  blocks: Array,
  anchors: Array,
  revisions: Array
}, opts));

const Session = mongoose.model('Session', new mongoose.Schema({
  id: { type: String, unique: true, index: true },
  scriptId: { type: String, index: true },
  startedAt: { type: Number, index: true }
}, opts));

const strip = (doc) => {
  if (!doc) return null;
  const o = doc.toObject ? doc.toObject() : doc;
  delete o._id; delete o.nameKey;
  return o;
};

function createMongoDb(uri) {
  return {
    kind: 'MongoDB',
    async connect() { await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 }); },
    async close() { await mongoose.disconnect(); },
    users: {
      async findByName(name) { return strip(await User.findOne({ nameKey: String(name).trim().toLowerCase() }).lean()); },
      async findById(id) { return strip(await User.findOne({ id }).lean()); },
      async create(u) { await User.create(Object.assign({ nameKey: u.name.trim().toLowerCase() }, u)); return u; }
    },
    scripts: {
      async list() { return (await Script.find().sort({ updatedAt: -1 }).lean()).map(strip); },
      async get(id) { return strip(await Script.findOne({ id }).lean()); },
      async upsert(s) { await Script.replaceOne({ id: s.id }, s, { upsert: true }); return s; },
      async remove(id) { return (await Script.deleteOne({ id })).deletedCount > 0; }
    },
    sessions: {
      async list() { return (await Session.find().sort({ startedAt: -1 }).lean()).map(strip); },
      async add(s) { await Session.updateOne({ id: s.id }, { $setOnInsert: s }, { upsert: true }); return s; }
    }
  };
}

module.exports = { createMongoDb };
