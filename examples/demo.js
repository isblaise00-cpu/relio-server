'use strict';

/*
 * DÉMONSTRATION DE BOUT EN BOUT contre un serveur qui tourne.
 *
 *   Terminal 1 :  npm start
 *   Terminal 2 :  npm run demo
 *
 * Variables : SMSPAY_URL (défaut http://localhost:3000), ADMIN_TOKEN (comme le serveur).
 * La démo crée un marchand, un portefeuille, appaire un "téléphone" simulé, puis rejoue :
 *   1. un vrai paiement   -> confirmé automatiquement + webhook signé
 *   2. un faux SMS        -> mis en attente (solde incohérent), jamais confirmé
 */

const http = require('node:http');
const { SmsPayClient, DeviceClient, verifyWebhook } = require('../clients/node/smspay-client');
const samples = require('./sms-samples');

const BASE = process.env.SMSPAY_URL || `http://localhost:${process.env.PORT || 3000}`;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const HOOK_PORT = Number(process.env.DEMO_WEBHOOK_PORT || 4001);

const step = (n, txt) => console.log(`\n\x1b[1m${n}. ${txt}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!ADMIN_TOKEN) throw new Error('ADMIN_TOKEN manquant (doit être identique à celui du serveur)');

  // Récepteur de webhooks local, comme sur le site du marchand.
  const received = [];
  let webhookSecret = null;
  const hookServer = http
    .createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        try {
          const evt = verifyWebhook(webhookSecret, raw, req.headers);
          received.push(evt);
          console.log(`   📩 webhook reçu et signature vérifiée : ${evt.type}`);
          res.writeHead(200).end('ok');
        } catch (err) {
          console.log(`   ❌ webhook refusé : ${err.message}`);
          res.writeHead(400).end();
        }
      });
    })
    .listen(HOOK_PORT);

  step(1, 'Création du marchand (route admin)');
  const res = await fetch(`${BASE}/admin/merchants`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Boutique Démo Ouaga', webhook_url: `http://localhost:${HOOK_PORT}/webhooks` }),
  });
  const created = await res.json();
  if (!res.ok) throw new Error(`Création du marchand : ${JSON.stringify(created)}`);
  webhookSecret = created.webhook_secret;
  console.log(`   marchand ${created.merchant.id} — api_key ${created.api_key}`);
  const merchant = new SmsPayClient({ baseUrl: BASE, apiKey: created.api_key, apiSecret: created.api_secret });

  step(2, 'Déclaration du portefeuille Orange Money avec son solde actuel (25 000 FCFA)');
  const wallet = await merchant.createWallet({ operator: 'orange', phone: '70000001', balance: 25000 });
  console.log(`   ${wallet.phone} — solde de référence ${wallet.balance} FCFA`);

  step(3, 'Appairage du téléphone (ce que fera l\'application Android)');
  const { code } = await merchant.createPairingCode();
  console.log(`   code affiché au marchand : ${code}`);
  const { client: device, device_id } = await DeviceClient.pair(BASE, code, 'Tecno du magasin');
  const config = await device.getConfig();
  console.log(`   téléphone ${device_id} — expéditeurs surveillés : ${config.senders.join(', ')}`);

  const reference = `CMD-${Date.now()}`;
  step(4, `Le site e-commerce crée une intention de paiement (commande ${reference}, 10 000 FCFA)`);
  const intent = await merchant.createPaymentIntent({ reference, amount: 10000, payer_phone: '70123456' });
  console.log(`   ${intent.id} — ${intent.pay_to[0].message}`);

  step(5, 'Le client paie : le téléphone du marchand reçoit le SMS Orange Money et le transmet');
  const sms = samples.orangeCredit({ amount: 10000, payer: '70123456', balance: 35000, txn: samples.txnId() });
  console.log(`   SMS : « ${sms} »`);
  const [r1] = (await device.sendSms([{ id: `local-${Date.now()}-1`, sender: 'OrangeMoney', body: sms, received_at: Date.now() }])).results;
  console.log(`   traitement : ${r1.status}`);

  console.log('   attente du webhook…');
  for (let i = 0; i < 30 && !received.some((e) => e.type === 'payment_intent.succeeded'); i++) await sleep(500);
  const paid = await merchant.getPaymentIntent(intent.id);
  console.log(`   statut de l'intention : ${paid.status} (${paid.confirmation}) — transaction ${paid.transaction_id}`);

  step(6, 'Tentative de fraude : faux SMS avec le bon numéro et le bon montant, mais un solde inventé');
  const intent2 = await merchant.createPaymentIntent({ reference: `${reference}-B`, amount: 5000, payer_phone: '76000000' });
  const fake = samples.orangeCredit({ amount: 5000, payer: '76000000', balance: 999000, txn: samples.txnId() });
  const [r2] = (await device.sendSms([{ id: `local-${Date.now()}-2`, sender: 'OrangeMoney', body: fake, received_at: Date.now() }])).results;
  console.log(`   traitement : ${r2.status} (${r2.reasons.join(', ')})`);
  const still = await merchant.getPaymentIntent(intent2.id);
  console.log(`   statut de l'intention : ${still.status} → la commande n'est PAS validée`);
  console.log('   (après HOLD_SECONDS, ce SMS passera en vérification manuelle "suspected_fraud_balance")');

  const wallets = await merchant.listWallets();
  console.log(`\nSolde de référence final : ${wallets.data[0].balance} FCFA (35 000 attendus)`);
  console.log(`Webhooks reçus : ${received.map((e) => e.type).join(', ')}`);

  hookServer.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('\nÉchec de la démo :', err.message, err.body ? JSON.stringify(err.body) : '');
  process.exit(1);
});
