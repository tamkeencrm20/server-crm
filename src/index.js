import http from 'node:http';
import env from './config/env.js';
import logger from './utils/logger.js';
import { connectDatabase, disconnectDatabase } from './config/db.js';
import { createApp } from './app.js';
import { initRealtime } from './services/realtime.js';
import { startJobs } from './jobs/index.js';

async function main() {
  await connectDatabase();

  const app = createApp();
  const server = http.createServer(app);

  initRealtime(server);
  const tasks = startJobs();

  server.listen(env.PORT, () => {
    logger.info(`Tamkeen CRM API listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
    if (!env.metaConfigured) {
      logger.warn('Meta Lead Ads is not configured — the webhook will reject deliveries until META_APP_SECRET and META_VERIFY_TOKEN are set');
    }
  });

  const shutdown = async (signal) => {
    logger.info(`${signal} received, shutting down`);
    tasks.forEach((t) => t.stop());
    server.close(async () => {
      await disconnectDatabase();
      process.exit(0);
    });
    // Do not hang forever on a stuck connection.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

process.on('unhandledRejection', (reason) => logger.error('Unhandled rejection:', reason));
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception:', err);
  process.exit(1);
});

main().catch((err) => {
  logger.error('Failed to start the server', err);
  process.exit(1);
});
