'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { normalizePhone, parseAmount, parseTimestamp } = require('../src/lib/format');
const { createVault } = require('../src/lib/vault');
const { signRequest, signWebhook } = require('../src/lib/signing');
const { createContext } = require('../src/context');
const parser = require('../src/services/parser');
const samples = require('../examples/sms-samples');
const { verifyWebhook } = require('../clients/node/smspay-client');
const { truncateAll } = require('../src/db');

const TEST_DB = {
  dbHost: process.env.TEST_DB_HOST || '127.0.0.1',
  dbPort: parseInt(process.env.TEST_DB_PORT || '3306'),
  dbUser: process.env.TEST_DB_USER || 'root',
  dbPassword: process.env.TEST_DB_PASSWORD || '',
  dbName: process.env.TEST_DB_NAME || 'smspay_test',
};

describe('Numéros de téléphone', () => {
  test('normalise les formats burkinabè courants', () => {
    assert.equal(normalizePhone('70123456'), '22670123456');
    assert.equal(normalizePhone('70 12 34 56'), '22670123456');
    assert.equal(normalizePhone('+226 70 12 34 56'), '22670123456');
    assert.equal(normalizePhone('22670123456'), '22670123456');
    assert.equal(normalizePhone('0022670123456'), '22670123456');
  });

  test('rejette les numéros invalides', () => {
    assert.equal(normalizePhone(''), null);
    assert.equal(normalizePhone('abc'), null);
    assert.equal(normalizePhone('123'), null);
    assert.equal(normalizePhone('+2267012345'), null);
    assert.equal(normalizePhone(null), null);
  });
});

describe('Montants', () => {
  test('lit les montants écrits de différentes façons', () => {
    assert.equal(parseAmount('10000'), 10000);
    assert.equal(parseAmount('10 000'), 10000);
    assert.equal(parseAmount('10 000'), 10000);
    assert.equal(parseAmount('10.000'), 10000);
    assert.equal(parseAmount('1,250,000'), 1250000);
    assert.equal(parseAmount('25000.00'), 25000);
    assert.equal(parseAmount('abc'), null);
  });

  test('lit les horodatages en ms, secondes et ISO', () => {
    assert.equal(parseTimestamp(1760700000), 1760700000000);
    assert.equal(parseTimestamp(1760700000000), 1760700000000);
    assert.equal(parseTimestamp('2026-10-17T10:00:00Z'), Date.parse('2026-10-17T10:00:00Z'));
    assert.equal(parseTimestamp('pas une date'), null);
  });
});

describe('Chiffrement des secrets', () => {
  test('chiffre puis déchiffre', () => {
    const vault = createVault(crypto.randomBytes(32));
    const blob = vault.encrypt('sk_secret');
    assert.notEqual(blob, 'sk_secret');
    assert.equal(vault.decrypt(blob), 'sk_secret');
  });

  test('détecte une altération', () => {
    const vault = createVault(crypto.randomBytes(32));
    const buf = Buffer.from(vault.encrypt('sk_secret'), 'base64url');
    buf[buf.length - 1] ^= 1;
    assert.throws(() => vault.decrypt(buf.toString('base64url')));
  });
});

describe('Signatures', () => {
  test('la signature change si le corps change', () => {
    const base = { timestamp: '1760700000', nonce: 'abcdef0123456789', method: 'POST', path: '/v1/payment-intents' };
    const a = signRequest('secret', { ...base, rawBody: '{"amount":10000}' });
    const b = signRequest('secret', { ...base, rawBody: '{"amount":10001}' });
    assert.notEqual(a, b);
  });

  test('verifyWebhook (client) accepte une signature du serveur et refuse une falsification', () => {
    const ts = Math.floor(Date.now() / 1000).toString();
    const raw = JSON.stringify({ id: 'evt_1', type: 'payment_intent.succeeded' });
    const headers = { 'x-smspay-timestamp': ts, 'x-smspay-signature': signWebhook('whsec_x', ts, raw) };
    assert.equal(verifyWebhook('whsec_x', raw, headers).id, 'evt_1');
    assert.throws(() => verifyWebhook('whsec_x', raw.replace('evt_1', 'evt_2'), headers), /invalide/);
    assert.throws(() => verifyWebhook('autre_secret', raw, headers), /invalide/);
  });
});

describe('Analyse des SMS', () => {
  let ctx;
  before(async () => {
    ctx = await createContext({ ...TEST_DB, quiet: true, adminToken: 'test-admin-token-0123456789' });
    await truncateAll(ctx.db);
    ctx.cache.templates = null;
    await parser.seedDefaultTemplates(ctx);
  });
  after(async () => {
    await ctx.db.close();
  });

  test('Orange Money : crédit', async () => {
    const p = await parser.parseSms(ctx, 'OrangeMoney', samples.orangeCredit({ amount: 10000, payer: '70123456', balance: 35000, txn: 'CI261017.1530.A12345' }));
    assert.deepEqual(
      { op: p.operator, kind: p.kind, amount: p.amount, payer: p.payer, balance: p.balance, txn: p.txnId },
      { op: 'orange', kind: 'credit', amount: 10000, payer: '22670123456', balance: 35000, txn: 'CI261017.1530.A12345' },
    );
  });

  test('Orange Money : débit avec frais', async () => {
    const p = await parser.parseSms(ctx, 'Orange Money', samples.orangeDebit({ amount: 2000, fee: 50, balance: 32950, txn: 'CO261017.1600.B54321' }));
    assert.equal(p.kind, 'debit');
    assert.equal(p.amount, 2000);
    assert.equal(p.fee, 50);
    assert.equal(p.balance, 32950);
  });

  test('Moov Money : crédit avec numéro au format international', async () => {
    const p = await parser.parseSms(ctx, 'MoovMoney', samples.moovCredit({ amount: 5000, payer: '+226 60 12 34 56', balance: 20000, txn: 'MV261017123456' }));
    assert.equal(p.operator, 'moov');
    assert.equal(p.payer, '22660123456');
  });

  test('expéditeur inconnu => sender_not_allowed', async () => {
    const p = await parser.parseSms(ctx, '+22670000000', samples.orangeCredit({ amount: 1, payer: '70123456', balance: 1, txn: 'CI00000' }));
    assert.equal(p.error, 'sender_not_allowed');
  });

  test('message promotionnel de l\'opérateur => unrecognized_format', async () => {
    assert.equal((await parser.parseSms(ctx, 'OrangeMoney', 'Bonus 50% sur vos recharges ce week-end !')).error, 'unrecognized_format');
  });

  test('refuse un modèle sans groupe obligatoire ou dont l\'exemple ne passe pas', () => {
    assert.throws(
      () => parser.validateTemplate({ id: 'bad_1', operator: 'orange', kind: 'credit', senders: ['X'], pattern: 'recu (?<amount>\\d+)' }),
      /Groupe nommé obligatoire/,
    );
    assert.throws(
      () =>
        parser.validateTemplate({
          id: 'bad_2',
          operator: 'orange',
          kind: 'debit',
          senders: ['X'],
          pattern: 'envoye (?<amount>\\d+) solde (?<balance>\\d+) id (?<txn_id>\\w{5,})',
          example: 'texte qui ne correspond pas',
        }),
      /exemple/,
    );
  });
});
