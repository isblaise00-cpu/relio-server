'use strict';

/*
 * Exemple CÔTÉ MARCHAND : réception des webhooks SmsPay.
 *
 *   WEBHOOK_SECRET=whsec_xxx node examples/webhook-receiver.js
 *
 * Écoute sur http://localhost:4001/webhooks. Règles d'or :
 *   1. vérifier la signature sur le CORPS BRUT avant toute action ;
 *   2. répondre 2xx rapidement (sinon SmsPay renverra le webhook) ;
 *   3. être idempotent : le même événement (même id) peut arriver plusieurs fois.
 */

const http = require('node:http');
const { verifyWebhook } = require('../clients/node/smspay-client');

const SECRET = process.env.WEBHOOK_SECRET;
const PORT = Number(process.env.WEBHOOK_PORT || 4001);
if (!SECRET) {
  console.error('Définissez WEBHOOK_SECRET (le webhook_secret reçu à la création du marchand).');
  process.exit(1);
}

const alreadyProcessed = new Set(); // en production : une table en base

http
  .createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/webhooks') return res.writeHead(404).end();
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let event;
      try {
        event = verifyWebhook(SECRET, raw, req.headers);
      } catch (err) {
        console.warn('Webhook refusé :', err.message);
        return res.writeHead(400).end();
      }
      res.writeHead(200).end('ok');

      if (alreadyProcessed.has(event.id)) return;
      alreadyProcessed.add(event.id);

      switch (event.type) {
        case 'payment_intent.succeeded':
          console.log(`✅ Commande ${event.data.reference} payée (${event.data.amount} FCFA, transaction ${event.data.transaction_id}, ${event.data.confirmation})`);
          // -> marquer la commande comme payée, prévenir le client…
          break;
        case 'payment_intent.expired':
          console.log(`⌛ Commande ${event.data.reference} : délai de paiement dépassé`);
          break;
        case 'review.created':
          console.log(`⚠️  Vérification manuelle requise (${event.data.reason}) : ${event.data.reason_label}`);
          break;
        case 'device.offline':
          console.log(`📵 Le téléphone "${event.data.name}" ne répond plus !`);
          break;
        default:
          console.log(`Événement ${event.type}`);
      }
    });
  })
  .listen(PORT, () => console.log(`Récepteur de webhooks : http://localhost:${PORT}/webhooks`));
