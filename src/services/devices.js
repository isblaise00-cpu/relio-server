'use strict';

const { newId, newSecret } = require('../lib/ids');
const { ApiError } = require('../lib/errors');
const { iso } = require('../lib/format');
const events = require('./events');

function serializeDevice(row) {
  let heartbeat = null;
  try {
    heartbeat = row.last_heartbeat ? JSON.parse(row.last_heartbeat) : null;
  } catch {
    heartbeat = null;
  }
  return {
    id: row.id,
    object: 'device',
    name: row.name,
    kind: row.kind,
    status: row.status,
    online: row.status === 'active' && row.offline_notified === 0 && row.last_seen_at !== null,
    last_seen_at: iso(row.last_seen_at),
    last_heartbeat: heartbeat,
    created_at: iso(row.created_at),
  };
}

async function getDevice(ctx, id) {
  return ctx.db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
}

/** Téléphone actif utilisant SMS Gateway for Android (webhooks signés par sa clé). */
async function findActiveSmsGate(ctx, id) {
  return ctx.db.prepare(`SELECT * FROM devices WHERE id = ? AND status = 'active' AND kind = 'smsgate'`).get(id);
}

/**
 * Déclare un téléphone équipé de SMS Gateway for Android.
 */
async function createSmsGateDevice(ctx, merchant, body = {}, now = Date.now()) {
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 100) : 'SMS Gateway';
  let signingKey = body.signing_key;
  if (signingKey === undefined || signingKey === null || signingKey === '') {
    signingKey = newSecret('sgk');
  } else if (typeof signingKey !== 'string' || signingKey.length < 16 || signingKey.length > 256 || /\s/.test(signingKey)) {
    throw new ApiError(400, 'invalid_signing_key', 'signing_key doit contenir 16 à 256 caractères, sans espace');
  }
  const id = newId('dev');
  await ctx.db
    .prepare(
      `INSERT INTO devices (id, merchant_id, name, secret_enc, status, last_seen_at, offline_notified, created_at, kind)
       VALUES (?, ?, ?, ?, 'active', NULL, 0, ?, 'smsgate')`,
    )
    .run(id, merchant.id, name, ctx.vault.encrypt(signingKey), now);
  const device = await getDevice(ctx, id);
  await events.enqueue(ctx, merchant.id, 'device.paired', serializeDevice(device), now);
  return { device: serializeDevice(await getDevice(ctx, id)), signing_key: signingKey };
}

async function listDevices(ctx, merchantId) {
  const rows = await ctx.db.prepare('SELECT * FROM devices WHERE merchant_id = ? ORDER BY created_at').all(merchantId);
  return rows.map(serializeDevice);
}

async function revokeDevice(ctx, merchantId, id) {
  const row = await ctx.db.prepare('SELECT * FROM devices WHERE id = ? AND merchant_id = ?').get(id, merchantId);
  if (!row) throw new ApiError(404, 'device_not_found', 'Téléphone introuvable');
  await ctx.db.prepare(`UPDATE devices SET status = 'revoked' WHERE id = ?`).run(id);
  return serializeDevice(await getDevice(ctx, id));
}

/** Toute requête authentifiée d'un téléphone vaut signal de vie. */
async function touch(ctx, device, now = Date.now(), heartbeat) {
  if (heartbeat !== undefined) {
    const json = JSON.stringify(heartbeat).slice(0, 2000);
    await ctx.db.prepare('UPDATE devices SET last_seen_at = ?, last_heartbeat = ? WHERE id = ?').run(now, json, device.id);
  } else {
    await ctx.db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(now, device.id);
  }
  if (device.offline_notified) {
    await ctx.db.prepare('UPDATE devices SET offline_notified = 0 WHERE id = ?').run(device.id);
    await events.enqueue(ctx, device.merchant_id, 'device.online', serializeDevice(await getDevice(ctx, device.id)), now);
  }
}

/** Tâche de fond : prévient le marchand quand un téléphone ne donne plus signe de vie. */
async function markOffline(ctx, now = Date.now()) {
  const limit = now - ctx.cfg.deviceOfflineAfterS * 1000;
  const rows = await ctx.db
    .prepare(`SELECT * FROM devices WHERE status = 'active' AND offline_notified = 0 AND last_seen_at IS NOT NULL AND last_seen_at < ?`)
    .all(limit);
  for (const row of rows) {
    await ctx.db.prepare('UPDATE devices SET offline_notified = 1 WHERE id = ?').run(row.id);
    await events.enqueue(ctx, row.merchant_id, 'device.offline', serializeDevice(await getDevice(ctx, row.id)), now);
  }
  return rows.length;
}

module.exports = {
  serializeDevice,
  getDevice,
  findActiveSmsGate,
  createSmsGateDevice,
  listDevices,
  revokeDevice,
  touch,
  markOffline,
};
