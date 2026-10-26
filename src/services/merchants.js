'use strict';

const crypto = require('node:crypto');
const { newId, newSecret } = require('../lib/ids');
const { ApiError } = require('../lib/errors');
const { iso } = require('../lib/format');
const { isObviouslyInternalHost } = require('../lib/netguard');

function validateWebhookUrl(ctx, url) {
  if (url === undefined || url === null || url === '') return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new ApiError(400, 'invalid_webhook_url', 'webhook_url doit être une URL valide');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new ApiError(400, 'invalid_webhook_url', 'webhook_url doit commencer par http:// ou https://');
  }
  if (parsed.username || parsed.password) {
    throw new ApiError(400, 'invalid_webhook_url', "webhook_url ne doit pas contenir d'identifiants");
  }
  if (ctx.cfg.nodeEnv === 'production' && parsed.protocol !== 'https:') {
    throw new ApiError(400, 'invalid_webhook_url', 'webhook_url doit être en https:// en production');
  }
  // Anti-SSRF : pas d'adresse interne (localhost, 10.x, 192.168.x, 169.254.x…) en production.
  if (!ctx.cfg.allowPrivateWebhooks && isObviouslyInternalHost(parsed.hostname)) {
    throw new ApiError(400, 'invalid_webhook_url', 'webhook_url ne peut pas viser une adresse interne ou locale');
  }
  return parsed.toString();
}

function serializeMerchant(row) {
  return {
    id: row.id,
    object: 'merchant',
    name: row.name,
    phone: row.phone || null,
    api_key: row.api_key,
    webhook_url: row.webhook_url,
    webhook_success: row.webhook_success || null,
    webhook_failure: row.webhook_failure || null,
    status: row.status,
    created_at: iso(row.created_at),
  };
}

/** Crée un marchand. Les secrets ne sont renvoyés qu'une seule fois. */
async function createMerchant(ctx, { name, phone, webhook_url } = {}) {
  if (typeof name !== 'string' || !name.trim() || name.length > 100) {
    throw new ApiError(400, 'invalid_name', 'name est obligatoire (100 caractères max)');
  }
  const webhookUrl = validateWebhookUrl(ctx, webhook_url);
  const phoneVal = typeof phone === 'string' && phone.trim() ? phone.trim() : null;
  const id = newId('mer');
  const apiKey = `mk_${crypto.randomBytes(16).toString('hex')}`;
  const apiSecret = newSecret('sk');
  const webhookSecret = newSecret('whsec');
  await ctx.db
    .prepare(
      `INSERT INTO merchants (id, name, phone, api_key, api_secret_enc, webhook_url, webhook_secret_enc, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
    )
    .run(id, name.trim(), phoneVal, apiKey, ctx.vault.encrypt(apiSecret), webhookUrl, ctx.vault.encrypt(webhookSecret), Date.now());
  const row = await ctx.db.prepare('SELECT * FROM merchants WHERE id = ?').get(id);
  return {
    merchant: serializeMerchant(row),
    api_key: apiKey,
    api_secret: apiSecret,
    webhook_secret: webhookSecret,
  };
}

async function findByApiKey(ctx, apiKey) {
  return ctx.db.prepare(`SELECT * FROM merchants WHERE api_key = ? AND status = 'active'`).get(apiKey);
}

async function updateMerchant(ctx, merchant, body = {}) {
  if (Object.prototype.hasOwnProperty.call(body, 'webhook_url')) {
    const url = validateWebhookUrl(ctx, body.webhook_url);
    await ctx.db.prepare('UPDATE merchants SET webhook_url = ? WHERE id = ?').run(url, merchant.id);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'webhook_success')) {
    const url = validateWebhookUrl(ctx, body.webhook_success);
    await ctx.db.prepare('UPDATE merchants SET webhook_success = ? WHERE id = ?').run(url, merchant.id);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'webhook_failure')) {
    const url = validateWebhookUrl(ctx, body.webhook_failure);
    await ctx.db.prepare('UPDATE merchants SET webhook_failure = ? WHERE id = ?').run(url, merchant.id);
  }
  return serializeMerchant(await ctx.db.prepare('SELECT * FROM merchants WHERE id = ?').get(merchant.id));
}

async function deleteMerchant(ctx, id) {
  const row = await ctx.db.prepare("SELECT * FROM merchants WHERE id = ? AND status != 'deleted'").get(id);
  if (!row) throw new ApiError(404, 'merchant_not_found', 'Marchand introuvable');
  await ctx.db.prepare("UPDATE devices SET status = 'revoked' WHERE merchant_id = ? AND status = 'active'").run(id);
  await ctx.db.prepare("UPDATE merchants SET status = 'deleted' WHERE id = ?").run(id);
}

module.exports = { createMerchant, findByApiKey, updateMerchant, serializeMerchant, deleteMerchant };
