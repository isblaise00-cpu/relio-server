'use strict';

const crypto = require('node:crypto');

/**
 * Chiffrement AES-256-GCM des secrets stockés en base (secrets API, secrets webhook,
 * secrets des téléphones). Format : base64url(iv | tag | texte chiffré).
 */
function createVault(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('Clé de chiffrement invalide');

  function encrypt(plain) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, ct]).toString('base64url');
  }

  function decrypt(blob) {
    const buf = Buffer.from(blob, 'base64url');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const ct = buf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  }

  return { encrypt, decrypt };
}

module.exports = { createVault };
