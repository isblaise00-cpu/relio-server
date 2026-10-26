'use strict';

const express = require('express');
const { ApiError } = require('./lib/errors');
const { merchantRoutes } = require('./routes/merchant');
const { adminRoutes } = require('./routes/admin');
const { smsgateRoutes } = require('./routes/smsgate');

function createApp(ctx) {
  const app = express();
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);

  // On conserve le corps brut : la signature HMAC porte sur les octets exacts reçus.
  app.use(
    express.json({
      limit: '256kb',
      verify: (req, _res, buf) => {
        req.rawBody = buf.toString('utf8');
      },
    }),
  );

  if (!ctx.cfg.quiet) {
    app.use((req, res, next) => {
      const start = Date.now();
      res.on('finish', () => ctx.log.info(`${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - start} ms)`));
      next();
    });
  }

  app.get('/health', async (_req, res) => {
    await ctx.db.prepare('SELECT 1').get();
    res.json({ ok: true, time: new Date().toISOString() });
  });

  app.use('/v1', merchantRoutes(ctx));
  app.use('/gateway/smsgate', smsgateRoutes(ctx));
  app.use('/admin', adminRoutes(ctx));

  app.use((_req, _res, next) => next(new ApiError(404, 'not_found', 'Route introuvable')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof ApiError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, ...(err.details || {}) } });
    }
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: { code: 'invalid_json', message: 'Corps JSON invalide' } });
    }
    if (err.type === 'entity.too.large') {
      return res.status(413).json({ error: { code: 'payload_too_large', message: 'Corps de requête trop volumineux' } });
    }
    ctx.log.error(err);
    return res.status(500).json({ error: { code: 'internal_error', message: 'Erreur interne du serveur' } });
  });

  return app;
}

module.exports = { createApp };
