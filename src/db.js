'use strict';

const mysql = require('mysql2/promise');
const { AsyncLocalStorage } = require('node:async_hooks');

const txStorage = new AsyncLocalStorage();

const SCHEMA = `
CREATE TABLE IF NOT EXISTS merchants (
  id                 VARCHAR(64) PRIMARY KEY,
  name               VARCHAR(100) NOT NULL,
  api_key            VARCHAR(64) NOT NULL UNIQUE,
  api_secret_enc     TEXT NOT NULL,
  webhook_url        TEXT,
  webhook_success    TEXT,
  webhook_failure    TEXT,
  webhook_secret_enc TEXT NOT NULL,
  status             VARCHAR(20) NOT NULL DEFAULT 'active',
  phone              VARCHAR(30),
  payment_mode       VARCHAR(20) NOT NULL DEFAULT 'intent',
  created_at         BIGINT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS wallets (
  id                 VARCHAR(64) PRIMARY KEY,
  merchant_id        VARCHAR(64) NOT NULL,
  operator           VARCHAR(32) NOT NULL,
  msisdn             VARCHAR(30) NOT NULL,
  label              VARCHAR(100),
  balance            BIGINT,
  balance_updated_at BIGINT,
  sync_status        VARCHAR(20) NOT NULL DEFAULT 'unsynced',
  created_at         BIGINT NOT NULL,
  UNIQUE KEY uq_wallet (merchant_id, operator, msisdn),
  FOREIGN KEY (merchant_id) REFERENCES merchants(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS operators (
  id         VARCHAR(64) PRIMARY KEY,
  name       VARCHAR(100) NOT NULL,
  color      VARCHAR(20) NOT NULL DEFAULT '#D2D9B6',
  country    VARCHAR(10) NOT NULL DEFAULT 'BF',
  senders    TEXT NOT NULL,
  active     TINYINT(1) NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS devices (
  id               VARCHAR(64) PRIMARY KEY,
  merchant_id      VARCHAR(64) NOT NULL,
  name             VARCHAR(100) NOT NULL,
  secret_enc       TEXT NOT NULL,
  kind             VARCHAR(20) NOT NULL DEFAULT 'smsgate',
  status           VARCHAR(20) NOT NULL DEFAULT 'active',
  last_seen_at     BIGINT,
  last_heartbeat   TEXT,
  offline_notified TINYINT(1) NOT NULL DEFAULT 0,
  created_at       BIGINT NOT NULL,
  FOREIGN KEY (merchant_id) REFERENCES merchants(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS payment_plans (
  id          VARCHAR(64) PRIMARY KEY,
  merchant_id VARCHAR(64) NOT NULL,
  name        VARCHAR(200) NOT NULL,
  amount      BIGINT NOT NULL,
  operator    VARCHAR(32) DEFAULT NULL,
  active      TINYINT(1) NOT NULL DEFAULT 1,
  created_at  BIGINT NOT NULL,
  FOREIGN KEY (merchant_id) REFERENCES merchants(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS payment_intents (
  id             VARCHAR(64) PRIMARY KEY,
  merchant_id    VARCHAR(64) NOT NULL,
  reference      VARCHAR(64) NOT NULL,
  amount         BIGINT NOT NULL,
  currency       VARCHAR(10) NOT NULL DEFAULT 'XOF',
  payer_msisdn   VARCHAR(30) NOT NULL,
  operator       VARCHAR(32),
  status         VARCHAR(20) NOT NULL,
  confirmation   VARCHAR(20),
  sms_id         VARCHAR(64),
  transaction_id VARCHAR(64),
  plan_id        VARCHAR(64),
  metadata       TEXT,
  expires_at     BIGINT NOT NULL,
  created_at     BIGINT NOT NULL,
  succeeded_at   BIGINT,
  canceled_at    BIGINT,
  expired_at     BIGINT,
  UNIQUE KEY uq_intent_ref (merchant_id, reference),
  FOREIGN KEY (merchant_id) REFERENCES merchants(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS sms_messages (
  id                  VARCHAR(64) PRIMARY KEY,
  merchant_id         VARCHAR(64) NOT NULL,
  device_id           VARCHAR(64) NOT NULL,
  device_msg_id       VARCHAR(128) NOT NULL,
  sender              VARCHAR(64) NOT NULL,
  body                TEXT NOT NULL,
  sim_slot            INT,
  sim_msisdn          VARCHAR(30),
  device_received_at  BIGINT NOT NULL,
  created_at          BIGINT NOT NULL,
  source              VARCHAR(20) NOT NULL DEFAULT 'live',
  template_id         VARCHAR(64),
  operator            VARCHAR(32),
  kind                VARCHAR(10),
  amount              BIGINT,
  fee                 BIGINT,
  payer_msisdn        VARCHAR(30),
  payer_name          VARCHAR(100),
  new_balance         BIGINT,
  transaction_id      VARCHAR(64),
  wallet_id           VARCHAR(64),
  status              VARCHAR(20) NOT NULL,
  reasons             TEXT,
  candidate_intent_id VARCHAR(64),
  intent_id           VARCHAR(64),
  hold_until          BIGINT,
  UNIQUE KEY uq_sms (device_id, device_msg_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS reviews (
  id                  VARCHAR(64) PRIMARY KEY,
  merchant_id         VARCHAR(64) NOT NULL,
  sms_id              VARCHAR(64) NOT NULL,
  candidate_intent_id VARCHAR(64),
  reason              VARCHAR(64) NOT NULL,
  status              VARCHAR(20) NOT NULL DEFAULT 'open',
  resolution          VARCHAR(20),
  resolved_intent_id  VARCHAR(64),
  note                VARCHAR(500),
  created_at          BIGINT NOT NULL,
  resolved_at         BIGINT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS webhook_events (
  id               VARCHAR(64) PRIMARY KEY,
  merchant_id      VARCHAR(64) NOT NULL,
  type             VARCHAR(64) NOT NULL,
  payload          TEXT NOT NULL,
  status           VARCHAR(20) NOT NULL,
  attempts         INT NOT NULL DEFAULT 0,
  next_attempt_at  BIGINT,
  last_error       TEXT,
  last_status_code INT,
  created_at       BIGINT NOT NULL,
  delivered_at     BIGINT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS api_nonces (
  principal  VARCHAR(64) NOT NULL,
  nonce      VARCHAR(128) NOT NULL,
  expires_at BIGINT NOT NULL,
  PRIMARY KEY (principal, nonce)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS parser_templates (
  id          VARCHAR(64) PRIMARY KEY,
  operator    VARCHAR(32) NOT NULL,
  kind        VARCHAR(16) NOT NULL,
  senders     TEXT NOT NULL,
  pattern     TEXT NOT NULL,
  flags       VARCHAR(10) NOT NULL DEFAULT 'i',
  priority    INT NOT NULL DEFAULT 0,
  active      TINYINT(1) NOT NULL DEFAULT 1,
  example     TEXT,
  updated_at  BIGINT NOT NULL,
  operator_id VARCHAR(64),
  FOREIGN KEY (operator_id) REFERENCES operators(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS merchant_operators (
  merchant_id    VARCHAR(64) NOT NULL,
  operator_id    VARCHAR(64) NOT NULL,
  recipient_name VARCHAR(100),
  PRIMARY KEY (merchant_id, operator_id),
  FOREIGN KEY (merchant_id) REFERENCES merchants(id),
  FOREIGN KEY (operator_id) REFERENCES operators(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`;

const INDEXES = `
CREATE INDEX IF NOT EXISTS ix_intents_match  ON payment_intents (merchant_id, payer_msisdn, status, amount);
CREATE INDEX IF NOT EXISTS ix_intents_expiry ON payment_intents (status, expires_at);
CREATE INDEX IF NOT EXISTS ix_sms_txn        ON sms_messages (operator, transaction_id);
CREATE INDEX IF NOT EXISTS ix_sms_held       ON sms_messages (status, hold_until);
CREATE INDEX IF NOT EXISTS ix_sms_wallet     ON sms_messages (wallet_id, status);
CREATE INDEX IF NOT EXISTS ix_reviews_m      ON reviews (merchant_id, status, created_at);
CREATE INDEX IF NOT EXISTS ix_events_due     ON webhook_events (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS ix_events_m       ON webhook_events (merchant_id, created_at);
`;

class Database {
  constructor(pool) {
    this.pool = pool;
  }

  /** Renvoie la connexion de transaction courante, ou le pool (requête hors transaction). */
  get _conn() {
    return txStorage.getStore() || this.pool;
  }

  prepare(sql) {
    const db = this;
    return {
      async get(...args) {
        const params = args.flat();
        const [rows] = await db._conn.execute(sql, params.length ? params : []);
        return rows[0] ?? null;
      },
      async all(...args) {
        const params = args.flat();
        const [rows] = await db._conn.execute(sql, params.length ? params : []);
        return rows;
      },
      async run(...args) {
        const params = args.flat();
        const [result] = await db._conn.execute(sql, params.length ? params : []);
        return { changes: result.affectedRows, lastInsertId: result.insertId };
      },
    };
  }

  async close() {
    await this.pool.end();
  }
}

/**
 * Exécute fn dans une transaction MySQL.
 * Utilise AsyncLocalStorage pour passer la connexion à toutes les requêtes imbriquées
 * sans modifier les signatures des fonctions.
 * Si une transaction est déjà active (appel imbriqué), réutilise-la.
 */
async function transaction(db, fn) {
  if (txStorage.getStore()) return fn(); // transaction imbriquée : réutiliser
  const conn = await db.pool.getConnection();
  await conn.beginTransaction();
  return txStorage.run(conn, async () => {
    try {
      const result = await fn();
      await conn.commit();
      return result;
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  });
}

async function openDatabase(cfg) {
  const pool = mysql.createPool({
    host: cfg.dbHost,
    port: cfg.dbPort,
    user: cfg.dbUser,
    password: cfg.dbPassword,
    database: cfg.dbName,
    waitForConnections: true,
    connectionLimit: 10,
    multipleStatements: false,
    charset: 'utf8mb4',
  });
  const db = new Database(pool);
  await initSchema(db);
  return db;
}

async function initSchema(db) {
  const stmts = SCHEMA.split(';').map((s) => s.trim()).filter(Boolean);
  for (const stmt of stmts) {
    await db.pool.execute(stmt);
  }
  // Migrations : colonnes ajoutées après le déploiement initial.
  // ER_DUP_FIELDNAME = colonne déjà présente (idempotent).
  const migrations = [
    `ALTER TABLE merchants ADD COLUMN payment_mode VARCHAR(20) NOT NULL DEFAULT 'intent'`,
    `ALTER TABLE payment_intents ADD COLUMN plan_id VARCHAR(64) DEFAULT NULL`,
  ];
  for (const stmt of migrations) {
    try { await db.pool.execute(stmt); } catch (err) {
      if (err.code !== 'ER_DUP_FIELDNAME') throw err;
    }
  }

  // Les index utilisent "IF NOT EXISTS" qui n'est pas supporté par MySQL < 8.0.
  // On les crée séparément en ignorant les erreurs "Duplicate key name".
  const idxStmts = INDEXES.split(';').map((s) => s.trim()).filter(Boolean);
  for (const stmt of idxStmts) {
    const mysqlStmt = stmt.replace('CREATE INDEX IF NOT EXISTS', 'CREATE INDEX');
    try {
      await db.pool.execute(mysqlStmt);
    } catch (err) {
      if (err.code !== 'ER_DUP_KEYNAME') throw err;
    }
  }
}

/** Vide toutes les tables (usage tests uniquement). */
async function truncateAll(db) {
  const tables = [
    'webhook_events', 'reviews', 'sms_messages', 'payment_intents',
    'merchant_operators', 'api_nonces', 'devices', 'wallets',
    'parser_templates', 'operators', 'merchants',
  ];
  const conn = await db.pool.getConnection();
  try {
    await conn.execute('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of tables) await conn.execute(`DELETE FROM ${t}`);
    await conn.execute('SET FOREIGN_KEY_CHECKS = 1');
  } finally {
    conn.release();
  }
}

module.exports = { openDatabase, transaction, truncateAll, Database };
