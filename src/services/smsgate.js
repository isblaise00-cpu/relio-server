'use strict';

/*
 * ADAPTATEUR « SMS Gateway for Android »
 */

const crypto = require('node:crypto');
const { ApiError } = require('../lib/errors');
const { hmacHex, safeEqualHex } = require('../lib/signing');
const devices = require('./devices');
const ingest = require('./ingest');
const operators = require('./operators');
const parser = require('./parser');

/**
 * Vérifie la signature d'un webhook SMS Gateway et renvoie le téléphone concerné.
 * Lève une ApiError 401 sinon.
 */
async function authenticate(ctx, { deviceId, signature, timestamp, rawBody }, nowMs = Date.now()) {
  if (!signature || !timestamp) {
    throw new ApiError(401, 'missing_auth', 'En-têtes requis : X-Signature et X-Timestamp (signature des webhooks SMS Gateway)');
  }
  if (!/^\d{9,11}$/.test(timestamp)) throw new ApiError(401, 'invalid_timestamp', 'X-Timestamp doit être un horodatage Unix en secondes');
  if (Math.abs(Math.floor(nowMs / 1000) - Number(timestamp)) > ctx.cfg.signatureToleranceS) {
    throw new ApiError(401, 'stale_request', 'Webhook trop ancien ou horloge du téléphone désynchronisée');
  }
  const device = await devices.findActiveSmsGate(ctx, deviceId);
  // Calcul factice si le téléphone n'existe pas, pour ne pas révéler son existence par le temps de réponse.
  const key = device ? ctx.vault.decrypt(device.secret_enc) : crypto.randomBytes(32).toString('hex');
  const expected = hmacHex(key, `${rawBody || ''}${timestamp}`);
  if (!device || !safeEqualHex(expected, String(signature).toLowerCase())) {
    throw new ApiError(401, 'invalid_signature', 'Téléphone inconnu ou signature invalide');
  }
  return device;
}

/** Vrai si l'expéditeur fait partie des expéditeurs Mobile Money suivis pour ce marchand. */
async function isWatchedSender(ctx, merchantId, sender) {
  const key = parser.normalizeSender(sender);
  if (!key) return false;
  const senders = await operators.merchantSenders(ctx, merchantId);
  return senders.some((s) => parser.normalizeSender(s) === key);
}

function previousHeartbeat(device) {
  try {
    return device.last_heartbeat ? JSON.parse(device.last_heartbeat) : {};
  } catch {
    return {};
  }
}

async function recordHeartbeat(ctx, device, extra, now) {
  const prev = previousHeartbeat(device);
  const heartbeat = {
    source: 'smsgate',
    sims: prev.sims || null,
    ...extra,
    received_at: new Date(now).toISOString(),
  };
  await devices.touch(ctx, device, now, heartbeat);
}

/** Traduit un SMS reçu (événement sms:received) vers le format attendu par ingest. */
function toIngestMessage(event) {
  const p = event.payload || {};
  const localId = p.messageId || event.id;
  const simNumber = Number.isInteger(p.simNumber) ? p.simNumber : null;
  return {
    id: `sg_${String(localId || '').slice(0, 120)}`,
    sender: p.sender || p.phoneNumber,
    body: p.message,
    received_at: p.receivedAt,
    sim_slot: simNumber !== null && simNumber >= 1 ? simNumber - 1 : null,
    sim_phone: p.recipient || null,
    source: 'live',
  };
}

async function handleSmsReceived(ctx, device, event, now) {
  const msg = toIngestMessage(event);
  if (!msg.sender || !(event.payload || {}).message || msg.id === 'sg_') {
    return { status: 'invalid', reason: 'incomplete_payload' };
  }
  if (!await isWatchedSender(ctx, device.merchant_id, msg.sender)) {
    // SMS personnel ou sans rapport : jamais enregistré.
    return { status: 'skipped', reason: 'sender_not_watched' };
  }
  try {
    const [result] = await ingest.ingestBatch(ctx, device, [msg], now);
    return { status: 'processed', result };
  } catch (err) {
    if (err instanceof ApiError && err.status === 400) {
      ctx.log.warn(`SMS Gateway (${device.id}) : message ignoré — ${err.message}`);
      return { status: 'invalid', reason: err.code };
    }
    throw err;
  }
}

/** Point d'entrée : un webhook authentifié envoyé par l'appli SMS Gateway. */
async function handleWebhook(ctx, device, event, now = Date.now()) {
  if (!event || typeof event !== 'object' || typeof event.event !== 'string') {
    throw new ApiError(400, 'invalid_event', 'Corps attendu : { "event": "...", "payload": { ... } }');
  }
  const fresh = await devices.getDevice(ctx, device.id);

  switch (event.event) {
    case 'sms:received': {
      await devices.touch(ctx, fresh, now);
      return { event: event.event, ...await handleSmsReceived(ctx, fresh, event, now) };
    }
    case 'system:ping': {
      const health = event.payload && event.payload.health ? event.payload.health : null;
      await recordHeartbeat(ctx, fresh, { health }, now);
      return { event: event.event, status: 'recorded' };
    }
    case 'app:started': {
      const cards = Array.isArray(event.payload && event.payload.simCards) ? event.payload.simCards.slice(0, 4) : [];
      const sims = cards.map((c) => ({
        slot: Number.isInteger(c.slotIndex) ? c.slotIndex : null,
        sim_number: Number.isInteger(c.simNumber) ? c.simNumber : null,
        phone_number: typeof c.phoneNumber === 'string' ? c.phoneNumber.slice(0, 20) : null,
        carrier_name: typeof c.carrierName === 'string' ? c.carrierName.slice(0, 40) : null,
      }));
      await recordHeartbeat(ctx, fresh, { sims, app_started_at: new Date(now).toISOString() }, now);
      return { event: event.event, status: 'recorded' };
    }
    default:
      await devices.touch(ctx, fresh, now);
      return { event: event.event, status: 'ignored' };
  }
}

/** URL de webhook à enregistrer dans SMS Gateway pour ce téléphone. */
function webhookUrlFor(ctx, deviceId, req) {
  const base = ctx.cfg.publicBaseUrl || (req ? `${req.protocol}://${req.get('host')}` : '');
  return `${base}/gateway/smsgate/${deviceId}`;
}

/** Événements à enregistrer dans SMS Gateway. */
const EVENTS = ['sms:received', 'system:ping', 'app:started'];

module.exports = { authenticate, handleWebhook, webhookUrlFor, toIngestMessage, isWatchedSender, EVENTS };
