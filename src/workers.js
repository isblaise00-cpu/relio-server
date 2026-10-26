'use strict';

const { transaction } = require('./db');
const intents = require('./services/intents');
const ingest = require('./services/ingest');
const devices = require('./services/devices');
const events = require('./services/events');

/**
 * Tâches de fond, exécutées toutes les WORKER_INTERVAL_MS :
 *  - expiration des intentions de paiement
 *  - passage en vérification des SMS restés "en attente"
 *  - détection des téléphones hors ligne
 *  - nettoyage des nonces
 *  - envoi des webhooks (avec nouvelles tentatives)
 */
function createWorkers(ctx) {
  let timer = null;
  let running = false;

  async function runOnce(now = Date.now()) {
    await transaction(ctx.db, () => intents.expireDue(ctx, now));
    await ingest.promoteHeld(ctx, now);
    await transaction(ctx.db, () => devices.markOffline(ctx, now));
    await ctx.db.prepare('DELETE FROM api_nonces WHERE expires_at < ?').run(Date.now());
    await events.deliverDue(ctx, now);
  }

  async function tick() {
    if (running) return;
    running = true;
    try {
      await runOnce();
    } catch (err) {
      ctx.log.error('Erreur dans les tâches de fond :', err);
    } finally {
      running = false;
    }
  }

  return {
    runOnce,
    start() {
      if (!timer) timer = setInterval(tick, ctx.cfg.workerIntervalMs);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

module.exports = { createWorkers };
