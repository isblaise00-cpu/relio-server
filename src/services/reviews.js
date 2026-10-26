'use strict';

const { newId } = require('../lib/ids');
const { ApiError } = require('../lib/errors');
const { iso, displayPhone } = require('../lib/format');
const events = require('./events');
const intents = require('./intents');
const wallets = require('./wallets');

/** Explication lisible de chaque motif de vérification manuelle. */
const REASON_LABELS = {
  unknown_payer: "Paiement authentique reçu d'un numéro sans intention de paiement en cours.",
  amount_mismatch: "Paiement authentique reçu, mais le montant ne correspond pas à l'intention en cours de ce payeur.",
  late_payment: "Paiement authentique reçu après l'expiration de l'intention de paiement.",
  operator_mismatch: "Paiement reçu sur un autre opérateur que celui demandé dans l'intention.",
  sms_predates_intent: "Le SMS est antérieur à la création de l'intention : il ne peut pas la régler automatiquement.",
  balance_unverified: "Solde de référence inconnu pour ce portefeuille : l'authenticité du SMS n'a pas pu être vérifiée.",
  balance_mismatch: "Le solde annoncé dans le SMS ne correspond pas au solde attendu (SMS manquant ou faux SMS).",
  suspected_fraud_balance: "SUSPICION DE FRAUDE : le SMS correspond à une intention mais le solde annoncé est incohérent.",
  suspected_fraud_duplicate: "SUSPICION DE FRAUDE : cet ID de transaction a déjà été reçu.",
  wallet_not_found: 'Aucun portefeuille configuré ne correspond à ce SMS.',
};

function serializeSms(sms) {
  if (!sms) return null;
  return {
    id: sms.id,
    sender: sms.sender,
    body: sms.body,
    operator: sms.operator,
    kind: sms.kind,
    amount: sms.amount,
    fee: sms.fee,
    payer_phone: displayPhone(sms.payer_msisdn),
    new_balance: sms.new_balance,
    transaction_id: sms.transaction_id,
    status: sms.status,
    reasons: sms.reasons ? JSON.parse(sms.reasons) : [],
    received_at: iso(sms.device_received_at),
  };
}

async function serializeReview(ctx, row) {
  const sms = await ctx.db.prepare('SELECT * FROM sms_messages WHERE id = ?').get(row.sms_id);
  return {
    id: row.id,
    object: 'review',
    status: row.status,
    reason: row.reason,
    reason_label: REASON_LABELS[row.reason] || row.reason,
    candidate_intent_id: row.candidate_intent_id,
    resolution: row.resolution,
    resolved_intent_id: row.resolved_intent_id,
    note: row.note,
    created_at: iso(row.created_at),
    resolved_at: iso(row.resolved_at),
    sms: serializeSms(sms),
  };
}

/** Ouvre une vérification manuelle et prévient le marchand. */
async function createReview(ctx, { merchantId, smsId, candidateIntentId, reason }, now = Date.now()) {
  const id = newId('rv');
  await ctx.db
    .prepare(
      `INSERT INTO reviews (id, merchant_id, sms_id, candidate_intent_id, reason, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'open', ?)`,
    )
    .run(id, merchantId, smsId, candidateIntentId || null, reason, now);
  const row = await ctx.db.prepare('SELECT * FROM reviews WHERE id = ?').get(id);
  await events.enqueue(ctx, merchantId, 'review.created', await serializeReview(ctx, row), now);
  return row;
}

async function listReviews(ctx, merchantId, { status = 'open', limit = 50 } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const rows =
    status === 'all'
      ? await ctx.db.prepare('SELECT * FROM reviews WHERE merchant_id = ? ORDER BY created_at DESC, id DESC LIMIT ?').all(merchantId, lim)
      : await ctx.db
          .prepare('SELECT * FROM reviews WHERE merchant_id = ? AND status = ? ORDER BY created_at DESC, id DESC LIMIT ?')
          .all(merchantId, status, lim);
  return Promise.all(rows.map((r) => serializeReview(ctx, r)));
}

async function getMerchantReview(ctx, merchantId, id) {
  const row = await ctx.db.prepare('SELECT * FROM reviews WHERE id = ? AND merchant_id = ?').get(id, merchantId);
  if (!row) throw new ApiError(404, 'review_not_found', 'Vérification introuvable');
  return row;
}

/**
 * Décision du MARCHAND sur une vérification manuelle :
 *  - attach    : le paiement est réel et correspond à cette intention -> intention payée
 *  - unrelated : le paiement est réel mais ne concerne aucune commande
 *  - fraud     : faux SMS / fraude
 */
async function resolveReview(ctx, merchantId, reviewId, body = {}, now = Date.now()) {
  const { action, note } = body;
  if (!['attach', 'unrelated', 'fraud'].includes(action)) {
    throw new ApiError(400, 'invalid_action', 'action doit valoir "attach", "unrelated" ou "fraud"');
  }
  const review = await getMerchantReview(ctx, merchantId, reviewId);
  if (review.status !== 'open') throw new ApiError(409, 'review_already_resolved', 'Cette vérification est déjà traitée');
  const sms = await ctx.db.prepare('SELECT * FROM sms_messages WHERE id = ?').get(review.sms_id);
  const cleanNote = typeof note === 'string' ? note.slice(0, 500) : null;

  let resolvedIntentId = null;
  if (action === 'attach') {
    const intentId = body.intent_id || review.candidate_intent_id;
    if (!intentId) throw new ApiError(400, 'missing_intent_id', 'intent_id est obligatoire pour rattacher le paiement');
    const intent = await intents.getMerchantIntent(ctx, merchantId, intentId);
    if (!['pending', 'expired'].includes(intent.status)) {
      throw new ApiError(409, 'intent_not_attachable', `Impossible de rattacher une intention au statut "${intent.status}"`);
    }
    await intents.succeedIntent(ctx, intent, sms, 'manual', now);
    resolvedIntentId = intent.id;
    await ctx.db.prepare(`UPDATE sms_messages SET status = 'resolved', intent_id = ? WHERE id = ?`).run(intent.id, sms.id);

    // Le marchand confirme que ce SMS est réel : son solde peut servir de nouvelle référence
    if (sms.kind === 'credit' && sms.wallet_id && sms.new_balance !== null) {
      const wallet = await wallets.getWallet(ctx, sms.wallet_id);
      if (wallet && (wallet.sync_status !== 'synced' || !wallet.balance_updated_at || sms.created_at >= wallet.balance_updated_at)) {
        await wallets.setBalance(ctx, wallet.id, sms.new_balance, now);
        await require('./ingest').reprocessHeld(ctx, wallet.id, now);
      }
    }
  } else if (action === 'unrelated') {
    await ctx.db.prepare(`UPDATE sms_messages SET status = 'resolved' WHERE id = ?`).run(sms.id);
  } else {
    const reasons = sms.reasons ? JSON.parse(sms.reasons) : [];
    reasons.push('marked_fraud');
    await ctx.db.prepare(`UPDATE sms_messages SET status = 'rejected', reasons = ? WHERE id = ?`).run(JSON.stringify(reasons), sms.id);
  }

  const resolution = { attach: 'attached', unrelated: 'unrelated', fraud: 'fraud' }[action];
  await ctx.db
    .prepare(`UPDATE reviews SET status = 'resolved', resolution = ?, resolved_intent_id = ?, note = ?, resolved_at = ? WHERE id = ?`)
    .run(resolution, resolvedIntentId, cleanNote, now, review.id);
  const updated = await ctx.db.prepare('SELECT * FROM reviews WHERE id = ?').get(review.id);
  await events.enqueue(ctx, merchantId, 'review.resolved', await serializeReview(ctx, updated), now);
  return updated;
}

module.exports = { REASON_LABELS, serializeSms, serializeReview, createReview, listReviews, getMerchantReview, resolveReview };
