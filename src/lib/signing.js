'use strict';

const crypto = require('node:crypto');

/*
 * Signature des requêtes (marchands ET téléphones) :
 *
 *   chaîne canonique = timestamp \n nonce \n MÉTHODE \n chemin?query \n sha256_hex(corps brut)
 *   X-Signature      = hex( HMAC-SHA256(secret, chaîne canonique) )
 *
 * Signature des webhooks envoyés aux marchands :
 *
 *   X-SmsPay-Signature = "v1=" + hex( HMAC-SHA256(secret_webhook, timestamp + "." + corps brut) )
 */

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data || '', 'utf8').digest('hex');
}

function hmacHex(secret, data) {
  return crypto.createHmac('sha256', secret).update(data, 'utf8').digest('hex');
}

function canonicalString(timestamp, nonce, method, path, rawBody) {
  return [String(timestamp), String(nonce), String(method).toUpperCase(), path, sha256Hex(rawBody || '')].join('\n');
}

function signRequest(secret, { timestamp, nonce, method, path, rawBody }) {
  return hmacHex(secret, canonicalString(timestamp, nonce, method, path, rawBody));
}

function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function signWebhook(secret, timestamp, rawBody) {
  return `v1=${hmacHex(secret, `${timestamp}.${rawBody}`)}`;
}

module.exports = { sha256Hex, hmacHex, canonicalString, signRequest, safeEqualHex, signWebhook };
