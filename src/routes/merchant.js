'use strict';

const express = require('express');
const { transaction } = require('../db');
const { ApiError } = require('../lib/errors');
const merchants = require('../services/merchants');
const wallets = require('../services/wallets');
const intents = require('../services/intents');
const devices = require('../services/devices');
const reviews = require('../services/reviews');
const events = require('../services/events');
const ingest = require('../services/ingest');
const smsgate = require('../services/smsgate');
const { merchantAuth } = require('../middleware/auth');

/** API utilisée par le SERVEUR du marchand. Toutes les requêtes sont signées (HMAC). */
function merchantRoutes(ctx) {
  const r = express.Router();
  r.use(merchantAuth(ctx));
  const tx = (fn) => transaction(ctx.db, fn);

  // --- Compte marchand -------------------------------------------------------
  r.get('/merchant', (req, res) => {
    res.json(merchants.serializeMerchant(req.merchant));
  });

  r.patch('/merchant', async (req, res) => {
    res.json(await tx(() => merchants.updateMerchant(ctx, req.merchant, req.body || {})));
  });

  // --- Portefeuilles Mobile Money --------------------------------------------
  r.post('/wallets', async (req, res) => {
    res.status(201).json(await tx(() => wallets.createWallet(ctx, req.merchant, req.body || {})));
  });

  r.get('/wallets', async (req, res) => {
    res.json({ data: (await wallets.listWallets(ctx, req.merchant.id)).map(wallets.serializeWallet) });
  });

  r.post('/wallets/:id/resync', async (req, res) => {
    const out = await tx(async () => {
      const wallet = await wallets.getMerchantWallet(ctx, req.merchant.id, req.params.id);
      const balance = wallets.validateBalance((req.body || {}).balance);
      await wallets.setBalance(ctx, wallet.id, balance);
      await ingest.reprocessHeld(ctx, wallet.id);
      return wallets.serializeWallet(await wallets.getWallet(ctx, wallet.id));
    });
    res.json(out);
  });

  // --- Intentions de paiement ------------------------------------------------
  r.post('/payment-intents', async (req, res) => {
    const { intent, created } = await tx(() => intents.createIntent(ctx, req.merchant, req.body || {}));
    res.status(created ? 201 : 200).json(await intents.serializeIntent(ctx, intent, { withInstructions: true }));
  });

  r.get('/payment-intents', async (req, res) => {
    const reference = req.query.reference;
    if (typeof reference !== 'string' || !reference) {
      throw new ApiError(400, 'missing_reference', 'Paramètre ?reference= obligatoire');
    }
    const row = await intents.findByReference(ctx, req.merchant.id, reference);
    if (!row) throw new ApiError(404, 'intent_not_found', 'Intention de paiement introuvable');
    res.json(await intents.serializeIntent(ctx, row, { withInstructions: true }));
  });

  r.get('/payment-intents/:id', async (req, res) => {
    const row = await intents.getMerchantIntent(ctx, req.merchant.id, req.params.id);
    res.json(await intents.serializeIntent(ctx, row, { withInstructions: true }));
  });

  r.post('/payment-intents/:id/cancel', async (req, res) => {
    const row = await tx(() => intents.cancelIntent(ctx, req.merchant.id, req.params.id));
    res.json(await intents.serializeIntent(ctx, row));
  });

  // --- Téléphones ---------------------------------------------------------------
  r.post('/devices/smsgate', async (req, res) => {
    const out = await tx(() => devices.createSmsGateDevice(ctx, req.merchant, req.body || {}));
    res.status(201).json({
      ...out,
      webhook_url: smsgate.webhookUrlFor(ctx, out.device.id, req),
      events: smsgate.EVENTS,
    });
  });

  r.get('/devices', async (req, res) => {
    res.json({ data: await devices.listDevices(ctx, req.merchant.id) });
  });

  r.post('/devices/:id/revoke', async (req, res) => {
    res.json(await tx(() => devices.revokeDevice(ctx, req.merchant.id, req.params.id)));
  });

  // --- Vérifications manuelles -----------------------------------------------
  r.get('/reviews', async (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : 'open';
    if (!['open', 'resolved', 'all'].includes(status)) throw new ApiError(400, 'invalid_status', 'status : open, resolved ou all');
    res.json({ data: await reviews.listReviews(ctx, req.merchant.id, { status, limit: req.query.limit }) });
  });

  r.get('/reviews/:id', async (req, res) => {
    res.json(await reviews.serializeReview(ctx, await reviews.getMerchantReview(ctx, req.merchant.id, req.params.id)));
  });

  r.post('/reviews/:id/resolve', async (req, res) => {
    const row = await tx(() => reviews.resolveReview(ctx, req.merchant.id, req.params.id, req.body || {}));
    res.json(await reviews.serializeReview(ctx, row));
  });

  // --- Journal : SMS reçus et webhooks ---------------------------------------
  r.get('/messages', async (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    res.json({ data: await ingest.listMessages(ctx, req.merchant.id, { status, limit: req.query.limit }) });
  });

  r.get('/events', async (req, res) => {
    const type = typeof req.query.type === 'string' ? req.query.type : undefined;
    res.json({ data: await events.listEvents(ctx, req.merchant.id, { type, limit: req.query.limit }) });
  });

  r.post('/events/:id/retry', async (req, res) => {
    res.json(await tx(() => events.retryEvent(ctx, req.merchant.id, req.params.id)));
  });

  return r;
}

module.exports = { merchantRoutes };
