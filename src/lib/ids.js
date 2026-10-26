'use strict';

const crypto = require('node:crypto');

/** Identifiant public lisible, ex. "pi_3f9a…". */
function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

/** Secret long, ex. "sk_…". */
function newSecret(prefix) {
  return `${prefix}_${crypto.randomBytes(32).toString('base64url')}`;
}

module.exports = { newId, newSecret };
