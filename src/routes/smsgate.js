'use strict';

const express = require('express');
const smsgate = require('../services/smsgate');

/**
 * Webhooks envoyés par l'appli « SMS Gateway for Android ».
 * Une URL par téléphone : POST /gateway/smsgate/<device_id>
 */
function smsgateRoutes(ctx) {
  const r = express.Router();

  r.post('/:deviceId', async (req, res) => {
    const device = await smsgate.authenticate(ctx, {
      deviceId: req.params.deviceId,
      signature: req.get('x-signature'),
      timestamp: req.get('x-timestamp'),
      rawBody: req.rawBody,
    });
    res.json({ ok: true, ...await smsgate.handleWebhook(ctx, device, req.body) });
  });

  return r;
}

module.exports = { smsgateRoutes };
