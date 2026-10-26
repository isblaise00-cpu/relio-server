# SmsPay — serveur MVP

Confirmation automatique de paiements **Orange Money** et **Moov Money** par lecture des SMS
de réception sur le téléphone du marchand. **L'argent va directement du client au marchand** :
le serveur ne détient jamais de fonds, il ne fait que détecter, vérifier et confirmer.

```
Site du marchand ──(1) intention signée──▶ Serveur SmsPay
Client ──(2) paie par USSD/appli──▶ SIM du marchand
Téléphone du marchand ──(3) SMS de l'opérateur──▶ Serveur SmsPay
Serveur SmsPay ──(4) webhook signé "payment_intent.succeeded"──▶ Site du marchand
Site du marchand ──(5) confirme au client
```

- Node.js **22.13 ou plus récent** (SQLite intégré, aucune base à installer)
- Une seule dépendance : `express`
- 63 tests automatisés

---

## 1. Démarrage rapide

```bash
npm install
cp .env.example .env        # puis éditer ADMIN_TOKEN (et MASTER_KEY en production)
npm test                    # lance les 63 tests
npm start                   # serveur sur http://localhost:3000
```

Dans un second terminal, la démonstration complète (vrai paiement + tentative de fraude) :

```bash
npm run demo
```

Créer un marchand en ligne de commande (sans API) :

```bash
npm run create-merchant -- --name "Boutique Kadi" --webhook-url https://boutique.bf/webhooks/smspay
```

Générer une `MASTER_KEY` (obligatoire en production) :

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## 2. Logique anti-fraude

Pour chaque SMS de **crédit**, le serveur se pose deux questions.

**Le SMS est-il authentique ?**

| Contrôle | En cas d'échec |
|---|---|
| Expéditeur connu (OrangeMoney, MoovMoney…) | rejeté |
| Format reconnu par un modèle | ignoré (promo, etc.) |
| ID de transaction jamais vu | échec **dur** |
| Continuité du solde : `ancien solde + montant = nouveau solde` | échec **souple** |

**Correspond-il à une intention ?** Même payeur, même montant, intention en attente et non
expirée, opérateur compatible, intention créée **avant** la réception du SMS.

| Authenticité | Correspondance | Résultat |
|---|---|---|
| ✅ | ✅ | `matched` → intention payée, webhook `payment_intent.succeeded` |
| ✅ | ❌ | `review` → vérification manuelle (paiement réel non rattaché) |
| solde incohérent | ✅ ou ❌ | `held` pendant `HOLD_SECONDS`, puis `review` (`suspected_fraud_balance` ou `balance_mismatch`) |
| ID déjà vu | ✅ | `review` (`suspected_fraud_duplicate`) |
| ID déjà vu | ❌ | `rejected` |

La continuité du solde est le contrôle le plus fort : un fraudeur connaît son numéro et le
montant de sa commande, mais **pas le solde du marchand**.

**SMS arrivés dans le désordre** : un SMS au solde incohérent est d'abord mis en attente. Dès
qu'un SMS authentique fait avancer le solde, les SMS en attente qui s'enchaînent correctement
sont retraités automatiquement.

**SMS de débit** (retraits, envois) : ils servent à garder le solde de référence à jour. Si un
débit ne s'enchaîne pas (SMS perdu), le portefeuille passe en `unsynced`, le marchand reçoit
`wallet.desynchronized`, et les crédits suivants vont en vérification jusqu'à une
resynchronisation (`POST /v1/wallets/:id/resync`) ou un rattachement manuel.

### Motifs de vérification manuelle

| `reason` | Signification |
|---|---|
| `unknown_payer` | Paiement authentique d'un numéro sans intention en cours |
| `amount_mismatch` | Montant différent de l'intention en cours de ce payeur |
| `late_payment` | Paiement reçu après expiration de l'intention |
| `operator_mismatch` | Reçu sur un autre opérateur que celui demandé |
| `sms_predates_intent` | SMS antérieur à la création de l'intention |
| `balance_unverified` | Pas de solde de référence (portefeuille non synchronisé) |
| `balance_mismatch` | Solde incohérent, aucune intention correspondante |
| `suspected_fraud_balance` | **Fraude probable** : correspond à une intention mais solde incohérent |
| `suspected_fraud_duplicate` | **Fraude probable** : ID de transaction déjà reçu |
| `wallet_not_found` | Aucun portefeuille configuré pour ce SMS |

C'est **le marchand** qui tranche (`attach`, `unrelated` ou `fraud`) : lui seul peut vérifier
dans son historique Orange/Moov que l'argent est réellement arrivé.

---

## 3. Authentification (HMAC)

Toutes les requêtes des marchands (`/v1/*`) et des téléphones (`/device/v1/*`, sauf `/pair`)
sont signées :

```
chaîne = timestamp + "\n" + nonce + "\n" + MÉTHODE + "\n" + chemin?query + "\n" + sha256_hex(corps_brut)
X-Signature = hex(HMAC-SHA256(secret, chaîne))
```

| En-tête | Marchand | Téléphone |
|---|---|---|
| Identifiant | `X-Api-Key: mk_…` | `X-Device-Id: dev_…` |
| `X-Timestamp` | Unix, en secondes | idem |
| `X-Nonce` | 16 à 64 caractères aléatoires, jamais réutilisé | idem |
| `X-Signature` | voir ci-dessus | idem |

Refusé si : horodatage hors de ±`SIGNATURE_TOLERANCE_S`, nonce déjà vu, signature invalide.
Le client prêt à l'emploi `clients/node/smspay-client.js` fait tout cela pour vous.

> ⚠️ La clé secrète ne doit **jamais** être dans le navigateur ou dans une appli mobile
> e-commerce. Seul le **serveur** du marchand appelle l'API.

---

## 4. API marchand (`/v1`)

### Intentions de paiement

**`POST /v1/payment-intents`**

```json
{
  "reference": "CMD-1001",
  "amount": 10000,
  "payer_phone": "70123456",
  "operator": "orange",
  "expires_in": 900,
  "metadata": { "client": "Awa" }
}
```

`operator`, `expires_in` (60 à 86 400 s, défaut 900) et `metadata` sont optionnels.
Réponse `201` (ou `200` si la même référence existe déjà avec les mêmes paramètres) :

```json
{
  "id": "pi_…",
  "status": "pending",
  "amount": 10000,
  "payer_phone": "+22670123456",
  "pay_to": [
    { "operator": "orange", "phone": "+22670000001", "amount": 10000,
      "message": "Envoyez exactement 10 000 FCFA par Orange Money depuis le numéro +22670123456 vers le +22670000001." }
  ],
  "expires_at": "…"
}
```

Erreurs utiles : `409 duplicate_pending_intent` (même payeur + même montant déjà en attente :
annulez, attendez, ou ajoutez quelques francs), `409 reference_conflict`, `409 no_wallet`.

Statuts : `pending` → `succeeded` | `expired` | `canceled`. Champ `confirmation` : `auto` ou `manual`.

| Route | Rôle |
|---|---|
| `GET /v1/payment-intents/:id` | Lire une intention |
| `GET /v1/payment-intents?reference=CMD-1001` | Retrouver par référence |
| `POST /v1/payment-intents/:id/cancel` | Annuler |

### Portefeuilles

| Route | Rôle |
|---|---|
| `POST /v1/wallets` `{ operator, phone, balance, label }` | Déclarer la SIM qui reçoit (indiquez le **solde actuel**) |
| `GET /v1/wallets` | Lister, avec solde de référence et `sync_status` |
| `POST /v1/wallets/:id/resync` `{ balance }` | Donner le solde réel après une désynchronisation |

### Téléphones

| Route | Rôle |
|---|---|
| `POST /v1/devices/pairing-codes` | Code à 6 chiffres (10 min) à saisir dans l'appli Android |
| `GET /v1/devices` | Liste, état en ligne, dernier signal de vie (batterie, réseau…) |
| `POST /v1/devices/:id/revoke` | Révoquer un téléphone perdu ou volé |

### Vérifications manuelles

| Route | Rôle |
|---|---|
| `GET /v1/reviews?status=open` | À traiter (`open`, `resolved`, `all`) |
| `GET /v1/reviews/:id` | Détail, avec le SMS complet |
| `POST /v1/reviews/:id/resolve` | `{ "action": "attach", "intent_id": "pi_…" }`, `{ "action": "unrelated" }` ou `{ "action": "fraud", "note": "…" }` |

Pour `attach`, `intent_id` est facultatif si la vérification propose une `candidate_intent_id`.

### Journal

| Route | Rôle |
|---|---|
| `GET /v1/messages?status=review` | SMS reçus et leur traitement |
| `GET /v1/events` | Webhooks envoyés, tentatives, erreurs |
| `POST /v1/events/:id/retry` | Renvoyer un webhook |
| `GET` / `PATCH /v1/merchant` | Lire ou changer `webhook_url` |

---

## 5. Webhooks

`POST` vers la `webhook_url` du marchand :

```
X-SmsPay-Event-Id: evt_…
X-SmsPay-Event-Type: payment_intent.succeeded
X-SmsPay-Timestamp: 1792253168
X-SmsPay-Signature: v1=<hex(HMAC-SHA256(webhook_secret, timestamp + "." + corps_brut))>
```

```json
{ "id": "evt_…", "type": "payment_intent.succeeded", "created_at": "…", "data": { … } }
```

| Type | Quand |
|---|---|
| `payment_intent.succeeded` | Paiement confirmé (`data.confirmation` = `auto` ou `manual`) |
| `payment_intent.expired` / `.canceled` | Délai dépassé / annulation |
| `review.created` / `review.resolved` | Vérification ouverte / tranchée |
| `wallet.desynchronized` | Le solde de référence n'est plus fiable |
| `device.paired` / `device.offline` / `device.online` | État du téléphone |

En cas d'échec (pas de réponse 2xx), nouvelles tentatives après 10 s, 30 s, 2 min, 10 min,
30 min, 1 h, 3 h, 6 h. Le marchand doit **vérifier la signature** (voir
`examples/webhook-receiver.js`) et traiter chaque `id` **une seule fois**.

---

## 6. API téléphone (`/device/v1`) — spécification pour l'appli Android

1. **Appairage** (non signé) : `POST /device/v1/pair` `{ "code": "611058", "name": "Tecno du magasin" }`
   → `{ "device_id", "device_secret", "merchant" }`. Stocker le secret dans l'Android Keystore.
2. **Configuration** : `GET /device/v1/config` → `{ "senders": [...], "heartbeat_interval_s": 60, "max_batch": 50 }`.
   L'appli ne doit transmettre **que** les SMS de ces expéditeurs (jamais les SMS personnels).
3. **Signal de vie** toutes les `heartbeat_interval_s` :
   `POST /device/v1/heartbeat` `{ "battery": 80, "charging": true, "network": "4G", "app_version": "1.0.0", "pending_queue": 0, "sims": [{ "slot": 0, "operator": "orange", "phone": "+22670000001" }] }`
4. **Envoi des SMS** (par lots de 1 à 50) :

```json
POST /device/v1/sms
{ "messages": [
  { "id": "uuid-local-unique", "sender": "OrangeMoney", "body": "Vous avez recu…",
    "received_at": 1792253168339, "sim_slot": 0, "sim_phone": "+22670000001" }
] }
```

Champ optionnel `source` : `live` (défaut, reçu en temps réel), `inbox_scan` (récupéré en
relisant la boîte de réception après une panne) ou `test` (mode test de l'appli : le SMS est
analysé et renvoyé avec le statut `test`, mais il n'est **jamais** rapproché d'un paiement et
ne touche pas au solde de référence).

Réponse, de quoi remplir le journal de l'appli :

```json
{ "results": [{
  "id": "uuid-local-unique", "sms_id": "sms_…", "source": "live",
  "status": "matched", "reasons": [],
  "intent_id": "pi_…", "intent_reference": "CMD-1042", "candidate_intent_reference": null,
  "parsed": { "operator": "orange", "kind": "credit", "amount": 15000, "fee": null,
              "payer_phone": "+22670123456", "transaction_id": "CI261017.1432.A81234" },
  "duplicate": false
}] }
```

Statuts : `matched` (payé), `review` (à vérifier, avec `candidate_intent_reference` si une
commande proche existe), `held` (solde incohérent, en attente), `recorded` (débit),
`ignored` (format non reconnu), `rejected`, `test`.
L'`id` local rend l'envoi **idempotent** : en cas de coupure, renvoyez sans crainte de doublon.
Gardez chaque SMS dans une file locale tant que le serveur n'a pas répondu.

---

## 6 bis. Utiliser « SMS Gateway for Android » à la place de l'appli maison

L'appli open source [SMS Gateway for Android](https://sms-gate.app) peut remplacer l'appli
Android maison. Elle ne sait pas s'appairer ni signer les requêtes comme `/device/v1/*` : le
serveur lui offre donc une route dédiée, `POST /gateway/smsgate/<device_id>`, qui reçoit ses
webhooks, vérifie leur signature et les transmet au même moteur anti-fraude.

**1. Déclarer le téléphone** (tableau de bord admin › fiche du marchand › « SMS Gateway », ou API) :

```bash
POST /v1/devices/smsgate   { "name": "Tecno du magasin" }
# -> { "device": {...}, "signing_key": "sgk_…", "webhook_url": "https://…/gateway/smsgate/dev_…",
#      "events": ["sms:received", "system:ping", "app:started"] }
```

Définissez `PUBLIC_BASE_URL` (ex. `https://pay.mondomaine.bf`) pour que `webhook_url` soit correcte
derrière un reverse proxy. La clé n'est affichée qu'une fois. Vous pouvez aussi fournir votre
propre clé (`"signing_key": "…"`, 16 caractères minimum), par exemple celle déjà affichée par l'appli.

**2. Dans l'appli SMS Gateway** : Réglages › Webhooks › *Signing Key* → collez la clé.
Activez aussi Réglages › *Ping* (signal de vie ; intervalle inférieur à `DEVICE_OFFLINE_AFTER_S`).

**3. Enregistrer les webhooks** (mode Cloud ; ajoutez `--api-url http://IP-du-téléphone:8080` en mode Local) :

```bash
npm run register-smsgate -- --user <utilisateur> --password <mot de passe> \
  --webhook-url https://pay.mondomaine.bf/gateway/smsgate/dev_…
```

Bon à savoir :

- SMS Gateway exige une URL de webhook en **HTTPS**.
- Elle transmet **tous** les SMS reçus. Le serveur ne garde que ceux des expéditeurs Mobile Money
  du marchand ; les SMS personnels sont refusés **avant** tout enregistrement.
- Une nouvelle tentative de SMS Gateway (même `messageId`) n'est jamais traitée deux fois.
- La clé SMS Gateway ne donne pas accès à l'API `/device/v1/*`.

---

## 7. Modèles de SMS — ⚠️ à adapter avant la production

Les formats de `parsers/default-templates.js` sont des **exemples illustratifs**. Ils ne
reproduisent pas forcément au caractère près les SMS réels d'Orange Money Burkina ou de Moov
Money Burkina. Collectez de vrais SMS (crédit **et** débit, en masquant les numéros), puis :

```bash
# Tester un SMS contre les modèles actifs (rien n'est enregistré)
curl -X POST localhost:3000/admin/parsers/test -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "content-type: application/json" -d '{"sender":"OrangeMoney","body":"…"}'

# Ajouter ou remplacer un modèle — pris en compte immédiatement, sans republier l'appli
curl -X PUT localhost:3000/admin/parsers/orange_bf_credit_v2 -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "content-type: application/json" -d @mon-modele.json
```

Groupes nommés obligatoires : crédit → `amount`, `payer`, `balance`, `txn_id` ;
débit → `amount`, `balance`, `txn_id` (+ `fee` optionnel). Le champ `example` est vérifié à
l'enregistrement : un modèle qui ne reconnaît pas son propre exemple est refusé.

---

## 8. Structure du projet

```
src/
  server.js            démarrage + arrêt propre
  app.js               Express, gestion des erreurs
  context.js, config.js, db.js (schéma SQLite)
  workers.js           tâches de fond (expiration, attente, hors ligne, webhooks)
  middleware/auth.js   HMAC marchand/téléphone, jeton admin
  routes/              merchant.js, device.js, admin.js
  services/
    ingest.js          ★ cœur : authenticité + rapprochement + décision
    intents.js         intentions de paiement et recherche de correspondance
    reviews.js         vérifications manuelles
    parser.js          analyse des SMS par modèles
    wallets.js, devices.js, merchants.js, events.js (webhooks)
  lib/                 signature, chiffrement, formats, identifiants
parsers/default-templates.js
clients/node/smspay-client.js   client autonome à donner aux marchands (+ simulateur de téléphone)
examples/              demo.js, webhook-receiver.js, sms-samples.js
scripts/create-merchant.js
test/                  63 tests (node:test)
```

---

## 9. Avant la production (hors périmètre du MVP)

- **Vrais modèles de SMS** Orange et Moov, crédit et débit (section 7).
- **HTTPS** obligatoire derrière un reverse proxy (Nginx, Caddy) ; définir `TRUST_PROXY`.
- **Base de données** : SQLite convient pour démarrer sur un seul serveur. Pour plusieurs
  instances, passer à PostgreSQL et n'exécuter les tâches de fond que sur une instance.
- **Sauvegardes** régulières de la base et de la `MASTER_KEY` (sans elle, les secrets sont illisibles).
- **Webhooks** : les URL internes (IP privées, localhost) sont bloquées en production (SSRF).
  Pour une protection totale contre le « DNS rebinding », faire sortir les webhooks par un proxy filtrant.
- **Limitation de débit** par clé API et par IP.
- **Interface marchand** (tableau de bord) pour les vérifications, appairages et portefeuilles.
- **Juridique** : faire valider le modèle « sans détention de fonds » au regard de
  l'instruction BCEAO n°001-01-2024, et déclarer le traitement des données à la CIL.
- **Supervision** : alertes si des webhooks échouent ou si un téléphone reste hors ligne.
