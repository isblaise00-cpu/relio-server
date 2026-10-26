'use strict';

const crypto = require('node:crypto');
const { ApiError } = require('../lib/errors');
const { signRequest, safeEqualHex } = require('../lib/signing');
const merchants = require('../services/merchants');

/**
 * Vérifie une requête signée HMAC (voir src/lib/signing.js) :
 *  - horodatage dans la fenêtre de tolérance (anti-rejeu)
 *  - nonce jamais utilisé (anti-rejeu)
 *  - signature valide sur méthode + chemin + corps brut (anti-falsification)
 */
function hmacAuth(ctx, { idHeader, findPrincipal, secretOf, attach }) {
  return async (req, _res, next) => {
    try {
      const principalId = req.get(idHeader);
      const timestamp = req.get('x-timestamp');
      const nonce = req.get('x-nonce');
      const signature = req.get('x-signature');

      if (!principalId || !timestamp || !nonce || !signature) {
        return next(new ApiError(401, 'missing_auth', `En-têtes requis : ${idHeader}, X-Timestamp, X-Nonce, X-Signature`));
      }
      if (!/^\d{9,11}$/.test(timestamp)) return next(new ApiError(401, 'invalid_timestamp', 'X-Timestamp doit être un horodatage Unix en secondes'));
      if (!/^[A-Za-z0-9_\-]{16,64}$/.test(nonce)) return next(new ApiError(401, 'invalid_nonce', 'X-Nonce doit contenir 16 à 64 caractères alphanumériques'));

      const nowS = Math.floor(Date.now() / 1000);
      if (Math.abs(nowS - Number(timestamp)) > ctx.cfg.signatureToleranceS) {
        return next(new ApiError(401, 'stale_request', "Requête trop ancienne ou horloge désynchronisée"));
      }

      const principal = await findPrincipal(principalId);
      // Calcul factice si le principal n'existe pas, pour ne pas révéler son existence par le temps de réponse.
      const secret = principal ? secretOf(principal) : crypto.randomBytes(32).toString('hex');
      const expected = signRequest(secret, {
        timestamp,
        nonce,
        method: req.method,
        path: req.originalUrl,
        rawBody: req.rawBody || '',
      });
      if (!principal || !safeEqualHex(expected, signature.toLowerCase())) {
        return next(new ApiError(401, 'invalid_signature', 'Identifiants ou signature invalides'));
      }

      const res = await ctx.db
        .prepare('INSERT IGNORE INTO api_nonces (principal, nonce, expires_at) VALUES (?, ?, ?)')
        .run(principalId, nonce, Date.now() + ctx.cfg.signatureToleranceS * 2000);
      if (res.changes === 0) return next(new ApiError(401, 'replayed_request', 'Ce nonce a déjà été utilisé'));

      attach(req, principal);
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

function merchantAuth(ctx) {
  return hmacAuth(ctx, {
    idHeader: 'x-api-key',
    findPrincipal: (id) => merchants.findByApiKey(ctx, id),
    secretOf: (m) => ctx.vault.decrypt(m.api_secret_enc),
    attach: (req, m) => {
      req.merchant = m;
    },
  });
}

function adminAuth(ctx) {
  return (req, _res, next) => {
    if (!ctx.cfg.adminToken) return next(new ApiError(404, 'not_found', 'Route introuvable'));
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const a = crypto.createHash('sha256').update(token).digest();
    const b = crypto.createHash('sha256').update(ctx.cfg.adminToken).digest();
    if (!token || !crypto.timingSafeEqual(a, b)) return next(new ApiError(401, 'invalid_admin_token', 'Jeton administrateur invalide'));
    return next();
  };
}

module.exports = { merchantAuth, adminAuth };
