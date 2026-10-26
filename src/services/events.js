'use strict';

const { newId } = require('../lib/ids');
const { iso } = require('../lib/format');
const { signWebhook } = require('../lib/signing');
const { ApiError } = require('../lib/errors');
const { checkPublicUrl } = require('../lib/netguard');

/** Délais entre deux tentatives de livraison d'un webhook (secondes). */
const BACKOFF_S = [10, 30, 120, 600, 1800, 3600, 10800, 21600];
const MAX_ATTEMPTS = BACKOFF_S.length + 1;

/**
 * Enregistre un événement à envoyer au webhook du marchand.
 * L'envoi réel est fait par la tâche de fond (deliverDue), avec nouvelles tentatives.
 */
async function enqueue(ctx, merchantId, type, data, now = Date.now()) {
  const id = newId('evt');
  const payload = JSON.stringify({ id, type, created_at: iso(now), data });
  await ctx.db
    .prepare(
      `INSERT INTO webhook_events (id, merchant_id, type, payload, status, attempts, next_attempt_at, created_at)
       VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)`,
    )
    .run(id, merchantId, type, payload, now, now);
  return id;
}

function serializeEvent(row) {
  return {
    id: row.id,
    object: 'event',
    type: row.type,
    status: row.status,
    attempts: row.attempts,
    next_attempt_at: row.status === 'pending' ? iso(row.next_attempt_at) : null,
    last_status_code: row.last_status_code,
    last_error: row.last_error,
    created_at: iso(row.created_at),
    delivered_at: iso(row.delivered_at),
    data: JSON.parse(row.payload).data,
  };
}

async function listEvents(ctx, merchantId, { limit = 50, type } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const rows = type
    ? await ctx.db
        .prepare('SELECT * FROM webhook_events WHERE merchant_id = ? AND type = ? ORDER BY created_at DESC, id DESC LIMIT ?')
        .all(merchantId, type, lim)
    : await ctx.db
        .prepare('SELECT * FROM webhook_events WHERE merchant_id = ? ORDER BY created_at DESC, id DESC LIMIT ?')
        .all(merchantId, lim);
  return rows.map(serializeEvent);
}

async function retryEvent(ctx, merchantId, eventId, now = Date.now()) {
  const row = await ctx.db.prepare('SELECT * FROM webhook_events WHERE id = ? AND merchant_id = ?').get(eventId, merchantId);
  if (!row) throw new ApiError(404, 'event_not_found', 'Événement introuvable');
  await ctx.db
    .prepare(`UPDATE webhook_events SET status = 'pending', attempts = 0, next_attempt_at = ?, last_error = NULL WHERE id = ?`)
    .run(now, eventId);
  return serializeEvent(await ctx.db.prepare('SELECT * FROM webhook_events WHERE id = ?').get(eventId));
}

/** Choisit l'URL de webhook selon le type d'événement. */
function selectWebhookUrl(merchant, eventType) {
  if (eventType === 'payment_intent.succeeded') {
    return merchant.webhook_success || merchant.webhook_url;
  }
  if (eventType === 'payment_intent.failed' || eventType === 'payment_intent.expired') {
    return merchant.webhook_failure || merchant.webhook_url;
  }
  return merchant.webhook_url;
}

async function deliverOne(ctx, event, merchant, webhookUrl, now) {
  const timestamp = Math.floor(now / 1000).toString();
  const secret = ctx.vault.decrypt(merchant.webhook_secret_enc);
  let statusCode = null;
  let error = null;
  // Anti-SSRF : on revérifie au moment de l'envoi (le DNS a pu changer depuis l'enregistrement de l'URL).
  if (!ctx.cfg.allowPrivateWebhooks) error = await checkPublicUrl(webhookUrl);
  if (!error) try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'SmsPay-Webhooks/0.1',
        'x-smspay-event-id': event.id,
        'x-smspay-event-type': event.type,
        'x-smspay-timestamp': timestamp,
        'x-smspay-signature': signWebhook(secret, timestamp, event.payload),
      },
      body: event.payload,
      redirect: 'manual',
      signal: AbortSignal.timeout(ctx.cfg.webhookTimeoutMs),
    });
    statusCode = res.status;
    await res.arrayBuffer().catch(() => {});
    if (res.status < 200 || res.status >= 300) error = `HTTP ${res.status}`;
  } catch (err) {
    error = err.name === 'TimeoutError' ? 'timeout' : String(err.cause?.code || err.message).slice(0, 200);
  }

  const doneAt = Date.now();
  if (!error) {
    await ctx.db
      .prepare(
        `UPDATE webhook_events SET status = 'delivered', attempts = attempts + 1, last_status_code = ?, last_error = NULL,
           delivered_at = ?, next_attempt_at = NULL WHERE id = ?`,
      )
      .run(statusCode, doneAt, event.id);
    return true;
  }

  const attempts = event.attempts + 1;
  if (attempts >= MAX_ATTEMPTS) {
    await ctx.db
      .prepare(
        `UPDATE webhook_events SET status = 'failed', attempts = ?, last_status_code = ?, last_error = ?, next_attempt_at = NULL WHERE id = ?`,
      )
      .run(attempts, statusCode, error, event.id);
  } else {
    const next = now + BACKOFF_S[attempts - 1] * 1000;
    await ctx.db
      .prepare(`UPDATE webhook_events SET attempts = ?, last_status_code = ?, last_error = ?, next_attempt_at = ? WHERE id = ?`)
      .run(attempts, statusCode, error, next, event.id);
  }
  ctx.log.warn(`Webhook ${event.type} (${event.id}) non livré : ${error} — tentative ${attempts}/${MAX_ATTEMPTS}`);
  return false;
}

/** Envoie les webhooks dont l'échéance est passée. */
async function deliverDue(ctx, now = Date.now(), batchSize = 50) {
  const due = await ctx.db
    .prepare(`SELECT * FROM webhook_events WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at, id LIMIT ?`)
    .all(now, batchSize);
  let delivered = 0;
  for (const event of due) {
    const merchant = await ctx.db.prepare('SELECT * FROM merchants WHERE id = ?').get(event.merchant_id);
    // Marchand absent ou supprimé : on n'envoie plus rien.
    const webhookUrl = merchant && merchant.status !== 'deleted' ? selectWebhookUrl(merchant, event.type) : null;
    if (!webhookUrl) {
      await ctx.db
        .prepare(`UPDATE webhook_events SET status = 'no_endpoint', next_attempt_at = NULL WHERE id = ?`)
        .run(event.id);
      continue;
    }
    if (await deliverOne(ctx, event, merchant, webhookUrl, now)) delivered += 1;
  }
  return delivered;
}

module.exports = { enqueue, listEvents, retryEvent, deliverDue, serializeEvent, BACKOFF_S };
