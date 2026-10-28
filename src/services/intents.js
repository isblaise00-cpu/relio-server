'use strict';

const { newId } = require('../lib/ids');
const { ApiError } = require('../lib/errors');
const { iso, normalizePhone, displayPhone, formatAmount, operatorLabel } = require('../lib/format');
const parser = require('./parser');
const wallets = require('./wallets');
const events = require('./events');

async function payInstructions(ctx, row) {
  const list = await wallets.listWallets(ctx, row.merchant_id, row.operator || undefined);
  return list.map((w) => ({
    operator: w.operator,
    operator_label: operatorLabel(w.operator),
    phone: displayPhone(w.msisdn),
    amount: row.amount,
    message:
      `Envoyez exactement ${formatAmount(row.amount)} FCFA par ${operatorLabel(w.operator)} ` +
      `depuis le numéro ${displayPhone(row.payer_msisdn)} vers le ${displayPhone(w.msisdn)}.`,
  }));
}

async function serializeIntent(ctx, row, { withInstructions = false } = {}) {
  const out = {
    id: row.id,
    object: 'payment_intent',
    reference: row.reference,
    amount: row.amount,
    currency: row.currency,
    payer_phone: displayPhone(row.payer_msisdn),
    operator: row.operator,
    status: row.status,
    confirmation: row.confirmation,
    transaction_id: row.transaction_id,
    plan_id: row.plan_id || null,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
    expires_at: iso(row.expires_at),
    created_at: iso(row.created_at),
    succeeded_at: iso(row.succeeded_at),
    canceled_at: iso(row.canceled_at),
    expired_at: iso(row.expired_at),
  };
  if (withInstructions && row.status === 'pending') out.pay_to = await payInstructions(ctx, row);
  return out;
}

async function getRow(ctx, id) {
  return ctx.db.prepare('SELECT * FROM payment_intents WHERE id = ?').get(id);
}

async function getMerchantIntent(ctx, merchantId, id) {
  const row = await ctx.db.prepare('SELECT * FROM payment_intents WHERE id = ? AND merchant_id = ?').get(id, merchantId);
  if (!row) throw new ApiError(404, 'intent_not_found', 'Intention de paiement introuvable');
  return row;
}

async function findByReference(ctx, merchantId, reference) {
  return ctx.db.prepare('SELECT * FROM payment_intents WHERE merchant_id = ? AND reference = ?').get(merchantId, reference);
}

/**
 * Crée une intention de paiement. Appelée par le SERVEUR du marchand (requête signée).
 */
async function createIntent(ctx, merchant, body = {}, now = Date.now()) {
  const { cfg, db } = ctx;

  const reference = body.reference;
  if (typeof reference !== 'string' || !reference.trim() || reference.length > 64) {
    throw new ApiError(400, 'invalid_reference', 'reference est obligatoire (64 caractères max), ex. le numéro de commande');
  }
  const amount = body.amount;
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > cfg.maxAmount) {
    throw new ApiError(400, 'invalid_amount', `amount doit être un entier entre 1 et ${cfg.maxAmount} (FCFA)`);
  }
  const payer = normalizePhone(body.payer_phone, cfg.defaultCountryCode);
  if (!payer) throw new ApiError(400, 'invalid_payer_phone', 'payer_phone invalide');

  let operator = null;
  if (body.operator !== undefined && body.operator !== null) {
    const operators = await parser.knownOperators(ctx);
    if (!operators.includes(body.operator)) {
      throw new ApiError(400, 'invalid_operator', `operator doit être l'un de : ${operators.join(', ')}`);
    }
    operator = body.operator;
  }

  const ttl = body.expires_in === undefined ? cfg.intentDefaultTtlS : body.expires_in;
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > 86400) {
    throw new ApiError(400, 'invalid_expires_in', 'expires_in doit être un entier entre 60 et 86400 secondes');
  }

  let metadata = null;
  if (body.metadata !== undefined && body.metadata !== null) {
    if (typeof body.metadata !== 'object' || Array.isArray(body.metadata)) {
      throw new ApiError(400, 'invalid_metadata', 'metadata doit être un objet');
    }
    metadata = JSON.stringify(body.metadata);
    if (metadata.length > 4000) throw new ApiError(400, 'invalid_metadata', 'metadata trop volumineux (4 Ko max)');
  }

  const available = await wallets.listWallets(ctx, merchant.id, operator || undefined);
  if (available.length === 0) {
    throw new ApiError(
      409,
      'no_wallet',
      operator
        ? `Aucun portefeuille ${operator} configuré pour ce marchand`
        : 'Aucun portefeuille configuré : créez-en un avec POST /v1/wallets',
    );
  }

  // Idempotence : même référence => on renvoie l'intention existante si elle est identique.
  const existing = await findByReference(ctx, merchant.id, reference.trim());
  if (existing) {
    if (existing.amount === amount && existing.payer_msisdn === payer) {
      return { intent: existing, created: false };
    }
    throw new ApiError(409, 'reference_conflict', 'Une intention avec cette référence existe déjà avec un autre montant ou payeur');
  }

  // Deux intentions actives identiques (même payeur, même montant) seraient impossibles à départager.
  const duplicate = await db
    .prepare(
      `SELECT id FROM payment_intents
       WHERE merchant_id = ? AND payer_msisdn = ? AND amount = ? AND status = 'pending' AND expires_at >= ? LIMIT 1`,
    )
    .get(merchant.id, payer, amount, now);
  if (duplicate) {
    throw new ApiError(
      409,
      'duplicate_pending_intent',
      'Une intention en attente existe déjà pour ce payeur et ce montant. Annulez-la, attendez son expiration ou changez légèrement le montant.',
      { existing_intent_id: duplicate.id },
    );
  }

  const id = newId('pi');
  await db.prepare(
    `INSERT INTO payment_intents (id, merchant_id, reference, amount, currency, payer_msisdn, operator, status, metadata, expires_at, created_at)
     VALUES (?, ?, ?, ?, 'XOF', ?, ?, 'pending', ?, ?, ?)`,
  ).run(id, merchant.id, reference.trim(), amount, payer, operator, metadata, now + ttl * 1000, now);
  return { intent: await getRow(ctx, id), created: true };
}

async function cancelIntent(ctx, merchantId, id, now = Date.now()) {
  const row = await getMerchantIntent(ctx, merchantId, id);
  if (row.status !== 'pending') {
    throw new ApiError(409, 'intent_not_cancelable', `Impossible d'annuler une intention au statut "${row.status}"`);
  }
  await ctx.db.prepare(`UPDATE payment_intents SET status = 'canceled', canceled_at = ? WHERE id = ?`).run(now, id);
  const updated = await getRow(ctx, id);
  await events.enqueue(ctx, merchantId, 'payment_intent.canceled', await serializeIntent(ctx, updated), now);
  return updated;
}

/**
 * Cherche l'intention correspondant à un paiement reçu.
 */
async function findCandidates(ctx, { merchantId, payer, amount, operator, receivedAt }, now = Date.now()) {
  const { db, cfg } = ctx;
  const skew = cfg.matchClockSkewS * 1000;

  const exact = await db
    .prepare(
      `SELECT * FROM payment_intents
       WHERE merchant_id = ? AND payer_msisdn = ? AND amount = ? AND status = 'pending' AND expires_at >= ?
         AND (operator IS NULL OR operator = ?) AND created_at <= ?
       ORDER BY created_at ASC LIMIT 1`,
    )
    .get(merchantId, payer, amount, now, operator, receivedAt + skew);
  if (exact) return { exact, reason: null, related: null };

  const otherAmount = await db
    .prepare(
      `SELECT * FROM payment_intents
       WHERE merchant_id = ? AND payer_msisdn = ? AND status = 'pending' AND expires_at >= ? AND amount <> ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(merchantId, payer, now, amount);
  if (otherAmount) return { exact: null, reason: 'amount_mismatch', related: otherAmount };

  const late = await db
    .prepare(
      `SELECT * FROM payment_intents
       WHERE merchant_id = ? AND payer_msisdn = ? AND amount = ?
         AND (status = 'expired' OR (status = 'pending' AND expires_at < ?))
       ORDER BY expires_at DESC LIMIT 1`,
    )
    .get(merchantId, payer, amount, now);
  if (late) return { exact: null, reason: 'late_payment', related: late };

  const wrongOperator = await db
    .prepare(
      `SELECT * FROM payment_intents
       WHERE merchant_id = ? AND payer_msisdn = ? AND amount = ? AND status = 'pending' AND expires_at >= ?
         AND operator IS NOT NULL AND operator <> ?
       ORDER BY created_at ASC LIMIT 1`,
    )
    .get(merchantId, payer, amount, now, operator);
  if (wrongOperator) return { exact: null, reason: 'operator_mismatch', related: wrongOperator };

  const tooOld = await db
    .prepare(
      `SELECT * FROM payment_intents
       WHERE merchant_id = ? AND payer_msisdn = ? AND amount = ? AND status = 'pending' AND expires_at >= ? AND created_at > ?
       ORDER BY created_at ASC LIMIT 1`,
    )
    .get(merchantId, payer, amount, now, receivedAt + skew);
  if (tooOld) return { exact: null, reason: 'sms_predates_intent', related: tooOld };

  return { exact: null, reason: 'unknown_payer', related: null };
}

/** Marque une intention comme payée et prévient le marchand par webhook. */
async function succeedIntent(ctx, intent, sms, confirmation, now = Date.now()) {
  const res = await ctx.db
    .prepare(
      `UPDATE payment_intents SET status = 'succeeded', confirmation = ?, sms_id = ?, transaction_id = ?, succeeded_at = ?
       WHERE id = ? AND status IN ('pending', 'expired')`,
    )
    .run(confirmation, sms.id, sms.transaction_id, now, intent.id);
  if (res.changes === 0) {
    throw new ApiError(409, 'intent_not_payable', "L'intention n'est plus en attente de paiement");
  }
  const updated = await getRow(ctx, intent.id);
  await events.enqueue(
    ctx,
    intent.merchant_id,
    'payment_intent.succeeded',
    {
      ...await serializeIntent(ctx, updated),
      payment: {
        operator: sms.operator,
        transaction_id: sms.transaction_id,
        amount: sms.amount,
        payer_phone: displayPhone(sms.payer_msisdn),
        received_at: iso(sms.device_received_at),
      },
    },
    now,
  );
  return updated;
}

/**
 * Crée une intention interne pour un plan de paiement.
 * Appelée par ingest.js — jamais exposée directement à l'API marchand.
 */
async function createPlanIntent(ctx, plan, sms, now = Date.now()) {
  const id = newId('pi');
  const reference = `plan:${plan.id}:${sms.id}`;
  await ctx.db
    .prepare(
      `INSERT INTO payment_intents
         (id, merchant_id, reference, amount, currency, payer_msisdn, operator, status, plan_id, expires_at, created_at)
       VALUES (?, ?, ?, ?, 'XOF', ?, ?, 'pending', ?, ?, ?)`,
    )
    .run(id, plan.merchant_id, reference, plan.amount, sms.payer_msisdn, sms.operator, plan.id, now + 300000, now);
  return getRow(ctx, id);
}

/** Tâche de fond : passe en "expired" les intentions dont le délai est dépassé. */
async function expireDue(ctx, now = Date.now()) {
  const due = await ctx.db
    .prepare(`SELECT * FROM payment_intents WHERE status = 'pending' AND expires_at < ? LIMIT 500`)
    .all(now);
  for (const row of due) {
    await ctx.db.prepare(`UPDATE payment_intents SET status = 'expired', expired_at = ? WHERE id = ? AND status = 'pending'`).run(now, row.id);
    const updated = await getRow(ctx, row.id);
    await events.enqueue(ctx, row.merchant_id, 'payment_intent.expired', await serializeIntent(ctx, updated), now);
  }
  return due.length;
}

module.exports = {
  serializeIntent,
  getRow,
  getMerchantIntent,
  findByReference,
  createIntent,
  createPlanIntent,
  cancelIntent,
  findCandidates,
  succeedIntent,
  expireDue,
};
