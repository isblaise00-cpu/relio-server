'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startTestServer, setupMerchant, sendSms, smsgateWebhook, admin } = require('./helpers');
const { SmsPayClient } = require('../clients/node/smspay-client');
const { signRequest } = require('../src/lib/signing');
const samples = require('../examples/sms-samples');

async function rawSigned(baseUrl, { apiKey, secret, method, path, body, timestamp, nonce, tamperBody }) {
  const rawBody = body ? JSON.stringify(body) : '';
  const ts = timestamp || Math.floor(Date.now() / 1000).toString();
  const n = nonce || crypto.randomBytes(16).toString('hex');
  const sig = signRequest(secret, { timestamp: ts, nonce: n, method, path, rawBody });
  const res = await fetch(baseUrl + path, {
    method,
    headers: { 'x-api-key': apiKey, 'x-timestamp': ts, 'x-nonce': n, 'x-signature': sig, 'content-type': 'application/json' },
    body: tamperBody ? tamperBody : rawBody || undefined,
  });
  return { status: res.status, body: await res.json() };
}

describe('Sécurité de l\'API', () => {
  let srv;
  let env;
  before(async () => {
    srv = await startTestServer();
    env = await setupMerchant(srv);
  });
  after(async () => {
    await env.hooks.close();
    await srv.close();
  });

  const creds = () => ({ apiKey: env.creds.api_key, secret: env.creds.api_secret });

  test('requête sans signature => 401', async () => {
    const res = await fetch(`${srv.baseUrl}/v1/wallets`);
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.code, 'missing_auth');
  });

  test('mauvais secret => 401', async () => {
    const res = await rawSigned(srv.baseUrl, { apiKey: env.creds.api_key, secret: 'faux', method: 'GET', path: '/v1/wallets' });
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'invalid_signature');
  });

  test('corps modifié après signature => 401', async () => {
    const res = await rawSigned(srv.baseUrl, {
      ...creds(),
      method: 'POST',
      path: '/v1/payment-intents',
      body: { reference: 'X-1', amount: 100, payer_phone: '70123456' },
      tamperBody: JSON.stringify({ reference: 'X-1', amount: 1, payer_phone: '70123456' }),
    });
    assert.equal(res.status, 401);
  });

  test('rejeu d\'une requête (même nonce) => 401', async () => {
    const nonce = crypto.randomBytes(16).toString('hex');
    const ts = Math.floor(Date.now() / 1000).toString();
    const first = await rawSigned(srv.baseUrl, { ...creds(), method: 'GET', path: '/v1/wallets', nonce, timestamp: ts });
    assert.equal(first.status, 200);
    const replay = await rawSigned(srv.baseUrl, { ...creds(), method: 'GET', path: '/v1/wallets', nonce, timestamp: ts });
    assert.equal(replay.status, 401);
    assert.equal(replay.body.error.code, 'replayed_request');
  });

  test('requête trop ancienne => 401', async () => {
    const old = (Math.floor(Date.now() / 1000) - 3600).toString();
    const res = await rawSigned(srv.baseUrl, { ...creds(), method: 'GET', path: '/v1/wallets', timestamp: old });
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'stale_request');
  });

  test('un marchand ne voit pas les intentions d\'un autre', async () => {
    const other = await setupMerchant(srv);
    const intent = await env.merchant.createPaymentIntent({ reference: 'ISO-1', amount: 1234, payer_phone: '70123456' });
    await assert.rejects(other.merchant.getPaymentIntent(intent.id), { status: 404 });
    await other.hooks.close();
  });

  test('routes admin protégées par jeton', async () => {
    const res = await fetch(`${srv.baseUrl}/admin/merchants`, { headers: { authorization: 'Bearer mauvais' } });
    assert.equal(res.status, 401);
  });

  test('validation des entrées', async () => {
    await assert.rejects(env.merchant.createPaymentIntent({ reference: 'V-1', amount: -5, payer_phone: '70123456' }), { code: 'invalid_amount' });
    await assert.rejects(env.merchant.createPaymentIntent({ reference: 'V-2', amount: 100, payer_phone: '12' }), { code: 'invalid_payer_phone' });
    await assert.rejects(env.merchant.createPaymentIntent({ reference: 'V-3', amount: 100, payer_phone: '70123456', operator: 'wave' }), {
      code: 'invalid_operator',
    });
    await assert.rejects(env.merchant.createPaymentIntent({ amount: 100, payer_phone: '70123456' }), { code: 'invalid_reference' });
  });
});

describe('Téléphones et webhooks', () => {
  let srv;
  before(async () => {
    srv = await startTestServer();
  });
  after(async () => {
    await srv.close();
  });

  test('téléphone silencieux => webhook device.offline, puis device.online au retour', async () => {
    const env = await setupMerchant(srv);
    // Ping initial pour que last_seen_at soit renseigné (condition pour déclencher offline)
    await smsgateWebhook(env.gate.webhook_url, env.gate.signing_key, {
      id: crypto.randomUUID(), event: 'system:ping', payload: { health: { status: 'healthy' } },
    });

    await srv.workers.runOnce(Date.now() + (srv.ctx.cfg.deviceOfflineAfterS + 5) * 1000);
    assert.equal(env.hooks.ofType('device.offline').length, 1);

    await smsgateWebhook(env.gate.webhook_url, env.gate.signing_key, {
      id: crypto.randomUUID(), event: 'system:ping', payload: { health: { status: 'healthy' } },
    });
    await srv.workers.runOnce();
    assert.equal(env.hooks.ofType('device.online').length, 1);
    await env.hooks.close();
  });

  test('webhook en échec => nouvelles tentatives jusqu\'à succès', async () => {
    const env = await setupMerchant(srv, { balance: 1000 });
    env.hooks.setStatus(500);
    await env.merchant.createPaymentIntent({ reference: 'WH-1', amount: 500, payer_phone: '70123456' });
    await sendSms(env.gate, 'OrangeMoney', samples.orangeCredit({ amount: 500, payer: '70123456', balance: 1500, txn: samples.txnId() }));

    await srv.workers.runOnce();
    let [evt] = (await env.merchant.listEvents({ type: 'payment_intent.succeeded' })).data;
    assert.equal(evt.status, 'pending');
    assert.equal(evt.attempts, 1);
    assert.equal(evt.last_status_code, 500);

    env.hooks.setStatus(200);
    await srv.workers.runOnce(Date.now() + 11 * 1000);
    [evt] = (await env.merchant.listEvents({ type: 'payment_intent.succeeded' })).data;
    assert.equal(evt.status, 'delivered');
    assert.equal(evt.attempts, 2);
    assert.equal(env.hooks.ofType('payment_intent.succeeded').length, 2);
    await env.hooks.close();
  });

  test('mise à jour d\'un modèle de SMS via l\'API admin (sans republier l\'app)', async () => {
    const env = await setupMerchant(srv, { balance: 0 });
    const newFormat = 'Depot recu: 7500 F de 70123456. Solde 7500 F. TxRef XX99887766';
    await env.merchant.createPaymentIntent({ reference: 'TPL-1', amount: 7500, payer_phone: '70123456' });

    const before = await sendSms(env.gate, 'OrangeMoney', newFormat);
    assert.equal(before.status, 'ignored');

    const put = await admin(srv.baseUrl, 'PUT', '/admin/parsers/orange_bf_credit_v2', {
      operator: 'orange',
      kind: 'credit',
      senders: ['OrangeMoney'],
      priority: 20,
      pattern: String.raw`recu:\s*(?<amount>[\d\s]+?)\s*F\s+de\s+(?<payer>\d{8,11})\.\s*Solde\s+(?<balance>[\d\s]+?)\s*F\.\s*TxRef\s+(?<txn_id>[A-Z0-9]{6,})`,
      example: newFormat,
    });
    assert.equal(put.status, 200, JSON.stringify(put.body));

    const after = await sendSms(env.gate, 'OrangeMoney', newFormat.replace('XX99887766', 'XX99887767'));
    assert.equal(after.status, 'matched');
    await env.hooks.close();
  });
});

describe('Marchand supprimé', () => {
  let srv;
  before(async () => {
    srv = await startTestServer();
  });
  after(async () => {
    await srv.close();
  });

  test('marchand supprimé : ses webhooks en attente ne sont plus envoyés', async () => {
    const other = await setupMerchant(srv);
    await other.merchant.createPaymentIntent({ reference: 'DEL-1', amount: 500, payer_phone: '70123456' });
    const intent = await other.merchant.findPaymentIntent('DEL-1');
    await other.merchant.cancelPaymentIntent(intent.id);
    await admin(srv.baseUrl, 'DELETE', `/admin/merchants/${other.creds.merchant.id}`);
    await srv.workers.runOnce();
    assert.equal(other.hooks.ofType('payment_intent.canceled').length, 0);
    const row = await srv.ctx.db
      .prepare(`SELECT status FROM webhook_events WHERE merchant_id = ? AND type = 'payment_intent.canceled'`)
      .get(other.creds.merchant.id);
    assert.equal(row.status, 'no_endpoint');
  });
});

describe('Protection SSRF et configuration de production', () => {
  const { isPrivateIp, isObviouslyInternalHost, checkPublicUrl } = require('../src/lib/netguard');
  const { loadConfig } = require('../src/config');

  test('reconnaît les adresses internes', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.10', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
      assert.equal(isPrivateIp(ip), true, ip);
    }
    for (const ip of ['41.138.97.10', '8.8.8.8', '2001:4860:4860::8888']) assert.equal(isPrivateIp(ip), false, ip);
    assert.equal(isObviouslyInternalHost('localhost'), true);
    assert.equal(isObviouslyInternalHost('api.localhost'), true);
    assert.equal(isObviouslyInternalHost('[::1]'), true);
    assert.equal(isObviouslyInternalHost('boutique.bf'), false);
  });

  test('checkPublicUrl bloque les URL internes sans requête réseau', async () => {
    assert.equal(await checkPublicUrl('http://127.0.0.1:8080/hook'), 'blocked_internal_address');
    assert.equal(await checkPublicUrl('http://169.254.169.254/latest/meta-data'), 'blocked_internal_address');
    assert.equal(await checkPublicUrl('https://localhost/hook'), 'blocked_internal_address');
  });

  test('en production : webhook interne ou en http refusé à l\'enregistrement', async () => {
    const srv = await startTestServer({ nodeEnv: 'production', masterKey: 'a'.repeat(64), adminToken: 'x'.repeat(40), allowPrivateWebhooks: false });
    try {
      const headers = { authorization: `Bearer ${'x'.repeat(40)}`, 'content-type': 'application/json' };
      const post = (webhook_url) =>
        fetch(`${srv.baseUrl}/admin/merchants`, { method: 'POST', headers, body: JSON.stringify({ name: 'Test', webhook_url }) });
      assert.equal((await post('http://127.0.0.1:9000/hook')).status, 400);
      assert.equal((await post('https://192.168.1.20/hook')).status, 400);
      assert.equal((await post('http://boutique.example/hook')).status, 400);
      assert.equal((await post('https://boutique.example/hook')).status, 201);
    } finally {
      await srv.close();
    }
  });

  test('en production : ADMIN_TOKEN d\'exemple ou trop court refusé au démarrage', () => {
    const base = { nodeEnv: 'production', masterKey: 'a'.repeat(64), quiet: true };
    assert.throws(() => loadConfig({ ...base, adminToken: 'change-moi-avec-un-long-jeton-aleatoire' }), /ADMIN_TOKEN/);
    assert.throws(() => loadConfig({ ...base, adminToken: 'court' }), /ADMIN_TOKEN/);
    assert.doesNotThrow(() => loadConfig({ ...base, adminToken: 'z'.repeat(64) }));
    assert.throws(() => loadConfig({ nodeEnv: 'production', adminToken: 'z'.repeat(64), quiet: true, masterKey: '' }), /MASTER_KEY/);
  });
});
