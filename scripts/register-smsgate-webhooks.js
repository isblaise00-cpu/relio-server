'use strict';

/*
 * Enregistre dans l'appli « SMS Gateway for Android » les webhooks qui envoient
 * les SMS reçus (et les signaux de vie) vers ce serveur.
 *
 * Mode Cloud (téléphone connecté à api.sms-gate.app) :
 *   npm run register-smsgate -- --user ABC123 --password xyz \
 *     --webhook-url https://pay.mondomaine.bf/gateway/smsgate/dev_xxx
 *
 * Mode Local (serveur intégré au téléphone, même réseau) :
 *   npm run register-smsgate -- --api-url http://192.168.1.50:8080 --user sms --password xyz \
 *     --webhook-url https://pay.mondomaine.bf/gateway/smsgate/dev_xxx
 *
 * Mode Serveur privé : --api-url https://votre-domaine/api/3rdparty/v1
 *
 * Options :
 *   --api-url      URL de base de l'API SMS Gateway (défaut : https://api.sms-gate.app/3rdparty/v1)
 *   --user         nom d'utilisateur affiché dans l'appli (onglet Home)
 *   --password     mot de passe affiché dans l'appli
 *   --webhook-url  URL renvoyée par POST /v1/devices/smsgate (ou le tableau de bord admin)
 *   --device-id    (Cloud/Privé, facultatif) identifiant SMS Gateway du téléphone, si le compte en a plusieurs
 *   --events       liste séparée par des virgules (défaut : sms:received,system:ping,app:started)
 *   --list         affiche seulement les webhooks déjà enregistrés
 */

const DEFAULT_API = 'https://api.sms-gate.app/3rdparty/v1';
const DEFAULT_EVENTS = ['sms:received', 'system:ping', 'app:started'];

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

async function call(api, auth, method, path, body) {
  const res = await fetch(`${api}${path}`, {
    method,
    headers: { authorization: auth, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) throw new Error(`${method} ${path} -> HTTP ${res.status} : ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  return data;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const api = String(args['api-url'] || DEFAULT_API).replace(/\/+$/, '');
  if (!args.user || !args.password) {
    console.error('Usage : npm run register-smsgate -- --user <utilisateur> --password <mot de passe> --webhook-url <url> [--api-url <url>]');
    process.exit(1);
  }
  const auth = `Basic ${Buffer.from(`${args.user}:${args.password}`).toString('base64')}`;

  if (args.list) {
    console.log(JSON.stringify(await call(api, auth, 'GET', '/webhooks'), null, 2));
    return;
  }

  const webhookUrl = args['webhook-url'];
  if (!webhookUrl || !/^https:\/\//.test(webhookUrl)) {
    console.error('--webhook-url est obligatoire et doit commencer par https:// (exigence de SMS Gateway).');
    process.exit(1);
  }
  const events = args.events ? String(args.events).split(',').map((e) => e.trim()).filter(Boolean) : DEFAULT_EVENTS;

  for (const event of events) {
    // Identifiant fixe : relancer le script met à jour le webhook au lieu d'en créer un doublon.
    const body = { id: `relio-${event.replace(/[^a-z0-9]+/gi, '-')}`, url: webhookUrl, event };
    if (args['device-id']) body.deviceId = args['device-id'];
    const out = await call(api, auth, 'POST', '/webhooks', body);
    console.log(`✓ ${event} -> ${webhookUrl}${out && out.id ? ` (id ${out.id})` : ''}`);
  }
  console.log('\nPensez à activer le « Ping » dans l\'appli (Réglages > Ping) pour que le serveur sache que le téléphone est en ligne.');
}

main().catch((err) => {
  console.error(`✗ ${err.message}`);
  process.exit(1);
});
