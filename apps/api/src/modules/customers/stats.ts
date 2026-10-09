import { sql } from 'kysely';
import type { Ctx } from '../../auth/actor.js';

/**
 * Recompute denormalized visit statistics for a customer from source-of-truth tables.
 * Called after transaction completion/void/refund, appointment status changes and merges.
 */
export async function recomputeCustomerStats(ctx: Ctx, customerId: string): Promise<void> {
  const visits = await ctx.trx
    .selectFrom('transactions')
    .select(['completed_at', 'total', 'refunded_total'])
    .where('customer_id', '=', customerId)
    .where('status', 'in', ['completed', 'partially_refunded'])
    .where('completed_at', 'is not', null)
    .orderBy('completed_at')
    .execute();

  const visitDates = visits.map((v) => v.completed_at!);
  // fully refunded transactions are not visits (consistent with analytics KPI definitions)
  const totalSales = visits.reduce((sum, v) => sum + v.total - v.refunded_total, 0);
  let avgCycle: number | null = null;
  if (visitDates.length >= 2) {
    const spanDays = (visitDates[visitDates.length - 1]!.getTime() - visitDates[0]!.getTime()) / 86_400_000;
    avgCycle = Math.round((spanDays / (visitDates.length - 1)) * 100) / 100;
  }

  const appt = await ctx.trx
    .selectFrom('appointments')
    .select([
      sql<Date | null>`min(start_at) FILTER (WHERE start_at > now() AND status IN ('tentative','confirmed'))`.as('next_at'),
      sql<number>`count(*) FILTER (WHERE status = 'no_show')::int`.as('no_shows'),
      sql<number>`count(*) FILTER (WHERE status = 'cancelled' AND cancelled_by_type = 'customer')::int`.as('cancels'),
      sql<Date | null>`min(start_at) FILTER (WHERE status = 'completed')`.as('first_completed'),
      sql<Date | null>`max(start_at) FILTER (WHERE status = 'completed')`.as('last_completed'),
      sql<number>`count(*) FILTER (WHERE status = 'completed')::int`.as('completed_count'),
    ])
    .where('customer_id', '=', customerId)
    .where('deleted_at', 'is', null)
    .executeTakeFirstOrThrow();

  // Visits come from completed transactions; fall back to completed appointments when POS isn't used
  const ownCount = Math.max(visits.length, visits.length ? 0 : appt.completed_count);
  const ownFirst = visitDates[0] ?? appt.first_completed ?? null;
  const ownLast = visitDates[visitDates.length - 1] ?? appt.last_completed ?? null;

  // history carried over from the previous system (data migration): the customer-level figures from
  // the customer export and the imported visit rows describe the same history, so take the larger
  const legacy = await ctx.trx
    .selectFrom('customers')
    .leftJoin('legacy_visits as lv', 'lv.customer_id', 'customers.id')
    .select([
      'customers.legacy_visit_count',
      'customers.legacy_total_sales',
      'customers.legacy_first_visit_at',
      'customers.legacy_last_visit_at',
      sql<number>`count(lv.id)::int`.as('lv_count'),
      sql<number>`coalesce(sum(lv.amount), 0)::int`.as('lv_sales'),
      sql<Date | null>`min(lv.visited_at)`.as('lv_first'),
      sql<Date | null>`max(lv.visited_at)`.as('lv_last'),
    ])
    .where('customers.id', '=', customerId)
    .groupBy('customers.id')
    .executeTakeFirst();
  const legacyCount = legacy ? Math.max(legacy.legacy_visit_count, legacy.lv_count) : 0;
  const legacySales = legacy ? Math.max(legacy.legacy_total_sales, legacy.lv_sales) : 0;
  const pickDate = (dates: (Date | null | undefined)[], fn: 'min' | 'max') => {
    const ms = dates.filter((d): d is Date => !!d).map((d) => d.getTime());
    return ms.length ? new Date(fn === 'min' ? Math.min(...ms) : Math.max(...ms)) : null;
  };
  const visitCount = ownCount + legacyCount;
  const first = pickDate([ownFirst, legacy?.legacy_first_visit_at, legacy?.lv_first], 'min');
  const last = pickDate([ownLast, legacy?.legacy_last_visit_at, legacy?.lv_last], 'max');
  if (legacyCount && first && last && visitCount >= 2) {
    avgCycle = Math.round(((last.getTime() - first.getTime()) / 86_400_000 / (visitCount - 1)) * 100) / 100;
  }

  await ctx.trx
    .updateTable('customers')
    .set({
      first_visit_at: first,
      last_visit_at: last,
      visit_count: visitCount,
      total_sales: totalSales + legacySales,
      avg_cycle_days: avgCycle,
      next_appointment_at: appt.next_at,
      no_show_count: appt.no_shows,
      cancel_count: appt.cancels,
    })
    .where('id', '=', customerId)
    .execute();
}
