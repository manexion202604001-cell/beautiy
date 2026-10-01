import { hostname } from 'node:os';
import { sql } from 'kysely';
import { systemActor, type Ctx } from '../auth/actor.js';
import { withSystem, withTenant, type Tx } from '../db/tenant.js';
import type { Database } from '../db/client.js';

/**
 * Durable job queue on Postgres (FOR UPDATE SKIP LOCKED).
 *  - enqueue() inside a business transaction => job exists iff the business change committed (outbox)
 *  - exponential backoff with jitter; after max_attempts the job moves to 'dead' (DLQ, see ops module)
 *  - dedupe_key prevents duplicate QUEUED jobs (a change committed while the same job is running
 *    enqueues a fresh run instead of being lost)
 */
export interface JobSpec {
  type: string;
  payload?: Record<string, unknown>;
  organizationId?: string | null;
  runAt?: Date;
  dedupeKey?: string;
  maxAttempts?: number;
  priority?: number;
  queue?: string;
  traceId?: string | null;
}

export interface JobRow {
  id: string;
  organization_id: string | null;
  type: string;
  payload: unknown;
  attempts: number;
  max_attempts: number;
  trace_id: string | null;
}

export interface JobContext {
  job: JobRow;
  organizationId: string | null;
  /** open a tenant transaction (system actor) for this job's organization */
  tx<T>(fn: (ctx: Ctx) => Promise<T>): Promise<T>;
}

export type JobHandler<P = any> = (payload: P, jc: JobContext) => Promise<void>;

/** Throw to retry later without counting as an error log spam (e.g. provider rate limit) */
export class RetryLaterError extends Error {
  constructor(message: string, readonly delayMs: number) {
    super(message);
  }
}

/** Throw to fail permanently (moves straight to DLQ) */
export class PermanentJobError extends Error {}

const handlers = new Map<string, JobHandler>();

export function registerJob<P>(type: string, handler: JobHandler<P>) {
  if (handlers.has(type)) throw new Error(`Job handler already registered: ${type}`);
  handlers.set(type, handler as JobHandler);
}

export function registeredJobTypes(): string[] {
  return [...handlers.keys()];
}

export async function enqueue(trxOrCtx: Tx | Ctx, spec: JobSpec): Promise<string | null> {
  const trx = 'trx' in trxOrCtx ? trxOrCtx.trx : trxOrCtx;
  const orgId =
    spec.organizationId !== undefined ? spec.organizationId : 'actor' in trxOrCtx ? trxOrCtx.actor.organizationId : null;
  const traceId = spec.traceId ?? ('meta' in trxOrCtx ? trxOrCtx.meta.traceId : null) ?? null;
  const row = await trx
    .insertInto('jobs')
    .values({
      organization_id: orgId,
      type: spec.type,
      payload: JSON.stringify(spec.payload ?? {}),
      run_at: spec.runAt ?? new Date(),
      dedupe_key: spec.dedupeKey ?? null,
      max_attempts: spec.maxAttempts ?? 8,
      priority: spec.priority ?? 0,
      queue: spec.queue ?? 'default',
      trace_id: traceId,
    })
    .onConflict((oc) =>
      oc
        .column('dedupe_key')
        .where(sql<boolean>`dedupe_key IS NOT NULL AND state = 'queued'`)
        .doNothing(),
    )
    .returning('id')
    .executeTakeFirst();
  return row?.id ?? null;
}

/** Cancel queued jobs by dedupe key prefix (e.g. reminders of a cancelled appointment) */
export async function cancelJobs(trx: Tx, dedupeKeyPrefix: string): Promise<number> {
  const res = await trx
    .updateTable('jobs')
    .set({ state: 'cancelled', finished_at: new Date() })
    .where('state', '=', 'queued')
    .where('dedupe_key', 'like', `${dedupeKeyPrefix}%`)
    .executeTakeFirst();
  return Number(res.numUpdatedRows);
}

export function backoffMs(attempt: number): number {
  const base = Math.min(5_000 * 2 ** (attempt - 1), 60 * 60 * 1000);
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

const workerId = `${hostname()}:${process.pid}`;

async function claim(limit: number, queues: string[], db?: Database): Promise<JobRow[]> {
  return withSystem(
    async (trx) => {
      const res = await sql<JobRow>`
        UPDATE jobs SET state = 'running', locked_by = ${workerId}, locked_at = now(), attempts = attempts + 1
        WHERE id IN (
          SELECT id FROM jobs
          WHERE state = 'queued' AND run_at <= now() AND queue = ANY(${queues})
          ORDER BY priority DESC, run_at
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id, organization_id, type, payload, attempts, max_attempts, trace_id`.execute(trx);
      return res.rows;
    },
    { db },
  );
}

async function finish(job: JobRow, error: unknown, db?: Database): Promise<void> {
  await withSystem(
    async (trx) => {
      if (!error) {
        await trx
          .updateTable('jobs')
          .set({ state: 'succeeded', finished_at: new Date(), locked_by: null, last_error: null })
          .where('id', '=', job.id)
          .execute();
        return;
      }
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      const permanent = error instanceof PermanentJobError;
      const dead = permanent || job.attempts >= job.max_attempts;
      const delay = error instanceof RetryLaterError ? error.delayMs : backoffMs(job.attempts);
      await trx
        .updateTable('jobs')
        .set({
          state: dead ? 'dead' : 'queued',
          last_error: message.slice(0, 4000),
          locked_by: null,
          run_at: dead ? undefined : new Date(Date.now() + delay),
          finished_at: dead ? new Date() : null,
        })
        .where('id', '=', job.id)
        .execute();
    },
    { db },
  );
}

export async function runJob(job: JobRow, db?: Database, logger?: { error: (o: object, m: string) => void }): Promise<boolean> {
  const handler = handlers.get(job.type);
  let error: unknown = null;
  if (!handler) {
    error = new PermanentJobError(`No handler registered for job type ${job.type}`);
  } else {
    const jc: JobContext = {
      job,
      organizationId: job.organization_id,
      tx: (fn) => {
        if (!job.organization_id) throw new PermanentJobError('Job has no organization');
        const orgId = job.organization_id;
        return withTenant(
          orgId,
          (trx) => fn({ actor: systemActor(orgId, `job:${job.type}`), trx, meta: { traceId: job.trace_id ?? job.id } }),
          { db, traceId: job.trace_id ?? job.id },
        );
      },
    };
    try {
      await handler(job.payload as Record<string, unknown>, jc);
    } catch (err) {
      error = err;
      logger?.error({ err, jobId: job.id, type: job.type, attempt: job.attempts }, 'job failed');
    }
  }
  await finish(job, error, db);
  return !error;
}

/** Process ready jobs until none remain (used by tests and one-shot CLI) */
export async function drainJobs(opts: { db?: Database; queues?: string[]; maxRounds?: number; types?: string[] } = {}) {
  let processed = 0;
  for (let round = 0; round < (opts.maxRounds ?? 50); round++) {
    const jobs = await claim(20, opts.queues ?? ['default'], opts.db);
    if (jobs.length === 0) break;
    for (const job of jobs) {
      await runJob(job, opts.db);
      processed++;
    }
  }
  return processed;
}

/** Re-queue jobs stuck in 'running' (worker crash) */
export async function reapStaleJobs(staleAfterMs = 10 * 60 * 1000, db?: Database): Promise<number> {
  return withSystem(
    async (trx) => {
      const res = await trx
        .updateTable('jobs')
        .set({ state: 'queued', locked_by: null, last_error: 'reaped: worker lost' })
        .where('state', '=', 'running')
        .where('locked_at', '<', new Date(Date.now() - staleAfterMs))
        .executeTakeFirst();
      return Number(res.numUpdatedRows);
    },
    { db },
  );
}

export interface WorkerOptions {
  concurrency: number;
  pollMs: number;
  queues?: string[];
  logger: { info: (o: object, m: string) => void; error: (o: object, m: string) => void };
  signal: AbortSignal;
}

export async function runWorker(opts: WorkerOptions): Promise<void> {
  const active = new Set<Promise<unknown>>();
  let lastReap = 0;
  while (!opts.signal.aborted) {
    if (Date.now() - lastReap > 60_000) {
      lastReap = Date.now();
      await reapStaleJobs().catch((err) => opts.logger.error({ err }, 'reap failed'));
    }
    const free = opts.concurrency - active.size;
    const jobs = free > 0 ? await claim(free, opts.queues ?? ['default']).catch(() => []) : [];
    for (const job of jobs) {
      const p = runJob(job, undefined, opts.logger).finally(() => active.delete(p));
      active.add(p);
    }
    if (jobs.length === 0) await new Promise((r) => setTimeout(r, opts.pollMs));
    else if (active.size >= opts.concurrency) await Promise.race(active);
  }
  await Promise.allSettled(active);
}
