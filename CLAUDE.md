# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start                  # Start server on :3000
npm run dev                # Start with --watch (auto-restart on file changes)
npm test                   # Run all 63 tests (sequential, --test-concurrency=1)
npm run register-smsgate   # Register this server's webhooks in an SMS Gateway for Android app
npm run create-merchant    # CLI: create a merchant directly without API
npm run demo               # End-to-end demo: payment flow + fraud attempt
npm run webhook-receiver   # Run example webhook server
```

To run a single test file:
```bash
node --test test/unit.test.js
node --test test/payment-flow.test.js
node --test test/security-and-ops.test.js
node --test test/smsgate.test.js
```

No build step, no TypeScript, no linter — pure Node.js 22.13+ source.

Tests require a running MySQL instance. Set env vars before running:
```bash
export TEST_DB_HOST=127.0.0.1 TEST_DB_USER=root TEST_DB_PASSWORD=secret TEST_DB_NAME=smspay_test
```

## Architecture

**SmsPay** is an automated payment confirmation system for Mobile Money (Orange Money, Moov Money) in Burkina Faso. Merchants connect an Android device running SMS Gateway for Android; the server reads incoming SMS webhooks, detects valid payment credits, matches them to payment intents, and fires webhooks — all without holding funds.

### Request lifecycle

```
SMS Gateway for Android → POST /gateway/smsgate/<device_id>
                                ↓
                         smsgate.js (handleWebhook)
                           1. HMAC signature check (per-device key)
                           2. Sender filter: skip non-Mobile-Money SMS (no storage)
                                ↓
                         ingest.js (ingestOne)
                           3. Regex template matching → parse amount, payer, balance, txn_id
                           4. Duplicate txn_id check
                           5. Balance continuity: old_balance + amount == new_balance
                           6. Intent matching: same payer MSISDN, same amount, pending + not expired
                                ↓
                         Decision: matched → webhook | review → manual | held → retry | rejected
```

### Key source files

| File | Role |
|------|------|
| `src/server.js` | Entry point; wires Express routes, DB init, background workers |
| `src/app.js` | Express app factory + error handling |
| `src/config.js` | Loads all env vars with defaults via `loadConfig(overrides?)`; validates `MASTER_KEY` and `ADMIN_TOKEN` |
| `src/context.js` | Assembles the `ctx` object (db, config, …) passed to every service call |
| `src/db.js` | MySQL pool (`mysql2/promise`), async `Database` wrapper, `AsyncLocalStorage`-based `transaction()` |
| `src/workers.js` | Background loop: expire intents, promote held SMS, deliver webhooks |
| `src/routes/` | Express route handlers: `merchant.js` (`/v1/*`), `admin.js` (`/admin/*`), `smsgate.js` (`/gateway/smsgate/*`) |
| `src/services/ingest.js` | **Core**: SMS authentication, fraud detection, intent matching |
| `src/services/parser.js` | Regex template matching; parses credit vs. debit SMS fields |
| `src/services/intents.js` | Create/expire/match payment intents |
| `src/services/reviews.js` | Manual verification workflow for ambiguous cases |
| `src/services/events.js` | Webhook event queue with exponential backoff (8 retry levels) |
| `src/services/wallets.js` | Per-merchant SIM balance tracking per operator |
| `src/services/devices.js` | Device lifecycle (create/revoke/heartbeat/offline detection); `kind = 'smsgate'` |
| `src/services/merchants.js` | Merchant CRUD, secret management, webhook URL storage |
| `src/services/operators.js` | Operator (Orange/Moov) configs and sender whitelists; `merchant_operators` join maps operators to merchants |
| `src/services/smsgate.js` | Adapter for SMS Gateway for Android webhooks (`POST /gateway/smsgate/:deviceId`): signature check, sender filtering before storage, ping/app:started heartbeats |
| `src/lib/netguard.js` | SSRF protection for merchant webhook URLs |
| `src/middleware/auth.js` | HMAC-SHA256 request verification (merchant API, device API, admin) |
| `src/lib/vault.js` | AES-256-GCM encryption for secrets at rest |
| `src/lib/signing.js` | Canonical string construction + HMAC verification |
| `src/lib/ids.js` | Prefixed ID generation (`mk_`, `dev_`, `pi_`, `evt_`, …) |
| `src/lib/format.js` | Phone number normalization, FCFA amount parsing |
| `src/admin/dashboard.html` | Admin UI served at `/admin` |
| `parsers/default-templates.js` | Seed data: default Orange Money and Moov Money SMS regex templates |

### Authentication

All `/v1/*` (merchant) requests require HMAC-SHA256 signing:

- Canonical string: `timestamp\nnonce\nMETHOD\npath?query\nsha256(rawBody)`
- Anti-replay: nonce stored in `api_nonces` table + `SIGNATURE_TOLERANCE_S` window
- Admin routes (`/admin/*`): Bearer token with timing-safe comparison
- SMS Gateway webhooks (`/gateway/smsgate/*`): `HMAC(key, rawBody + timestamp)`

See `src/middleware/auth.js` and `src/lib/signing.js` for the implementation; `clients/node/smspay-client.js` is the canonical client reference.

### Fraud detection layers

1. **Sender whitelist** — SMS must come from known operator number
2. **Template matching** — SMS must match a registered regex template
3. **Duplicate txn_id** — Prevents replayed SMS
4. **Balance continuity** — `previous_balance + amount == new_balance` (strongest control)
5. **Held SMS** — If balance is incoherent, hold for `HOLD_SECONDS` then reprocess once the chain repairs

### Background workers

`src/workers.js` runs every `WORKER_INTERVAL_MS` (default 2s):
- Expire pending intents
- Promote held SMS when balance chain is repaired
- Mark devices offline after `DEVICE_OFFLINE_AFTER_S`
- Clean expired nonces
- Deliver webhook events with exponential backoff

### Environment variables

See `.env.example` for the full list. Critical ones:
- `MASTER_KEY` — 64 hex chars (32 bytes); required in production for AES-256-GCM secret encryption
- `ADMIN_TOKEN` — enables `/admin` routes when set; must be ≥ 32 chars in production
- `DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME` — MySQL connection (default: `root@127.0.0.1:3306/smspay`)
- `DEFAULT_COUNTRY_CODE` — default `226` (Burkina Faso)
- `PUBLIC_BASE_URL` — public HTTPS URL of this server; required to generate SMS Gateway webhook URLs
- `ALLOW_PRIVATE_WEBHOOKS` — default `false` in production; set `true` in dev to allow localhost webhook targets

### Database

MySQL 8+ via `mysql2/promise`. All service functions are `async`. The `transaction(db, fn)` helper in `src/db.js` uses `AsyncLocalStorage` to pass the transaction connection to nested service calls without changing function signatures. `fn` must be `async`.

### Tests

Tests use Node.js native `test` module. `test/helpers.js` provides:
- `startTestServer()` — connects to MySQL test DB, truncates all tables, seeds default templates
- `SmsPayClient` — HMAC-signing merchant client
- Webhook receiver mock (`startWebhookReceiver`)

Tests require a MySQL database (`smspay_test` by default). Configure via `TEST_DB_*` env vars.
Tests must run sequentially; always pass `--test-concurrency=1`.

### Examples and clients

- `clients/node/smspay-client.js` — Production-ready Node.js merchant client (HMAC signing, device pairing)
- `examples/demo.js` — Full end-to-end scenario (create merchant → pair device → send SMS → confirm)
- `examples/webhook-receiver.js` — Reference webhook handler with signature verification
- `scripts/create-merchant.js` — Bootstrap a merchant without the API
