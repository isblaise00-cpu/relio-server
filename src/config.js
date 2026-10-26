'use strict';

const crypto = require('node:crypto');

function readInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`La variable d'environnement ${name} doit être un nombre`);
  return n;
}

/**
 * Charge la configuration depuis les variables d'environnement.
 * `overrides` permet aux tests d'imposer des valeurs.
 */
function loadConfig(overrides = {}) {
  const env = process.env;
  const cfg = {
    port: readInt('PORT', 3000),
    // Connexion MySQL
    dbHost: env.DB_HOST || '127.0.0.1',
    dbPort: readInt('DB_PORT', 3306),
    dbUser: env.DB_USER || 'root',
    dbPassword: env.DB_PASSWORD || '',
    dbName: env.DB_NAME || 'smspay',
    nodeEnv: env.NODE_ENV || 'development',
    masterKey: env.MASTER_KEY || '',
    adminToken: env.ADMIN_TOKEN || '',
    defaultCountryCode: env.DEFAULT_COUNTRY_CODE || '226',
    signatureToleranceS: readInt('SIGNATURE_TOLERANCE_S', 300),
    holdSeconds: readInt('HOLD_SECONDS', 120),
    deviceOfflineAfterS: readInt('DEVICE_OFFLINE_AFTER_S', 300),
    workerIntervalMs: readInt('WORKER_INTERVAL_MS', 2000),
    matchClockSkewS: readInt('MATCH_CLOCK_SKEW_S', 120),
    intentDefaultTtlS: readInt('INTENT_DEFAULT_TTL_S', 900),
    maxAmount: readInt('MAX_AMOUNT', 2000000),
    webhookTimeoutMs: readInt('WEBHOOK_TIMEOUT_MS', 10000),
    // URL publique du serveur (ex. https://pay.mondomaine.bf), pour fabriquer les URL de webhook SMS Gateway.
    publicBaseUrl: (env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),
    quiet: false,
    ...overrides,
  };

  // Webhooks vers des adresses internes (localhost, réseau privé) : autorisés seulement hors production.
  if (cfg.allowPrivateWebhooks === undefined) {
    cfg.allowPrivateWebhooks = readBool('ALLOW_PRIVATE_WEBHOOKS', cfg.nodeEnv !== 'production');
  }

  checkAdminToken(cfg);
  cfg.masterKeyBuf = resolveMasterKey(cfg);
  return cfg;
}

function readBool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (/^(1|true|yes|oui)$/i.test(raw)) return true;
  if (/^(0|false|no|non)$/i.test(raw)) return false;
  throw new Error(`La variable d'environnement ${name} doit valoir true ou false`);
}

const PLACEHOLDER_ADMIN_TOKEN = 'change-moi-avec-un-long-jeton-aleatoire';

/** Refuse en production un jeton admin laissé à sa valeur d'exemple ou trop court. */
function checkAdminToken(cfg) {
  if (!cfg.adminToken) return;
  const weak = cfg.adminToken === PLACEHOLDER_ADMIN_TOKEN || cfg.adminToken.length < 32;
  if (!weak) return;
  if (cfg.nodeEnv === 'production') {
    throw new Error('ADMIN_TOKEN est trop faible (valeur d\'exemple ou moins de 32 caractères). Générez-en un avec : node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  }
  if (!cfg.quiet) {
    console.warn('[config] ADMIN_TOKEN faible (valeur d\'exemple ou moins de 32 caractères) : acceptable en développement uniquement.');
  }
}

function resolveMasterKey(cfg) {
  if (cfg.masterKey) {
    if (!/^[0-9a-fA-F]{64}$/.test(cfg.masterKey)) {
      throw new Error('MASTER_KEY doit contenir exactement 64 caractères hexadécimaux (32 octets)');
    }
    return Buffer.from(cfg.masterKey, 'hex');
  }
  if (cfg.nodeEnv === 'production') {
    throw new Error('MASTER_KEY est obligatoire en production');
  }
  if (!cfg.quiet) {
    console.warn('[config] MASTER_KEY absente : clé de développement NON SÉCURISÉE utilisée.');
  }
  return crypto.createHash('sha256').update('smspay-dev-insecure-master-key').digest();
}

module.exports = { loadConfig };
