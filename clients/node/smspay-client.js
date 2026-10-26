'use strict';


const crypto = require('node:crypto');

class SmsPayError extends Error {
  constructor(status, code, message, body) {
    super(message || code || `HTTP ${status}`);
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

const sha256Hex = (s) => crypto.createHash('sha256').update(s || '', 'utf8').digest('hex');
const hmacHex = (secret, s) => crypto.createHmac('sha256', secret).update(s, 'utf8').digest('hex');

function signedHeaders(idHeader, id, secret, method, path, rawBody) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const canonical = [timestamp, nonce, method.toUpperCase(), path, sha256Hex(rawBody)].join('\n');
  return {
    [idHeader]: id,
    'X-Timestamp': timestamp,
    'X-Nonce': nonce,
    'X-Signature': hmacHex(secret, canonical),
  };
}

async function send(baseUrl, method, path, body, headers) {
  const rawBody = body === undefined ? '' : JSON.stringify(body);
  const res = await fetch(baseUrl.replace(/\/$/, '') + path, {
    method,
    headers: { ...headers, ...(rawBody ? { 'content-type': 'application/json' } : {}) },
    body: rawBody || undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    throw new SmsPayError(res.status, data?.error?.code, data?.error?.message, data);
  }
  return data;
}

function withQuery(path, params = {}) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null)).toString();
  return qs ? `${path}?${qs}` : path;
}

class SmsPayClient {
  constructor({ baseUrl, apiKey, apiSecret }) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
  }

  request(method, path, body) {
    const rawBody = body === undefined ? '' : JSON.stringify(body);
    const headers = signedHeaders('X-Api-Key', this.apiKey, this.apiSecret, method, path, rawBody);
    return send(this.baseUrl, method, path, body, headers);
  }

  getMerchant() { return this.request('GET', '/v1/merchant'); }
  updateMerchant(body) { return this.request('PATCH', '/v1/merchant', body); }

  createWallet(body) { return this.request('POST', '/v1/wallets', body); }
  listWallets() { return this.request('GET', '/v1/wallets'); }
  resyncWallet(id, balance) { return this.request('POST', `/v1/wallets/${id}/resync`, { balance }); }

  createPaymentIntent(body) { return this.request('POST', '/v1/payment-intents', body); }
  getPaymentIntent(id) { return this.request('GET', `/v1/payment-intents/${id}`); }
  findPaymentIntent(reference) { return this.request('GET', withQuery('/v1/payment-intents', { reference })); }
  cancelPaymentIntent(id) { return this.request('POST', `/v1/payment-intents/${id}/cancel`); }

  /** Téléphone équipé de SMS Gateway for Android : renvoie webhook_url et signing_key. */
  createSmsGateDevice(body = {}) { return this.request('POST', '/v1/devices/smsgate', body); }
  listDevices() { return this.request('GET', '/v1/devices'); }
  revokeDevice(id) { return this.request('POST', `/v1/devices/${id}/revoke`); }

  listReviews(params = {}) { return this.request('GET', withQuery('/v1/reviews', params)); }
  getReview(id) { return this.request('GET', `/v1/reviews/${id}`); }
  resolveReview(id, body) { return this.request('POST', `/v1/reviews/${id}/resolve`, body); }

  listMessages(params = {}) { return this.request('GET', withQuery('/v1/messages', params)); }
  listEvents(params = {}) { return this.request('GET', withQuery('/v1/events', params)); }
  retryEvent(id) { return this.request('POST', `/v1/events/${id}/retry`); }
}

/**
 * Vérifie un webhook reçu par le marchand. À appeler AVANT de valider une commande.
 *   rawBody : corps brut (chaîne), PAS l'objet déjà parsé
 *   headers : en-têtes de la requête (noms en minuscules, comme dans Node)
 * Renvoie l'événement parsé, ou lève une erreur si la signature est invalide.
 */
function verifyWebhook(webhookSecret, rawBody, headers, toleranceS = 300) {
  const timestamp = headers['x-smspay-timestamp'];
  const signature = headers['x-smspay-signature'];
  if (!timestamp || !signature) throw new Error('En-têtes de signature manquants');
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > toleranceS) throw new Error('Webhook trop ancien');
  const expected = `v1=${hmacHex(webhookSecret, `${timestamp}.${rawBody}`)}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('Signature de webhook invalide');
  return JSON.parse(rawBody);
}

module.exports = { SmsPayClient, SmsPayError, verifyWebhook };
