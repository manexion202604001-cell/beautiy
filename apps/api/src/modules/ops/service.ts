import { sql } from 'kysely';
import { requirePermission, type Ctx } from '../../auth/actor.js';
import { withSystem } from '../../db/tenant.js';
import { enqueue } from '../../jobs/queue.js';
import { audit } from '../../lib/audit.js';
import { Errors } from '../../lib/errors.js';
import { decodeCursor, paginate } from '../../lib/pagination.js';
import type { ListJobsInput, ListWebhookEventsInput } from './schemas.js';

/**
 * 運用管理 (要件 16): failure dashboard, DLQ actions, webhook reprocessing, health.
 * Everything is scoped to the caller's organization: RLS hides other tenants, and jobs/webhook
 * events with organization_id NULL (global/system rows) are never visible to tenants.
 */
const WEBHOOK_JOB = 'webhook.process';

function countMap(rows: { key: string | null; n: number }[]): Record<string, number> {
  return Object.fromEntries(rows.map((r) => [r.key ?? 'unknown', r.n]));
}

export async function dashboard(ctx: Ctx) {
  requirePermission(ctx.actor, 'ops.manage');
  const org = ctx.actor.organizationId;
  const [webhookCounts, webhookRecent, jobCounts, jobRecent, integrations, conflictCount, conflictRecent, messageCount, messageRecent] = await Promise.all([
    ctx.trx
      .selectFrom('webhook_events')
      .select(['status as key', sql<number>`count(*)::int`.as('n')])
      .where('organization_id', '=', org)
      .where('status', 'in', ['failed', 'dead'])
      .groupBy('status')
      .execute(),
    ctx.trx
      .selectFrom('webhook_events')
      .select(['id', 'provider', 'event_type', 'status', 'attempts', 'last_error', 'received_at'])
      .where('organization_id', '=', org)
      .where('status', 'in', ['failed', 'dead'])
      .orderBy('received_at', 'desc')
      .limit(10)
      .execute(),
    ctx.trx
      .selectFrom('jobs')
      .select(['state as key', sql<number>`count(*)::int`.as('n')])
      .where('organization_id', '=', org)
      .where('state', 'in', ['failed', 'dead'])
      .groupBy('state')
      .execute(),
    ctx.trx
      .selectFrom('jobs')
      .select(['id', 'type', 'state', 'attempts', 'max_attempts', 'last_error', 'created_at', 'finished_at'])
      .where('organization_id', '=', org)
      .where('state', 'in', ['failed', 'dead'])
      .orderBy('created_at', 'desc')
      .limit(10)
      .execute(),
    ctx.trx
      .selectFrom('integration_accounts')
      .select(['id', 'shop_id', 'provider', 'display_name', 'status', 'last_error', 'last_error_at', 'last_success_at', 'consecutive_failures'])
      .where('status', 'in', ['error', 'degraded'])
      .orderBy('last_error_at', 'desc')
      .execute(),
    ctx.trx.selectFrom('sync_conflicts').select(sql<number>`count(*)::int`.as('n')).where('state', '=', 'open').executeTakeFirstOrThrow(),
    ctx.trx
      .selectFrom('sync_conflicts')
      .select(['id', 'conflict_type', 'details', 'appointment_id', 'created_at'])
      .where('state', '=', 'open')
      .orderBy('created_at', 'desc')
      .limit(10)
      .execute(),
    ctx.trx.selectFrom('messages').select(sql<number>`count(*)::int`.as('n')).where('status', '=', 'failed').executeTakeFirstOrThrow(),
    ctx.trx
      .selectFrom('messages')
      .select(['id', 'shop_id', 'customer_id', 'channel', 'category', 'error', 'attempts', 'updated_at'])
      .where('status', '=', 'failed')
      .orderBy('updated_at', 'desc')
      .limit(10)
      .execute(),
  ]);
  const wc = countMap(webhookCounts);
  const jc = countMap(jobCounts);
  return {
    webhookEvents: { failed: wc.failed ?? 0, dead: wc.dead ?? 0, recent: webhookRecent },
    jobs: { failed: jc.failed ?? 0, dead: jc.dead ?? 0, recent: jobRecent },
    integrations: { failing: integrations.length, degraded: integrations.filter((i) => i.status === 'degraded').length, accounts: integrations },
    syncConflicts: { open: conflictCount.n, recent: conflictRecent },
    messages: { failed: messageCount.n, recent: messageRecent },
    generatedAt: new Date().toISOString(),
  };
}

// ------------------------------------------------------------------ DLQ (jobs)

const JOB_COLUMNS = ['id', 'type', 'queue', 'state', 'payload', 'attempts', 'max_attempts', 'last_error', 'dedupe_key', 'run_at', 'created_at', 'finished_at'] as const;

export async function listJobs(ctx: Ctx, input: ListJobsInput) {
  requirePermission(ctx.actor, 'ops.manage');
  let q = ctx.trx.selectFrom('jobs').select(JOB_COLUMNS).where('organization_id', '=', ctx.actor.organizationId).where('state', '=', input.state);
  if (input.type) q = q.where('type', '=', input.type);
  const cursor = decodeCursor(input.cursor);
  if (cursor) q = q.where(sql`(created_at, id)`, '<', sql`(${cursor.v}::timestamptz, ${cursor.id}::uuid)`);
  const rows = await q.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(input.limit + 1).execute();
  return paginate(rows, input.limit, (r) => r.created_at);
}

async function lockOrgJob(ctx: Ctx, id: string) {
  const job = await ctx.trx.selectFrom('jobs').select(JOB_COLUMNS).where('id', '=', id).where('organization_id', '=', ctx.actor.organizationId).forUpdate().executeTakeFirst();
  if (!job) throw Errors.notFound('ジョブ', id);
  return job;
}

/** DLQ → queue again with a fresh attempt budget */
export async function retryJob(ctx: Ctx, id: string) {
  requirePermission(ctx.actor, 'ops.manage');
  const job = await lockOrgJob(ctx, id);
  if (!['dead', 'failed'].includes(job.state)) throw Errors.business('JOB_NOT_RETRYABLE', 'この状態のジョブは再実行できません', { state: job.state });
  if (job.dedupe_key) {
    const active = await ctx.trx.selectFrom('jobs').select('id').where('dedupe_key', '=', job.dedupe_key).where('state', 'in', ['queued', 'running']).where('id', '!=', id).executeTakeFirst();
    if (active) throw Errors.conflict('JOB_ALREADY_QUEUED', '同じ処理が既に実行待ちです', { jobId: active.id });
  }
  await ctx.trx.updateTable('jobs').set({ state: 'queued', attempts: 0, run_at: new Date(), finished_at: null, locked_by: null, locked_at: null }).where('id', '=', id).execute();
  await audit(ctx, { action: 'job.retry', resourceType: 'job', resourceId: id, before: { state: job.state, attempts: job.attempts }, after: { state: 'queued', attempts: 0 }, metadata: { type: job.type } });
  return { ...job, state: 'queued', attempts: 0 };
}

export async function cancelJob(ctx: Ctx, id: string) {
  requirePermission(ctx.actor, 'ops.manage');
  const job = await lockOrgJob(ctx, id);
  if (!['queued', 'dead', 'failed'].includes(job.state)) throw Errors.business('JOB_NOT_CANCELLABLE', 'この状態のジョブは取消できません', { state: job.state });
  await ctx.trx.updateTable('jobs').set({ state: 'cancelled', finished_at: new Date() }).where('id', '=', id).execute();
  await audit(ctx, { action: 'job.cancel', resourceType: 'job', resourceId: id, before: { state: job.state }, after: { state: 'cancelled' }, metadata: { type: job.type } });
  return { ...job, state: 'cancelled' };
}

// ------------------------------------------------------------------ webhook events

const WEBHOOK_COLUMNS = ['id', 'provider', 'event_id', 'event_type', 'signature_valid', 'status', 'attempts', 'last_error', 'payload', 'received_at', 'processed_at'] as const;

export async function listWebhookEvents(ctx: Ctx, input: ListWebhookEventsInput) {
  requirePermission(ctx.actor, 'ops.manage');
  let q = ctx.trx.selectFrom('webhook_events').select(WEBHOOK_COLUMNS).where('organization_id', '=', ctx.actor.organizationId);
  if (input.status) q = q.where('status', '=', input.status);
  if (input.provider) q = q.where('provider', '=', input.provider);
  const cursor = decodeCursor(input.cursor);
  if (cursor) q = q.where(sql`(received_at, id)`, '<', sql`(${cursor.v}::timestamptz, ${cursor.id}::uuid)`);
  const rows = await q.orderBy('received_at', 'desc').orderBy('id', 'desc').limit(input.limit + 1).execute();
  return paginate(rows, input.limit, (r) => r.received_at);
}

export async function reprocessWebhookEvent(ctx: Ctx, id: string) {
  requirePermission(ctx.actor, 'ops.manage');
  const ev = await ctx.trx.selectFrom('webhook_events').select(WEBHOOK_COLUMNS).where('id', '=', id).where('organization_id', '=', ctx.actor.organizationId).forUpdate().executeTakeFirst();
  if (!ev) throw Errors.notFound('Webhookイベント', id);
  if (!ev.signature_valid) throw Errors.business('WEBHOOK_SIGNATURE_INVALID', '署名が不正なイベントは再処理できません');
  if (!['failed', 'dead', 'ignored'].includes(ev.status)) throw Errors.business('WEBHOOK_NOT_REPROCESSABLE', 'この状態のイベントは再処理できません', { status: ev.status });
  await ctx.trx.updateTable('webhook_events').set({ status: 'received', attempts: 0, last_error: null, processed_at: null }).where('id', '=', id).execute();
  const jobId = await enqueue(ctx, { type: WEBHOOK_JOB, payload: { webhookEventId: id }, dedupeKey: `webhook:${id}`, maxAttempts: 5, priority: 5 });
  await audit(ctx, { action: 'webhook.reprocess', resourceType: 'webhook_event', resourceId: id, before: { status: ev.status }, after: { status: 'received' }, metadata: { provider: ev.provider } });
  return { ...ev, status: 'received', attempts: 0, last_error: null, jobId };
}

// ------------------------------------------------------------------ health

export async function health(ctx: Ctx) {
  requirePermission(ctx.actor, 'ops.manage');
  const started = Date.now();
  await sql`SELECT 1`.execute(ctx.trx);
  const dbLatencyMs = Date.now() - started;
  const org = ctx.actor.organizationId;
  const now = new Date();
  const [states, oldest] = await Promise.all([
    ctx.trx.selectFrom('jobs').select(['state as key', sql<number>`count(*)::int`.as('n')]).where('organization_id', '=', org).where('state', 'in', ['queued', 'running', 'failed', 'dead']).groupBy('state').execute(),
    ctx.trx
      .selectFrom('jobs')
      .select([
        sql<Date | null>`min(created_at)`.as('oldest_created'),
        sql<Date | null>`min(run_at) FILTER (WHERE run_at <= now())`.as('oldest_ready'),
        sql<number>`count(*) FILTER (WHERE run_at <= now())::int`.as('ready'),
      ])
      .where('organization_id', '=', org)
      .where('state', '=', 'queued')
      .executeTakeFirstOrThrow(),
  ]);
  // cluster-wide worker lag (no tenant data, only the age of the oldest ready job)
  const global = await withSystem((trx) =>
    trx
      .selectFrom('jobs')
      .select([sql<Date | null>`min(run_at)`.as('oldest_ready'), sql<number>`count(*)::int`.as('ready')])
      .where('state', '=', 'queued')
      .where('run_at', '<=', now)
      .executeTakeFirstOrThrow(),
  );
  const age = (d: Date | null) => (d ? Math.max(0, Math.round((now.getTime() - new Date(d).getTime()) / 1000)) : 0);
  const s = countMap(states);
  const workerLagSec = age(global.oldest_ready);
  return {
    status: workerLagSec > 300 ? 'degraded' : 'ok',
    db: { ok: true, latencyMs: dbLatencyMs },
    queue: { queued: s.queued ?? 0, ready: oldest.ready, running: s.running ?? 0, failed: s.failed ?? 0, dead: s.dead ?? 0 },
    oldestQueuedAgeSec: age(oldest.oldest_created),
    orgWorkerLagSec: age(oldest.oldest_ready),
    workerLagSec,
    clusterReadyJobs: global.ready,
    checkedAt: now.toISOString(),
  };
}
