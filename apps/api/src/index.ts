import { config } from './config.js';
import { assertDatabaseReady } from './db/preflight.js';
import { buildApp } from './server.js';

const app = await buildApp();
// refuse to serve when the DB role bypasses row-level security (tenant isolation)
await assertDatabaseReady({ warn: (message) => app.log.warn(message) });

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: config.PORT, host: config.HOST });
