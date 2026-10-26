'use strict';

const { createContext } = require('./context');
const { createApp } = require('./app');
const { createWorkers } = require('./workers');

async function main() {
  const ctx = await createContext();
  const app = createApp(ctx);
  const workers = createWorkers(ctx);

  const server = app.listen(ctx.cfg.port, (err) => {
    if (err) {
      ctx.log.error('Impossible de démarrer le serveur :', err);
      process.exit(1);
    }
    ctx.log.info(`SmsPay MVP à l'écoute sur http://localhost:${ctx.cfg.port}`);
    if (!ctx.cfg.adminToken) ctx.log.warn('ADMIN_TOKEN vide : les routes /admin sont désactivées.');
  });
  workers.start();

  const shutdown = (signal) => {
    ctx.log.info(`${signal} reçu, arrêt en cours…`);
    workers.stop();
    server.close(() => {
      ctx.db.close().then(() => process.exit(0)).catch(() => process.exit(1));
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Erreur fatale au démarrage :', err);
  process.exit(1);
});
