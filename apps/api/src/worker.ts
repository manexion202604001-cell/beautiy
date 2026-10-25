/**
 * Background worker: job queue consumer + periodic scheduler.
 * Run alongside the API: `pnpm --filter @salon/api dev:worker`
 */
import pino from 'pino';
import { config } from './config.js';
import { pendingMigrations } from './db/migrate.js';
import { assertDatabaseReady } from './db/preflight.js';
import { runWorker } from './jobs/queue.js';
import { schedulerTick } from './jobs/scheduler.js';
import './modules/index.js'; // registers job handlers, event subscribers, periodic tasks

const logger = pino({ level: config.LOG_LEVEL, ...(config.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty' } } : {}) });
// refuse to process jobs when the DB role bypasses row-level security (tenant isolation)
await assertDatabaseReady({ warn: (message) => logger.warn(message) });
const controller = new AbortController();

process.on('SIGTERM', () => controller.abort());
process.on('SIGINT', () => controller.abort());

// a new build may start before its migrations ran (they run with the API's deploy): wait for them
// instead of failing every job on a missing column
for (;;) {
  const pending = await pendingMigrations().catch((err: unknown) => {
    logger.error({ err }, 'could not check migrations');
    return ['(unknown)'];
  });
  if (!pending.length || controller.signal.aborted) break;
  logger.warn({ pending }, 'waiting for database migrations before processing jobs');
  await new Promise((resolve) => setTimeout(resolve, 30_000));
}
if (controller.signal.aborted) process.exit(0);

const scheduler = setInterval(() => {
  schedulerTick()
    .then((names) => names.length && logger.info({ names }, 'periodic jobs enqueued'))
    .catch((err) => logger.error({ err }, 'scheduler tick failed'));
}, 30_000);
void schedulerTick().catch((err) => logger.error({ err }, 'scheduler tick failed'));

logger.info({ concurrency: config.WORKER_CONCURRENCY }, 'worker started');
await runWorker({ concurrency: config.WORKER_CONCURRENCY, pollMs: config.WORKER_POLL_MS, logger, signal: controller.signal });
clearInterval(scheduler);
logger.info('worker stopped');
process.exit(0);
