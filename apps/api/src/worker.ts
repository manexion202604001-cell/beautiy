/**
 * Background worker: job queue consumer + periodic scheduler.
 * Run alongside the API: `pnpm --filter @salon/api dev:worker`
 */
import pino from 'pino';
import { config } from './config.js';
import { runWorker } from './jobs/queue.js';
import { schedulerTick } from './jobs/scheduler.js';
import './modules/index.js'; // registers job handlers, event subscribers, periodic tasks

const logger = pino({ level: config.LOG_LEVEL, ...(config.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty' } } : {}) });
const controller = new AbortController();

process.on('SIGTERM', () => controller.abort());
process.on('SIGINT', () => controller.abort());

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
