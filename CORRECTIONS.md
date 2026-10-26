# Corrections du 26/10/2026

## Nouveau : compatibilité « SMS Gateway for Android »

| Fichier | Changement |
|---|---|
| `src/services/smsgate.js` (nouveau) | Reçoit les webhooks de l'appli SMS Gateway, vérifie leur signature (`X-Signature`, `X-Timestamp`), filtre les SMS personnels **avant** enregistrement, transmet les SMS Orange/Moov au moteur existant, traite `system:ping` et `app:started` comme signaux de vie. |
| `src/routes/smsgate.js` (nouveau) | Route `POST /gateway/smsgate/<device_id>`. |
| `src/services/devices.js`, `src/db.js` | Nouveau type de téléphone `smsgate` (colonne `devices.kind`, ajoutée automatiquement aux bases existantes). La clé SMS Gateway ne donne pas accès à `/device/v1/*`. |
| `src/routes/merchant.js`, `src/routes/admin.js` | `POST /v1/devices/smsgate` et `POST /admin/merchants/:id/smsgate-devices` : déclarent le téléphone et renvoient l'URL de webhook + la clé de signature. |
| `scripts/register-smsgate-webhooks.js` (nouveau) | `npm run register-smsgate` : enregistre les webhooks dans l'appli SMS Gateway (modes Cloud, Local ou Privé). |
| `src/admin/dashboard.html` | Bouton « Connecter un téléphone » dans la fiche marchand. |

Mode d'emploi : README, section « 6 bis ».

## Sécurité

1. **Faille XSS du tableau de bord** : la version d'appli et les infos SIM envoyées par un téléphone sont maintenant échappées ; `esc()` échappe aussi l'apostrophe ; le nom du marchand n'est plus injecté dans un `onclick`.
2. **Configuration de production** : le serveur refuse de démarrer en production si `ADMIN_TOKEN` vaut la valeur d'exemple ou fait moins de 32 caractères (`MASTER_KEY` était déjà obligatoire).
3. **Webhooks modifiables par un téléphone** : `PATCH /device/v1/webhooks` répond 403 par défaut. Réactivable avec `ALLOW_DEVICE_WEBHOOK_UPDATE=true` si ton appli Android en a besoin.
4. **SSRF** (`src/lib/netguard.js`, nouveau) : en production, les URL de webhook vers localhost, les réseaux privés ou les métadonnées cloud sont refusées à l'enregistrement **et** revérifiées (DNS) avant chaque envoi ; le `https://` est obligatoire. Réglable avec `ALLOW_PRIVATE_WEBHOOKS`.

## Bugs

5. **Bouton « Résoudre » de l'admin** : il envoie maintenant `action` (`attach` / `unrelated` / `fraud`) et `intent_id`, comme l'API l'attend.
6. **`npm test`** : espace manquant dans `package.json` ; seuls les fichiers `test/*.test.js` sont lancés.
7. **`events.js`** : le marchand est vérifié avant d'être lu ; un marchand supprimé ne reçoit plus de webhooks (`no_endpoint`).

## Tests

63 tests, tous verts (`npm test`), dont 17 nouveaux dans `test/smsgate.test.js`.

## Variables d'environnement ajoutées (voir `.env.example`)

`PUBLIC_BASE_URL`, `ALLOW_DEVICE_WEBHOOK_UPDATE`, `ALLOW_PRIVATE_WEBHOOKS`.
