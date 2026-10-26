'use strict';

/*
 * Crée un marchand directement en base (sans passer par l'API admin).
 *
 *   npm run create-merchant -- --name "Boutique Kadi" --webhook-url https://boutique.bf/webhooks/smspay
 */

const { createContext } = require('../src/context');
const merchants = require('../src/services/merchants');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

const name = arg('name');
if (!name) {
  console.error('Usage : npm run create-merchant -- --name "Nom du marchand" [--webhook-url https://…]');
  process.exit(1);
}

async function main() {
  const ctx = await createContext();
  const out = await merchants.createMerchant(ctx, { name, webhook_url: arg('webhook-url') });
  await ctx.db.close();

  console.log('\nMarchand créé. Conservez ces secrets : ils ne seront plus affichés.\n');
  console.log(`  merchant_id    : ${out.merchant.id}`);
  console.log(`  api_key        : ${out.api_key}`);
  console.log(`  api_secret     : ${out.api_secret}`);
  console.log(`  webhook_secret : ${out.webhook_secret}`);
  console.log(`  webhook_url    : ${out.merchant.webhook_url || '(aucune)'}\n`);
}

main().catch((err) => {
  console.error('Erreur :', err.message);
  process.exit(1);
});
