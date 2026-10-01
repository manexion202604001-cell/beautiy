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
    .where('status', 'in', ['completed', 'partially_refunded', 'refunded'])
    .where('completed_at', 'is not', null)
    .orderBy('completed_at')
    .execute();

  const visitDates = visits.map((v) => v.completed_at!);
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
  const visitCount = Math.max(visits.length, visits.length ? 0 : appt.completed_count);
  const first = visitDates[0] ?? appt.first_completed ?? null;
  const last = visitDates[visitDates.length - 1] ?? appt.last_completed ?? null;

  await ctx.trx
    .updateTable('customers')
    .set({
      first_visit_at: first,
      last_visit_at: last,
      visit_count: visitCount,
      total_sales: totalSales,
      avg_cycle_days: avgCycle,
      next_appointment_at: appt.next_at,
      no_show_count: appt.no_shows,
      cancel_count: appt.cancels,
    })
    .where('id', '=', customerId)
    .execute();
}
