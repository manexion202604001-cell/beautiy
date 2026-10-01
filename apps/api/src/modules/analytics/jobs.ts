import { withSystem } from '../../db/tenant.js';
import { enqueue, PermanentJobError, registerJob } from '../../jobs/queue.js';
import { dailyAt, registerPeriodic } from '../../jobs/scheduler.js';
import { onEvent } from '../../lib/events.js';
import { localDate } from '../../lib/time.js';
import { REBUILD_JOB, rebuildDay, scheduleRebuild, scheduleRebuildForInstants } from './aggregate.js';
import { addDaysIso } from './scope.js';

/**
 * Side-effect registrations of the analytics module (imported from index.ts so that both the
 * API server and the worker register them).
 */

export const NIGHTLY_JOB = 'analytics.nightly_rebuild';
export const ORG_RECENT_JOB = 'analytics.rebuild_org_recent';
/** nightly pass recomputes yesterday and the 2 days before it (late refunds / corrections) */
export const NIGHTLY_DAYS = 3;

registerJob<{ shopId: string; date: string }>(REBUILD_JOB, async (payload, jc) => {
  if (!payload?.shopId || !/^\d{4}-\d{2}-\d{2}$/.test(payload?.date ?? '')) throw new PermanentJobError('invalid payload');
  await jc.tx((ctx) => rebuildDay(ctx, payload.shopId, payload.date));
});

/** Global (organization_id NULL) → fan out one job per active organization */
registerJob(NIGHTLY_JOB, async () => {
  await withSystem(async (trx) => {
    const orgs = await trx.selectFrom('organizations').select('id').where('deleted_at', 'is', null).where('status', 'in', ['trial', 'active']).execute();
    const stamp = new Date().toISOString().slice(0, 10);
    for (const org of orgs) {
      await enqueue(trx, { type: ORG_RECENT_JOB, organizationId: org.id, payload: { days: NIGHTLY_DAYS }, dedupeKey: `analytics:nightly:${org.id}:${stamp}` });
    }
  });
});

registerJob<{ days?: number }>(ORG_RECENT_JOB, async (payload, jc) => {
  const days = Math.min(Math.max(payload?.days ?? NIGHTLY_DAYS, 1), 31);
  await jc.tx(async (ctx) => {
    const shops = await ctx.trx.selectFrom('shops').select(['id', 'timezone']).where('deleted_at', 'is', null).execute();
    for (const shop of shops) {
      const today = localDate(new Date(), shop.timezone);
      const dates = Array.from({ length: days }, (_, i) => addDaysIso(today, -(i + 1)));
      await scheduleRebuild(ctx, shop.id, dates, 0);
    }
  });
});

registerPeriodic({ name: 'analytics.nightly_rebuild', jobType: NIGHTLY_JOB, bucket: dailyAt(2) });

// ---------------------------------------------------------------- event triggers (debounced)

interface TxEventPayload {
  transactionId?: string;
  shopId?: string;
  completedAt?: string | null;
}

for (const type of ['transaction.completed', 'transaction.voided', 'transaction.refunded']) {
  onEvent<TxEventPayload>(type, async (ctx, event) => {
    let { shopId, completedAt } = event.payload;
    if ((!shopId || !completedAt) && event.payload.transactionId) {
      const tx = await ctx.trx.selectFrom('transactions').select(['shop_id', 'completed_at']).where('id', '=', event.payload.transactionId).executeTakeFirst();
      shopId ??= tx?.shop_id;
      completedAt ??= tx?.completed_at?.toISOString() ?? null;
    }
    if (shopId) await scheduleRebuildForInstants(ctx, shopId, [completedAt]);
  });
}

interface ApptEventPayload {
  shopId?: string;
  startAt?: string;
  previousStartAt?: string;
}

for (const type of [
  'appointment.created',
  'appointment.rescheduled',
  'appointment.updated',
  'appointment.confirmed',
  'appointment.checked_in',
  'appointment.in_service',
  'appointment.completed',
  'appointment.cancelled',
  'appointment.no_show',
  'appointment.restored',
]) {
  onEvent<ApptEventPayload>(type, async (ctx, event) => {
    const { shopId, startAt, previousStartAt } = event.payload;
    if (shopId) await scheduleRebuildForInstants(ctx, shopId, [startAt, previousStartAt]);
  });
}
