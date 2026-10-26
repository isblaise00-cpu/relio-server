'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const { createContext } = require('../src/context');
const { createApp } = require('../src/app');
const { createWorkers } = require('../src/workers');
const { truncateAll } = require('../src/db');
const parser = require('../src/services/parser');
const { SmsPayClient, verifyWebhook } = require('../clients/node/smspay-client');
const { hmacHex } = require('../src/lib/signing');

const ADMIN_TOKEN = 'test-admin-token-0123456789';

/** Paramètres de connexion MySQL pour les tests (surchargés par variables d'environnement). */
const TEST_DB = {
  dbHost: process.env.TEST_DB_HOST || '127.0.0.1',
  dbPort: parseInt(process.env.TEST_DB_PORT || '3306'),
  dbUser: process.env.TEST_DB_USER || 'root',
  dbPassword: process.env.TEST_DB_PASSWORD || '',
  dbName: process.env.TEST_DB_NAME || 'smspay_test',
};

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

/** Petit serveur qui reçoit les webhooks comme le ferait le site du marchand. */
async function startWebhookReceiver() {
  const received = [];
  let status = 200;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      received.push({ headers: req.headers, raw, body: JSON.parse(raw) });
      res.writeHead(status).end('ok');
    });
  });
  const port = await listen(server);
  return {
    url: `http://127.0.0.1:${port}/webhooks`,
    received,
    setStatus: (s) => (status = s),
    ofType: (type) => received.filter((r) => r.body.type === type),
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(r);
      }),
  };
}

async function startTestServer(overrides = {}) {
  const ctx = await createContext({ ...TEST_DB, quiet: true, adminToken: ADMIN_TOKEN, ...overrides });
  // Remet la base à zéro et resème les modèles SMS par défaut.
  await truncateAll(ctx.db);
  ctx.cache.templates = null;
  await parser.seedDefaultTemplates(ctx);

  const app = createApp(ctx);
  const server = http.createServer(app);
  const port = await listen(server);
  const workers = createWorkers(ctx);
  const baseUrl = `http://127.0.0.1:${port}`;
  const receivers = [];
  return {
    ctx,
    baseUrl,
    workers,
    receivers,
    close: async () => {
      // Ferme aussi les récepteurs de webhooks restés ouverts (ex. test en échec).
      await Promise.all(receivers.map((h) => h.close()));
      await new Promise((r) => {
        server.closeAllConnections();
        server.close(async () => {
          await ctx.db.close();
          r();
        });
      });
    },
  };
}

async function admin(baseUrl, method, path, body) {
  const res = await fetch(baseUrl + path, {
    method,
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

/** Envoie un webhook exactement comme le fait l'appli SMS Gateway for Android. */
async function smsgateWebhook(url, key, event, { timestamp, tamper, signature } = {}) {
  const raw = JSON.stringify(event);
  const ts = timestamp || Math.floor(Date.now() / 1000).toString();
  const sig = signature || hmacHex(key, raw + ts);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-signature': sig, 'x-timestamp': ts },
    body: tamper || raw,
  });
  return { status: res.status, body: await res.json() };
}

/**
 * Prépare un environnement complet : marchand, portefeuille Orange avec solde connu,
 * téléphone SMS Gateway, récepteur de webhooks.
 * Retourne { hooks, merchant, gate, wallet, webhookSecret, creds }
 */
async function setupMerchant(srv, { balance = 25000, walletPhone = '70000001', operator = 'orange' } = {}) {
  const hooks = await startWebhookReceiver();
  srv.receivers.push(hooks);
  const created = await admin(srv.baseUrl, 'POST', '/admin/merchants', { name: 'Boutique Test', webhook_url: hooks.url });
  if (created.status !== 201) throw new Error(`Création marchand : ${JSON.stringify(created.body)}`);
  const merchant = new SmsPayClient({ baseUrl: srv.baseUrl, apiKey: created.body.api_key, apiSecret: created.body.api_secret });
  const wallet = await merchant.createWallet({ operator, phone: walletPhone, balance });
  const gate = await merchant.createSmsGateDevice({ name: 'Tecno de test' });
  return { hooks, merchant, gate, wallet, webhookSecret: created.body.webhook_secret, creds: created.body };
}

/** Envoie un SMS via le webhook SMS Gateway et renvoie le résultat de traitement. */
async function sendSms(gate, sender, body, extra = {}) {
  const id = extra.id || crypto.randomUUID();
  const event = {
    id,
    event: 'sms:received',
    deviceId: gate.device.id,
    webhookId: 'test-sms',
    payload: {
      messageId: id,
      message: body,
      sender,
      recipient: '+22670000001',
      simNumber: 1,
      receivedAt: new Date(extra.received_at || Date.now()).toISOString(),
    },
  };
  const res = await smsgateWebhook(gate.webhook_url, gate.signing_key, event);
  if (res.status !== 200) throw new Error(`smsgateWebhook échoué (${res.status}): ${JSON.stringify(res.body)}`);
  return res.body.result;
}

module.exports = { ADMIN_TOKEN, startTestServer, startWebhookReceiver, setupMerchant, sendSms, smsgateWebhook, admin, verifyWebhook };
