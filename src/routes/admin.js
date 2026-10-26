'use strict';

const path = require('node:path');
const express = require('express');
const { transaction } = require('../db');
const { ApiError } = require('../lib/errors');
const merchants = require('../services/merchants');
const wallets = require('../services/wallets');
const devices = require('../services/devices');
const operators = require('../services/operators');
const parser = require('../services/parser');
const events = require('../services/events');
const reviews = require('../services/reviews');
const smsgate = require('../services/smsgate');
const { adminAuth } = require('../middleware/auth');

function adminRoutes(ctx) {
  const r = express.Router();
  const tx = (fn) => transaction(ctx.db, fn);

  // Tableau de bord public (formulaire de connexion)
  r.get('/dashboard', (_req, res) => {
    res.sendFile(path.join(__dirname, '../admin/dashboard.html'));
  });

  r.use(adminAuth(ctx));

  // ─── Stats ────────────────────────────────────────────────────────────────

  r.get('/stats', async (_req, res) => {
    const todayMs = new Date().setHours(0, 0, 0, 0);
    const [totalMerchants, onlineDevices, totalDevices, todaySms, todayMatched, pendingWebhooks, failedWebhooks, openReviews, totalOperators] =
      await Promise.all([
        ctx.db.prepare("SELECT COUNT(*) as c FROM merchants WHERE status='active'").get(),
        ctx.db.prepare("SELECT COUNT(*) as c FROM devices WHERE status='active' AND offline_notified=0 AND last_seen_at IS NOT NULL").get(),
        ctx.db.prepare("SELECT COUNT(*) as c FROM devices WHERE status='active'").get(),
        ctx.db.prepare('SELECT COUNT(*) as c FROM sms_messages WHERE created_at >= ?').get(todayMs),
        ctx.db.prepare("SELECT COUNT(*) as c FROM sms_messages WHERE created_at >= ? AND status='matched'").get(todayMs),
        ctx.db.prepare("SELECT COUNT(*) as c FROM webhook_events WHERE status='pending'").get(),
        ctx.db.prepare("SELECT COUNT(*) as c FROM webhook_events WHERE status='failed'").get(),
        ctx.db.prepare("SELECT COUNT(*) as c FROM reviews WHERE status='open'").get(),
        ctx.db.prepare("SELECT COUNT(*) as c FROM operators WHERE active=1").get(),
      ]);
    res.json({
      merchants: totalMerchants.c,
      devices: { online: onlineDevices.c, total: totalDevices.c },
      today: { sms: todaySms.c, matched: todayMatched.c, success_rate: todaySms.c > 0 ? Math.round(todayMatched.c / todaySms.c * 100) : 0 },
      webhooks: { pending: pendingWebhooks.c, failed: failedWebhooks.c },
      reviews: openReviews.c,
      operators: totalOperators.c,
    });
  });

  r.get('/stats/chart', async (req, res) => {
    const days = Math.min(parseInt(req.query.days) || 7, 90);
    const daily = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - i);
      const next = new Date(d); next.setDate(next.getDate() + 1);
      const [total, matched] = await Promise.all([
        ctx.db.prepare('SELECT COUNT(*) as c FROM sms_messages WHERE created_at>=? AND created_at<?').get(d.getTime(), next.getTime()),
        ctx.db.prepare("SELECT COUNT(*) as c FROM sms_messages WHERE created_at>=? AND created_at<? AND status='matched'").get(d.getTime(), next.getTime()),
      ]);
      daily.push({ date: d.toISOString().slice(0, 10), total: total.c, matched: matched.c });
    }
    const byOperator = await ctx.db.prepare("SELECT operator, COUNT(*) as c FROM sms_messages WHERE operator IS NOT NULL GROUP BY operator ORDER BY c DESC").all();
    res.json({ daily, by_operator: byOperator });
  });

  // ─── Marchands ────────────────────────────────────────────────────────────

  r.post('/merchants', async (req, res) => {
    res.status(201).json(await tx(() => merchants.createMerchant(ctx, req.body || {})));
  });

  r.get('/merchants', async (_req, res) => {
    const rows = await ctx.db.prepare("SELECT * FROM merchants WHERE status != 'deleted' ORDER BY created_at DESC").all();
    const data = await Promise.all(rows.map(async (row) => {
      const m = merchants.serializeMerchant(row);
      m.devices = await devices.listDevices(ctx, row.id);
      m.operators = await operators.getMerchantOperators(ctx, row.id);
      return m;
    }));
    res.json({ data });
  });

  r.delete('/merchants/:id', async (req, res) => {
    const row = await ctx.db.prepare("SELECT * FROM merchants WHERE id=? AND status!='deleted'").get(req.params.id);
    if (!row) throw new ApiError(404, 'merchant_not_found', 'Marchand introuvable');
    await tx(() => merchants.deleteMerchant(ctx, req.params.id));
    res.json({ ok: true });
  });

  r.patch('/merchants/:id/webhooks', async (req, res) => {
    const row = await ctx.db.prepare("SELECT * FROM merchants WHERE id=? AND status='active'").get(req.params.id);
    if (!row) throw new ApiError(404, 'merchant_not_found', 'Marchand introuvable');
    res.json(await tx(() => merchants.updateMerchant(ctx, row, req.body || {})));
  });

  r.get('/merchants/:id/credentials', async (req, res) => {
    const row = await ctx.db.prepare("SELECT * FROM merchants WHERE id=? AND status!='deleted'").get(req.params.id);
    if (!row) throw new ApiError(404, 'merchant_not_found', 'Marchand introuvable');
    res.json({
      id: row.id,
      name: row.name,
      api_key: row.api_key,
      api_secret: ctx.vault.decrypt(row.api_secret_enc),
      webhook_secret: ctx.vault.decrypt(row.webhook_secret_enc),
    });
  });

  r.post('/merchants/:id/smsgate-devices', async (req, res) => {
    const row = await ctx.db.prepare("SELECT * FROM merchants WHERE id=? AND status='active'").get(req.params.id);
    if (!row) throw new ApiError(404, 'merchant_not_found', 'Marchand introuvable');
    const out = await tx(() => devices.createSmsGateDevice(ctx, row, req.body || {}));
    res.status(201).json({
      ...out,
      webhook_url: smsgate.webhookUrlFor(ctx, out.device.id, req),
      events: smsgate.EVENTS,
    });
  });

  // ─── Portefeuilles (admin) ────────────────────────────────────────────────

  r.get('/merchants/:id/wallets', async (req, res) => {
    const rows = await wallets.listWallets(ctx, req.params.id);
    const data = await Promise.all(rows.map(async (w) => {
      const row = await ctx.db.prepare(
        `SELECT COALESCE(SUM(pi.amount), 0) AS total FROM payment_intents pi
         INNER JOIN sms_messages s ON pi.sms_id = s.id
         WHERE pi.merchant_id = ? AND pi.status = 'succeeded' AND s.wallet_id = ?`,
      ).get(req.params.id, w.id);
      return { ...wallets.serializeWallet(w), total_collected: row ? Number(row.total) : 0 };
    }));
    res.json({ data });
  });

  r.post('/merchants/:id/wallets', async (req, res) => {
    const row = await ctx.db.prepare("SELECT * FROM merchants WHERE id=? AND status='active'").get(req.params.id);
    if (!row) throw new ApiError(404, 'merchant_not_found', 'Marchand introuvable');
    res.status(201).json(await tx(() => wallets.createWallet(ctx, row, req.body || {})));
  });

  r.post('/merchants/:id/wallets/:walletId/resync', async (req, res) => {
    const wallet = await wallets.getMerchantWallet(ctx, req.params.id, req.params.walletId);
    const balance = wallets.validateBalance((req.body || {}).balance);
    await wallets.setBalance(ctx, wallet.id, balance);
    const updated = await wallets.getWallet(ctx, wallet.id);
    const row = await ctx.db.prepare(
      `SELECT COALESCE(SUM(pi.amount), 0) AS total FROM payment_intents pi
       INNER JOIN sms_messages s ON pi.sms_id = s.id
       WHERE pi.merchant_id = ? AND pi.status = 'succeeded' AND s.wallet_id = ?`,
    ).get(req.params.id, wallet.id);
    res.json({ ...wallets.serializeWallet(updated), total_collected: row ? Number(row.total) : 0 });
  });

  r.delete('/merchants/:id/wallets/:walletId', async (req, res) => {
    await wallets.getMerchantWallet(ctx, req.params.id, req.params.walletId);
    await ctx.db.prepare('DELETE FROM wallets WHERE id = ? AND merchant_id = ?').run(req.params.walletId, req.params.id);
    res.json({ ok: true });
  });

  r.get('/merchants/:id/operators', async (req, res) => {
    res.json({ data: await operators.getMerchantOperators(ctx, req.params.id) });
  });

  r.put('/merchants/:id/operators', async (req, res) => {
    const row = await ctx.db.prepare("SELECT * FROM merchants WHERE id=? AND status='active'").get(req.params.id);
    if (!row) throw new ApiError(404, 'merchant_not_found', 'Marchand introuvable');
    const entries = (req.body || {}).operators;
    if (!Array.isArray(entries)) throw new ApiError(400, 'invalid_input', 'operators doit être un tableau');
    res.json({ data: await tx(() => operators.setMerchantOperators(ctx, req.params.id, entries)) });
  });

  // ─── Téléphones ───────────────────────────────────────────────────────────

  r.get('/devices', async (_req, res) => {
    const rows = await ctx.db.prepare(`
      SELECT d.*, m.name as merchant_name FROM devices d
      LEFT JOIN merchants m ON d.merchant_id = m.id
      WHERE d.status='active' ORDER BY d.last_seen_at DESC
    `).all();
    res.json({
      data: rows.map((row) => ({
        ...devices.serializeDevice(row),
        merchant_name: row.merchant_name,
        merchant_id: row.merchant_id,
      })),
    });
  });

  r.post('/devices/:id/revoke', async (req, res) => {
    const row = await ctx.db.prepare('SELECT * FROM devices WHERE id=?').get(req.params.id);
    if (!row) throw new ApiError(404, 'device_not_found', 'Téléphone introuvable');
    res.json(await tx(() => devices.revokeDevice(ctx, row.merchant_id, req.params.id)));
  });

  // ─── SMS ──────────────────────────────────────────────────────────────────

  r.get('/sms', async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;
    const where = []; const wparams = [];
    if (req.query.status) { where.push('s.status=?'); wparams.push(req.query.status); }
    if (req.query.merchant_id) { where.push('s.merchant_id=?'); wparams.push(req.query.merchant_id); }
    if (req.query.operator) { where.push('s.operator=?'); wparams.push(req.query.operator); }
    const wc = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const [rows, countRow] = await Promise.all([
      ctx.db.prepare(
        `SELECT s.*, m.name as merchant_name FROM sms_messages s
         LEFT JOIN merchants m ON s.merchant_id=m.id ${wc}
         ORDER BY s.created_at DESC, s.id DESC LIMIT ? OFFSET ?`
      ).all(...wparams, limit, offset),
      ctx.db.prepare(`SELECT COUNT(*) as total FROM sms_messages s ${wc}`).get(...wparams),
    ]);
    res.json({ data: rows, total: countRow.total, limit, offset });
  });

  // ─── Payment intents ──────────────────────────────────────────────────────

  r.get('/intents', async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;
    const where = []; const wparams = [];
    if (req.query.status) { where.push('p.status=?'); wparams.push(req.query.status); }
    if (req.query.merchant_id) { where.push('p.merchant_id=?'); wparams.push(req.query.merchant_id); }
    const wc = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const [rows, countRow] = await Promise.all([
      ctx.db.prepare(
        `SELECT p.*, m.name as merchant_name FROM payment_intents p
         LEFT JOIN merchants m ON p.merchant_id=m.id ${wc}
         ORDER BY p.created_at DESC, p.id DESC LIMIT ? OFFSET ?`
      ).all(...wparams, limit, offset),
      ctx.db.prepare(`SELECT COUNT(*) as total FROM payment_intents p ${wc}`).get(...wparams),
    ]);
    res.json({ data: rows.map((r) => ({ ...r, amount_fcfa: r.amount })), total: countRow.total, limit, offset });
  });

  // ─── Webhooks ────────────────────────────────────────────────────────────

  r.get('/webhooks', async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;
    const where = []; const wparams = [];
    if (req.query.status) { where.push('e.status=?'); wparams.push(req.query.status); }
    if (req.query.merchant_id) { where.push('e.merchant_id=?'); wparams.push(req.query.merchant_id); }
    const wc = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const [rows, countRow] = await Promise.all([
      ctx.db.prepare(
        `SELECT e.*, m.name as merchant_name FROM webhook_events e
         LEFT JOIN merchants m ON e.merchant_id=m.id ${wc}
         ORDER BY e.created_at DESC, e.id DESC LIMIT ? OFFSET ?`
      ).all(...wparams, limit, offset),
      ctx.db.prepare(`SELECT COUNT(*) as total FROM webhook_events e ${wc}`).get(...wparams),
    ]);
    res.json({ data: rows.map(events.serializeEvent), total: countRow.total, limit, offset });
  });

  r.post('/webhooks/:id/retry', async (req, res) => {
    const row = await ctx.db.prepare('SELECT * FROM webhook_events WHERE id=?').get(req.params.id);
    if (!row) throw new ApiError(404, 'event_not_found', 'Événement introuvable');
    res.json(await tx(() => events.retryEvent(ctx, row.merchant_id, req.params.id)));
  });

  // ─── Vérifications manuelles ─────────────────────────────────────────────

  r.get('/reviews', async (req, res) => {
    const status = req.query.status || 'open';
    const rows = await ctx.db.prepare(
      `SELECT r.*, m.name as merchant_name FROM reviews r
       LEFT JOIN merchants m ON r.merchant_id=m.id
       WHERE r.status=? ORDER BY r.created_at DESC LIMIT 100`
    ).all(status);
    res.json({ data: await Promise.all(rows.map((row) => reviews.serializeReview(ctx, row))) });
  });

  r.post('/reviews/:id/resolve', async (req, res) => {
    const row = await ctx.db.prepare('SELECT * FROM reviews WHERE id=?').get(req.params.id);
    if (!row) throw new ApiError(404, 'review_not_found', 'Vérification introuvable');
    res.json(await tx(() => reviews.resolveReview(ctx, row.merchant_id, req.params.id, req.body || {})));
  });

  // ─── Opérateurs ──────────────────────────────────────────────────────────

  r.get('/operators', async (_req, res) => {
    res.json({ data: await operators.listOperators(ctx) });
  });

  r.post('/operators', async (req, res) => {
    res.status(201).json(await tx(() => operators.createOperator(ctx, req.body || {})));
  });

  r.put('/operators/:id', async (req, res) => {
    res.json(await tx(() => operators.updateOperator(ctx, req.params.id, req.body || {})));
  });

  // ─── Templates SMS ────────────────────────────────────────────────────────

  r.get('/parsers', async (_req, res) => {
    res.json({ data: await parser.listTemplates(ctx) });
  });

  r.put('/parsers/:id', async (req, res) => {
    const body = { ...(req.body || {}), id: req.params.id };
    res.json(await parser.upsertTemplate(ctx, body));
  });

  r.delete('/parsers/:id', async (req, res) => {
    await tx(() => parser.deleteTemplate(ctx, req.params.id));
    res.json({ ok: true });
  });

  r.post('/parsers/test', async (req, res) => {
    const { sender, body } = req.body || {};
    if (typeof sender !== 'string' || typeof body !== 'string') {
      throw new ApiError(400, 'invalid_input', 'sender et body sont obligatoires');
    }
    res.json(await parser.parseSms(ctx, sender, body));
  });

  return r;
}

module.exports = { adminRoutes };
