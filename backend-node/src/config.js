/* Configuração lida do arquivo .env (veja .env.example). */
'use strict';
require('dotenv').config({ quiet: true });

const env = process.env;

module.exports = {
  PORT: +(env.PORT || 4000),
  // MongoDB. Vazio = banco em memória salvo em arquivo (bom para desenvolvimento e apresentação).
  MONGODB_URI: env.MONGODB_URI || '',
  DATA_FILE: env.DATA_FILE || 'data/dev-db.json',
  JWT_SECRET: env.JWT_SECRET || 'troque-este-segredo',
  // Código exigido para criar conta de Jornalista / Editor (quem aprova roteiros). Vazio = sem código.
  EDITOR_CODE: env.EDITOR_CODE || '',
  // Endereços do frontend liberados no CORS, separados por vírgula. * = todos.
  CORS_ORIGIN: env.CORS_ORIGIN || '*',
  // Serviço de IA em Python (revisão do roteiro).
  AI_SERVICE_URL: (env.AI_SERVICE_URL || 'http://localhost:8000').replace(/\/+$/, ''),
  AI_TIMEOUT_MS: +(env.AI_TIMEOUT_MS || 8000),
  // Deepgram: API pública de reconhecimento de fala em tempo real.
  DEEPGRAM_API_KEY: env.DEEPGRAM_API_KEY || '',
  DEEPGRAM_URL: env.DEEPGRAM_URL || 'wss://api.deepgram.com/v1/listen',
  DEEPGRAM_MODEL: env.DEEPGRAM_MODEL || 'nova-2',
  DEEPGRAM_LANGUAGE: env.DEEPGRAM_LANGUAGE || 'pt-BR'
};
