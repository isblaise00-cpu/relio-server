'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startTestServer, setupMerchant, admin } = require('./helpers');
const { hmacHex } = require('../src/lib/signing');
const samples = require('../examples/sms-samples');

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

function smsReceived(sender, message, extra = {}) {
  return {
    id: crypto.randomBytes(8).toString('hex'),
    event: 'sms:received',
    deviceId: 'ffffffffceb0b1db0000018e937c815b',
    webhookId: 'relio-sms-received',
    payload: {
      messageId: crypto.randomBytes(8).toString('hex'),
      message,
      sender,
      recipient: '+22670000001',
      simNumber: 1,
      receivedAt: new Date().toISOString(),
      ...extra,
    },
  };
}

describe('Adaptateur SMS Gateway for Android', () => {
  let srv;
  let env;
  let gate; // { device, signing_key, webhook_url }
  before(async () => {
    srv = await startTestServer();
    env = await setupMerchant(srv); // portefeuille Orange +22670000001, solde 25 000
    gate = await env.merchant.createSmsGateDevice({ name: 'Itel SMS Gateway' });
  });
  after(async () => {
    await srv.close();
  });

  test('déclaration du téléphone : URL de webhook, clé de signature et événements à enregistrer', () => {
    assert.equal(gate.device.kind, 'smsgate');
    assert.match(gate.webhook_url, new RegExp(`/gateway/smsgate/${gate.device.id}$`));
    assert.ok(gate.signing_key.length >= 32);
    assert.deepEqual(gate.events, ['sms:received', 'system:ping', 'app:started']);
  });

  test('clé de signature choisie par le marchand (copiée depuis l\'appli) acceptée, clé trop courte refusée', async () => {
    const custom = await env.merchant.createSmsGateDevice({ signing_key: 'cle-copiee-depuis-l-appli-123' });
    assert.equal(custom.signing_key, 'cle-copiee-depuis-l-appli-123');
    await assert.rejects(env.merchant.createSmsGateDevice({ signing_key: 'court' }), /signing_key/);
  });

  test('cas nominal : SMS Orange reçu via SMS Gateway => intention payée et webhook marchand', async () => {
    const intent = await env.merchant.createPaymentIntent({ reference: 'SG-1', amount: 7500, payer_phone: '70123456' });
    const body = samples.orangeCredit({ amount: 7500, payer: '70123456', balance: 32500, txn: samples.txnId() });
    const res = await smsgateWebhook(gate.webhook_url, gate.signing_key, smsReceived('OrangeMoney', body));
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'processed');
    assert.equal(res.body.result.status, 'matched');
    assert.equal(res.body.result.intent_id, intent.id);
    assert.equal(res.body.result.parsed.payer_phone, '+22670123456');

    await srv.workers.runOnce();
    const paid = env.hooks.ofType('payment_intent.succeeded');
    assert.equal(paid.length, 1);
    assert.equal(paid[0].body.data.reference, 'SG-1');
  });

  test('même webhook renvoyé (nouvelle tentative de SMS Gateway) => pas de double traitement', async () => {
    await env.merchant.createPaymentIntent({ reference: 'SG-2', amount: 1000, payer_phone: '70123456' });
    const event = smsReceived('OrangeMoney', samples.orangeCredit({ amount: 1000, payer: '70123456', balance: 33500, txn: samples.txnId() }));
    const first = await smsgateWebhook(gate.webhook_url, gate.signing_key, event);
    const again = await smsgateWebhook(gate.webhook_url, gate.signing_key, event);
    assert.equal(first.body.result.status, 'matched');
    assert.equal(again.body.result.duplicate, true);
    assert.equal(again.body.result.sms_id, first.body.result.sms_id);
  });

  test('SMS personnel : accepté (200) mais JAMAIS enregistré', async () => {
    const before = (await env.merchant.listMessages({ limit: 200 })).data.length;
    const res = await smsgateWebhook(gate.webhook_url, gate.signing_key, smsReceived('+22676543210', 'Salut, on se voit ce soir ?'));
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'skipped');
    const after = (await env.merchant.listMessages({ limit: 200 })).data;
    assert.equal(after.length, before);
    assert.ok(!after.some((m) => m.sender === '+22676543210'));
  });

  test('signature invalide, corps modifié, webhook trop ancien ou téléphone inconnu => 401', async () => {
    const event = smsReceived('OrangeMoney', 'test');
    assert.equal((await smsgateWebhook(gate.webhook_url, 'mauvaise-cle', event)).status, 401);
    assert.equal((await smsgateWebhook(gate.webhook_url, gate.signing_key, event, { tamper: JSON.stringify({ ...event, x: 1 }) })).status, 401);
    const old = (Math.floor(Date.now() / 1000) - 3600).toString();
    const stale = await smsgateWebhook(gate.webhook_url, gate.signing_key, event, { timestamp: old });
    assert.equal(stale.status, 401);
    assert.equal(stale.body.error.code, 'stale_request');
    const unknown = gate.webhook_url.replace(gate.device.id, 'dev_inconnu');
    assert.equal((await smsgateWebhook(unknown, gate.signing_key, event)).status, 401);
    const noHeaders = await fetch(gate.webhook_url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(noHeaders.status, 401);
  });

  test('system:ping et app:started => téléphone en ligne, cartes SIM visibles', async () => {
    const ping = await smsgateWebhook(gate.webhook_url, gate.signing_key, {
      id: 'p1', event: 'system:ping', payload: { health: { status: 'healthy' } },
    });
    assert.equal(ping.status, 200);
    const started = await smsgateWebhook(gate.webhook_url, gate.signing_key, {
      id: 's1',
      event: 'app:started',
      payload: { simCards: [{ slotIndex: 0, simNumber: 1, phoneNumber: '+22670000001', carrierName: 'Orange BF' }] },
    });
    assert.equal(started.status, 200);
    const dev = (await env.merchant.listDevices()).data.find((d) => d.id === gate.device.id);
    assert.equal(dev.online, true);
    assert.equal(dev.last_heartbeat.sims[0].carrier_name, 'Orange BF');
    assert.equal(dev.last_heartbeat.source, 'smsgate');
  });

  test('autres événements (sms:sent…) acceptés et ignorés, pour éviter les nouvelles tentatives', async () => {
    const res = await smsgateWebhook(gate.webhook_url, gate.signing_key, { id: 'x', event: 'sms:sent', payload: {} });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ignored');
  });

  test('téléphone révoqué => ses webhooks sont refusés', async () => {
    const other = await env.merchant.createSmsGateDevice({ name: 'À révoquer' });
    await env.merchant.revokeDevice(other.device.id);
    const res = await smsgateWebhook(other.webhook_url, other.signing_key, smsReceived('OrangeMoney', 'x'));
    assert.equal(res.status, 401);
  });

  test('création depuis l\'admin', async () => {
    const res = await admin(srv.baseUrl, 'POST', `/admin/merchants/${env.creds.merchant.id}/smsgate-devices`, { name: 'Admin' });
    assert.equal(res.status, 201);
    assert.equal(res.body.device.kind, 'smsgate');
    assert.ok(res.body.signing_key);
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
