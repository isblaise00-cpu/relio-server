'use strict';

const { newId } = require('../lib/ids');
const { ApiError } = require('../lib/errors');
const { iso, normalizePhone, displayPhone, operatorLabel } = require('../lib/format');
const parser = require('./parser');

function serializeWallet(row) {
  return {
    id: row.id,
    object: 'wallet',
    operator: row.operator,
    operator_label: operatorLabel(row.operator),
    phone: displayPhone(row.msisdn),
    label: row.label,
    balance: row.balance,
    balance_updated_at: iso(row.balance_updated_at),
    sync_status: row.sync_status,
    created_at: iso(row.created_at),
  };
}

function validateBalance(balance) {
  if (!Number.isSafeInteger(balance) || balance < 0) {
    throw new ApiError(400, 'invalid_balance', 'balance doit être un entier positif ou nul (FCFA)');
  }
  return balance;
}

/**
 * Enregistre un portefeuille Mobile Money du marchand.
 * Le solde initial (optionnel mais fortement recommandé) sert de point de départ
 * au contrôle de continuité des soldes.
 */
async function createWallet(ctx, merchant, body = {}) {
  const operators = await parser.knownOperators(ctx);
  if (!operators.includes(body.operator)) {
    throw new ApiError(400, 'invalid_operator', `operator doit être l'un de : ${operators.join(', ')}`);
  }
  const msisdn = normalizePhone(body.phone, ctx.cfg.defaultCountryCode);
  if (!msisdn) throw new ApiError(400, 'invalid_phone', 'phone invalide');
  const label = typeof body.label === 'string' ? body.label.slice(0, 100) : null;
  const hasBalance = body.balance !== undefined && body.balance !== null;
  const balance = hasBalance ? validateBalance(body.balance) : null;

  const exists = await ctx.db
    .prepare('SELECT id FROM wallets WHERE merchant_id = ? AND operator = ? AND msisdn = ?')
    .get(merchant.id, body.operator, msisdn);
  if (exists) throw new ApiError(409, 'wallet_exists', 'Ce portefeuille existe déjà');

  const now = Date.now();
  const id = newId('wal');
  await ctx.db
    .prepare(
      `INSERT INTO wallets (id, merchant_id, operator, msisdn, label, balance, balance_updated_at, sync_status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, merchant.id, body.operator, msisdn, label, balance, hasBalance ? now : null, hasBalance ? 'synced' : 'unsynced', now);
  return serializeWallet(await getWallet(ctx, id));
}

async function getWallet(ctx, id) {
  return ctx.db.prepare('SELECT * FROM wallets WHERE id = ?').get(id);
}

async function getMerchantWallet(ctx, merchantId, id) {
  const row = await ctx.db.prepare('SELECT * FROM wallets WHERE id = ? AND merchant_id = ?').get(id, merchantId);
  if (!row) throw new ApiError(404, 'wallet_not_found', 'Portefeuille introuvable');
  return row;
}

async function listWallets(ctx, merchantId, operator) {
  const rows = operator
    ? await ctx.db.prepare('SELECT * FROM wallets WHERE merchant_id = ? AND operator = ? ORDER BY created_at').all(merchantId, operator)
    : await ctx.db.prepare('SELECT * FROM wallets WHERE merchant_id = ? ORDER BY created_at').all(merchantId);
  return rows;
}

async function setBalance(ctx, walletId, balance, now = Date.now()) {
  await ctx.db
    .prepare(`UPDATE wallets SET balance = ?, balance_updated_at = ?, sync_status = 'synced' WHERE id = ?`)
    .run(balance, now, walletId);
}

async function markUnsynced(ctx, walletId) {
  await ctx.db.prepare(`UPDATE wallets SET sync_status = 'unsynced' WHERE id = ?`).run(walletId);
}

/**
 * Trouve le portefeuille concerné par un SMS : même marchand, même opérateur,
 * et même numéro si le téléphone a pu lire le numéro de la SIM.
 */
async function resolveForSms(ctx, merchantId, operator, simMsisdn) {
  const rows = await listWallets(ctx, merchantId, operator);
  if (simMsisdn) {
    const exact = rows.find((w) => w.msisdn === simMsisdn);
    if (exact) return exact;
  }
  return rows.length === 1 ? rows[0] : null;
}

module.exports = {
  serializeWallet,
  validateBalance,
  createWallet,
  getWallet,
  getMerchantWallet,
  listWallets,
  setBalance,
  markUnsynced,
  resolveForSms,
};
