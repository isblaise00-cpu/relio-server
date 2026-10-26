'use strict';

/*
 * CŒUR DU SYSTÈME : traitement des SMS transmis par le téléphone du marchand.
 */

const { newId } = require('../lib/ids');
const { ApiError } = require('../lib/errors');
const { normalizePhone, parseTimestamp, displayPhone, iso } = require('../lib/format');
const { transaction } = require('../db');
const parser = require('./parser');
const wallets = require('./wallets');
const intents = require('./intents');
const reviews = require('./reviews');
const events = require('./events');

const MAX_BATCH = 50;

const SOURCES = ['live', 'inbox_scan'];

function validateMessage(raw, idx, ctx) {
  const bad = (msg) => {
    throw new ApiError(400, 'invalid_message', `messages[${idx}] : ${msg}`);
  };
  if (!raw || typeof raw !== 'object') bad('objet attendu');
  if (typeof raw.id !== 'string' || !raw.id.length || raw.id.length > 128) bad('id obligatoire (identifiant unique du SMS côté téléphone)');
  if (typeof raw.sender !== 'string' || !raw.sender.length || raw.sender.length > 64) bad('sender obligatoire');
  if (typeof raw.body !== 'string' || !raw.body.length || raw.body.length > 2000) bad('body obligatoire (2000 caractères max)');
  const receivedAt = parseTimestamp(raw.received_at);
  if (raw.received_at !== undefined && receivedAt === null) bad('received_at invalide');
  const simSlot = raw.sim_slot === undefined || raw.sim_slot === null ? null : raw.sim_slot;
  if (simSlot !== null && !Number.isInteger(simSlot)) bad('sim_slot doit être un entier');
  const simMsisdn = raw.sim_phone ? normalizePhone(raw.sim_phone, ctx.cfg.defaultCountryCode) : null;
  const source = raw.source === undefined ? 'live' : raw.source;
  if (!SOURCES.includes(source)) bad(`source doit valoir ${SOURCES.join(', ')}`);
  return { id: raw.id, sender: raw.sender, body: raw.body, receivedAt, simSlot, simMsisdn, source };
}

async function getSms(ctx, id) {
  return ctx.db.prepare('SELECT * FROM sms_messages WHERE id = ?').get(id);
}

async function updateSms(ctx, id, fields) {
  const keys = Object.keys(fields);
  const sql = `UPDATE sms_messages SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`;
  await ctx.db.prepare(sql).run(...keys.map((k) => (fields[k] === undefined ? null : fields[k])), id);
}

async function summarize(ctx, sms, duplicate = false) {
  const intentId = sms.intent_id || sms.candidate_intent_id;
  const intent = intentId ? await ctx.db.prepare('SELECT reference FROM payment_intents WHERE id = ?').get(intentId) : null;
  return {
    id: sms.device_msg_id,
    sms_id: sms.id,
    source: sms.source,
    status: sms.status,
    reasons: sms.reasons ? JSON.parse(sms.reasons) : [],
    intent_id: sms.intent_id,
    intent_reference: sms.intent_id && intent ? intent.reference : null,
    candidate_intent_reference: !sms.intent_id && intent ? intent.reference : null,
    parsed: sms.kind
      ? {
          operator: sms.operator,
          kind: sms.kind,
          amount: sms.amount,
          fee: sms.fee,
          payer_phone: displayPhone(sms.payer_msisdn),
          payer_name: sms.payer_name || null,
          transaction_id: sms.transaction_id,
        }
      : null,
    duplicate,
  };
}

/** Point d'entrée : lot de SMS envoyé par un téléphone. */
async function ingestBatch(ctx, device, messages, now = Date.now()) {
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_BATCH) {
    throw new ApiError(400, 'invalid_messages', `messages doit être une liste de 1 à ${MAX_BATCH} SMS`);
  }
  const valid = messages.map((m, i) => validateMessage(m, i, ctx));
  const results = [];
  for (const m of valid) {
    results.push(await transaction(ctx.db, () => ingestOne(ctx, device, m, now)));
  }
  return results;
}

async function ingestOne(ctx, device, m, now) {
  // Idempotence : le téléphone peut renvoyer le même SMS (coupure réseau, nouvelle tentative).
  const existing = await ctx.db.prepare('SELECT * FROM sms_messages WHERE device_id = ? AND device_msg_id = ?').get(device.id, m.id);
  if (existing) return summarize(ctx, existing, true);

  // Horloge du téléphone dans le futur : on la ramène à l'heure du serveur.
  let receivedAt = m.receivedAt ?? now;
  if (receivedAt > now + ctx.cfg.matchClockSkewS * 1000) receivedAt = now;

  const id = newId('sms');
  await ctx.db
    .prepare(
      `INSERT INTO sms_messages (id, merchant_id, device_id, device_msg_id, sender, body, sim_slot, sim_msisdn,
         device_received_at, created_at, status, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'processing', ?)`,
    )
    .run(id, device.merchant_id, device.id, m.id, m.sender, m.body, m.simSlot, m.simMsisdn, receivedAt, now, m.source);

  await classify(ctx, device, await getSms(ctx, id), now);
  return summarize(ctx, await getSms(ctx, id));
}

async function classify(ctx, device, sms, now) {
  const parsed = await parser.parseSms(ctx, sms.sender, sms.body);
  if (parsed.error === 'sender_not_allowed') {
    return updateSms(ctx, sms.id, { status: 'rejected', reasons: JSON.stringify(['sender_not_allowed']) });
  }
  if (parsed.error) {
    return updateSms(ctx, sms.id, { status: 'ignored', reasons: JSON.stringify([parsed.error]) });
  }

  const wallet = await wallets.resolveForSms(ctx, device.merchant_id, parsed.operator, sms.sim_msisdn);
  await updateSms(ctx, sms.id, {
    template_id: parsed.templateId,
    operator: parsed.operator,
    kind: parsed.kind,
    amount: parsed.amount,
    fee: parsed.fee,
    payer_msisdn: parsed.payer,
    payer_name: parsed.payerName,
    new_balance: parsed.balance,
    transaction_id: parsed.txnId,
    wallet_id: wallet ? wallet.id : null,
  });
  const fresh = await getSms(ctx, sms.id);
  if (parsed.kind === 'debit') return handleDebit(ctx, fresh, wallet, now);
  return handleCredit(ctx, fresh, wallet, now);
}

/**
 * SMS de débit (retrait, transfert sortant…) : maintenir le solde de référence à jour.
 */
async function handleDebit(ctx, sms, wallet, now) {
  if (!wallet) {
    return updateSms(ctx, sms.id, { status: 'recorded', reasons: JSON.stringify(['wallet_not_found']) });
  }
  if (await isDuplicateTxn(ctx, sms)) {
    return updateSms(ctx, sms.id, { status: 'rejected', reasons: JSON.stringify(['duplicate_transaction']) });
  }
  const expected = wallet.balance === null ? null : wallet.balance - sms.amount - (sms.fee || 0);
  if (wallet.sync_status === 'synced' && expected === sms.new_balance) {
    await wallets.setBalance(ctx, wallet.id, sms.new_balance, now);
    await updateSms(ctx, sms.id, { status: 'recorded', reasons: '[]' });
    return reprocessHeld(ctx, wallet.id, now);
  }
  if (wallet.sync_status === 'synced') {
    await wallets.markUnsynced(ctx, wallet.id);
    await events.enqueue(
      ctx,
      wallet.merchant_id,
      'wallet.desynchronized',
      {
        wallet: wallets.serializeWallet(await wallets.getWallet(ctx, wallet.id)),
        expected_balance: expected,
        announced_balance: sms.new_balance,
        sms_id: sms.id,
      },
      now,
    );
  }
  return updateSms(ctx, sms.id, { status: 'recorded', reasons: JSON.stringify(['balance_mismatch']) });
}

async function isDuplicateTxn(ctx, sms) {
  const row = await ctx.db
    .prepare(`SELECT id FROM sms_messages WHERE operator = ? AND transaction_id = ? AND id <> ? LIMIT 1`)
    .get(sms.operator, sms.transaction_id, sms.id);
  return !!row;
}

async function candidatesFor(ctx, sms, now) {
  return intents.findCandidates(
    ctx,
    {
      merchantId: sms.merchant_id,
      payer: sms.payer_msisdn,
      amount: sms.amount,
      operator: sms.operator,
      receivedAt: sms.device_received_at,
    },
    now,
  );
}

async function toReview(ctx, sms, reason, candidateIntentId, now) {
  const reasons = sms.reasons ? JSON.parse(sms.reasons) : [];
  if (!reasons.includes(reason)) reasons.push(reason);
  await updateSms(ctx, sms.id, { status: 'review', reasons: JSON.stringify(reasons), candidate_intent_id: candidateIntentId || null, hold_until: null });
  await reviews.createReview(ctx, { merchantId: sms.merchant_id, smsId: sms.id, candidateIntentId, reason }, now);
}

async function handleCredit(ctx, sms, wallet, now) {
  const cand = await candidatesFor(ctx, sms, now);

  // Échec dur : ID de transaction déjà vu.
  if (await isDuplicateTxn(ctx, sms)) {
    if (cand.exact) return toReview(ctx, sms, 'suspected_fraud_duplicate', cand.exact.id, now);
    return updateSms(ctx, sms.id, { status: 'rejected', reasons: JSON.stringify(['duplicate_transaction']) });
  }

  // Mise à jour du solde du portefeuille : informative, jamais bloquante.
  // L'expéditeur étant un identifiant alphanumérique opérateur (OrangeMoney, MoovMoney…),
  // la continuité du solde n'est pas nécessaire pour confirmer l'authenticité du SMS.
  if (wallet) {
    if (wallet.balance !== null && wallet.balance + sms.amount === sms.new_balance) {
      await wallets.setBalance(ctx, wallet.id, sms.new_balance, now);
    } else if (wallet.sync_status === 'synced') {
      await wallets.markUnsynced(ctx, wallet.id);
    }
  }

  // Correspondance avec une intention de paiement.
  if (cand.exact) {
    await intents.succeedIntent(ctx, cand.exact, sms, 'auto', now);
    await updateSms(ctx, sms.id, { status: 'matched', intent_id: cand.exact.id, reasons: '[]', hold_until: null, candidate_intent_id: null });
    return;
  }
  await updateSms(ctx, sms.id, { reasons: '[]' });
  await toReview(ctx, await getSms(ctx, sms.id), cand.reason, cand.related ? cand.related.id : null, now);
}

/**
 * Retraite les SMS en attente (status='held') après une mise à jour de balance.
 * Conservé pour compatibilité avec d'éventuels SMS en attente antérieurs.
 */
async function reprocessHeld(ctx, walletId, now = Date.now()) {
  for (let i = 0; i < 100; i++) {
    const wallet = await wallets.getWallet(ctx, walletId);
    if (!wallet || wallet.sync_status !== 'synced' || wallet.balance === null) return;
    const next = await ctx.db
      .prepare(
        `SELECT * FROM sms_messages WHERE wallet_id = ? AND status = 'held' AND amount + ? = new_balance
         ORDER BY device_received_at, created_at, id LIMIT 1`,
      )
      .get(walletId, wallet.balance);
    if (!next) return;
    // Retraitement : mise à jour solde + correspondance intention.
    await wallets.setBalance(ctx, wallet.id, next.new_balance, now);
    const cand = await candidatesFor(ctx, next, now);
    if (cand.exact) {
      await intents.succeedIntent(ctx, cand.exact, next, 'auto', now);
      await updateSms(ctx, next.id, { status: 'matched', intent_id: cand.exact.id, reasons: '[]', hold_until: null, candidate_intent_id: null });
    } else {
      await updateSms(ctx, next.id, { reasons: '[]' });
      await toReview(ctx, await getSms(ctx, next.id), cand.reason, cand.related ? cand.related.id : null, now);
    }
  }
}

/** Tâche de fond : les SMS restés en attente trop longtemps passent en vérification manuelle. */
async function promoteHeld(ctx, now = Date.now()) {
  const due = await ctx.db.prepare(`SELECT * FROM sms_messages WHERE status = 'held' AND hold_until <= ? LIMIT 500`).all(now);
  for (const sms of due) {
    await transaction(ctx.db, async () => {
      const current = await getSms(ctx, sms.id);
      if (current.status !== 'held') return;
      // On recalcule : l'intention a pu être payée, annulée ou expirer entre-temps.
      const cand = await candidatesFor(ctx, current, now);
      if (cand.exact) {
        await toReview(ctx, current, 'suspected_fraud_balance', cand.exact.id, now);
      } else {
        await toReview(ctx, current, 'balance_mismatch', cand.related ? cand.related.id : null, now);
      }
    });
  }
  return due.length;
}

function serializeIncoming(sms) {
  return {
    id: sms.id,
    device_msg_id: sms.device_msg_id,
    sender: sms.sender,
    operator: sms.operator,
    kind: sms.kind,
    amount: sms.amount,
    payer_phone: displayPhone(sms.payer_msisdn),
    payer_name: sms.payer_name || null,
    new_balance: sms.new_balance,
    transaction_id: sms.transaction_id,
    status: sms.status,
    reasons: sms.reasons ? JSON.parse(sms.reasons) : [],
    intent_id: sms.intent_id,
    received_at: iso(sms.device_received_at),
    source: sms.source,
  };
}

async function listMessages(ctx, merchantId, { limit = 50, status } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const rows = status
    ? await ctx.db
        .prepare('SELECT * FROM sms_messages WHERE merchant_id = ? AND status = ? ORDER BY created_at DESC, id DESC LIMIT ?')
        .all(merchantId, status, lim)
    : await ctx.db.prepare('SELECT * FROM sms_messages WHERE merchant_id = ? ORDER BY created_at DESC, id DESC LIMIT ?').all(merchantId, lim);
  return rows.map(serializeIncoming);
}

module.exports = { ingestBatch, reprocessHeld, promoteHeld, listMessages, MAX_BATCH };
