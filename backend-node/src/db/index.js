'use strict';
const { createMemoryDb } = require('./memory');
const { createMongoDb } = require('./mongo');

/* MONGODB_URI preenchido → MongoDB. Vazio → banco em memória salvo em arquivo. */
function createDb(cfg) {
  return cfg.MONGODB_URI ? createMongoDb(cfg.MONGODB_URI) : createMemoryDb(cfg.DATA_FILE);
}

module.exports = { createDb };
