import { sql } from 'kysely';
import { auditUserId, systemActor, type Ctx } from '../../auth/actor.js';
import { withSystem } from '../../db/tenant.js';
import { Errors } from '../../lib/errors.js';
import { enqueue, registerJob } from '../../jobs/queue.js';
import { dailyAt, registerPeriodic } from '../../jobs/scheduler.js';

export type PointReason = 'earn' | 'redeem' | 'adjust' | 'expire' | 'revert';

/**
 * Append to the point ledger and update customers.point_balance atomically (customer row locked).
 * clampAtZero: a negative delta larger than the balance is reduced so the balance stays >= 0
 * (used for reversals when the customer already spent the points). Returns the applied delta.
 */
export async function applyPoints(
  ctx: Ctx,
  input: { customerId: string; delta: number; reason: PointReason; transactionId?: string | null; note?: string; expiresAt?: Date | null; clampAtZero?: boolean },
): Promise<number> {
  if (input.delta === 0) return 0;
  const c = await ctx.trx.selectFrom('customers').select(['id', 'point_balance']).where('id', '=', input.customerId).forUpdate().executeTakeFirst();
  if (!c) throw Errors.notFound('顧客', input.customerId);
  let delta = input.delta;
  if (c.point_balance + delta < 0) {
    if (!input.clampAtZero) throw Errors.business('INSUFFICIENT_POINTS', 'ポイント残高が不足しています', { balance: c.point_balance });
    delta = -c.point_balance;
  }
  if (delta === 0) return 0;
  const balance = c.point_balance + delta;
  await ctx.trx
    .insertInto('point_ledger')
    .values({
      organization_id: ctx.actor.organizationId,
      customer_id: input.customerId,
      delta,
      reason: input.reason,
      transaction_id: input.transactionId ?? null,
      balance_after: balance,
      expires_at: input.expiresAt ?? null,
      note: input.note ?? null,
      created_by: auditUserId(ctx.actor),
    })
    .execute();
  await ctx.trx.updateTable('customers').set({ point_balance: balance }).where('id', '=', input.customerId).execute();
  return delta;
}

/** Sum of ledger deltas for a transaction with a given reason/note */
export async function ledgerSum(ctx: Ctx, transactionId: string, reason: PointReason, note?: string): Promise<number> {
  let q = ctx.trx.selectFrom('point_ledger').select(sql<number>`coalesce(sum(delta), 0)::int`.as('s')).where('transaction_id', '=', transactionId).where('reason', '=', reason);
  if (note) q = q.where('note', '=', note);
  return (await q.executeTakeFirstOrThrow()).s;
}

/**
 * Expire points whose earn rows passed expires_at (FIFO approximation):
 *   to_expire = max(0, Σ expired earn − consumed − already expired), capped by the balance,
 * where consumed = Σ|negative non-expire deltas| − Σ positive reverts (returned redemptions).
 */
export async function expireCustomerPoints(ctx: Ctx, customerId: string, now = new Date()): Promise<number> {
  const agg = await ctx.trx
    .selectFrom('point_ledger')
    .select([
      sql<number>`coalesce(sum(delta) FILTER (WHERE reason = 'earn' AND expires_at IS NOT NULL AND expires_at <= ${now}), 0)::int`.as('expired_earn'),
      sql<number>`coalesce(-sum(delta) FILTER (WHERE delta < 0 AND reason <> 'expire'), 0)::int`.as('consumed'),
      sql<number>`coalesce(sum(delta) FILTER (WHERE delta > 0 AND reason = 'revert'), 0)::int`.as('returned'),
      sql<number>`coalesce(-sum(delta) FILTER (WHERE reason = 'expire'), 0)::int`.as('expired'),
    ])
    .where('customer_id', '=', customerId)
    .executeTakeFirstOrThrow();
  const consumed = Math.max(0, agg.consumed - agg.returned);
  const toExpire = agg.expired_earn - consumed - agg.expired;
  if (toExpire <= 0) return 0;
  return -(await applyPoints(ctx, { customerId, delta: -toExpire, reason: 'expire', note: '有効期限切れ', clampAtZero: true }));
}

// daily job: fan out per organization, then expire per customer with expired earn rows
registerJob<{ organizationId?: string }>('pos.expire_points', async (_payload, jc) => {
  if (!jc.organizationId) {
    const orgs = await withSystem((trx) => trx.selectFrom('organizations').select('id').where('deleted_at', 'is', null).where('status', 'in', ['active', 'trial']).execute());
    await withSystem(async (trx) => {
      for (const o of orgs) await enqueue(trx, { type: 'pos.expire_points', organizationId: o.id, dedupeKey: `pos.expire_points:${o.id}:${new Date().toISOString().slice(0, 10)}` });
    });
    return;
  }
  await jc.tx(async (ctx) => {
    const customers = await ctx.trx
      .selectFrom('point_ledger')
      .select('customer_id')
      .distinct()
      .where('reason', '=', 'earn')
      .where('expires_at', '<=', new Date())
      .execute();
    for (const c of customers) await expireCustomerPoints({ ...ctx, actor: systemActor(ctx.actor.organizationId, 'job:pos.expire_points') }, c.customer_id);
  });
});
registerPeriodic({ name: 'pos.expire_points', jobType: 'pos.expire_points', bucket: dailyAt(3, 30) });
