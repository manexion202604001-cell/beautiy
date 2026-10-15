/**
 * Public contract of the appointments module for other modules (CONVENTIONS §5).
 * Creating / changing bookings goes through service.ts (createAppointment / updateAppointment /
 * transitionAppointment); this file holds the read helpers other modules need.
 */
import { sql } from 'kysely';
import type { Ctx } from '../../auth/actor.js';

/** Bookings of the shop that are still ahead (not cancelled / no-show / finished) */
export async function countUpcomingAppointments(ctx: Ctx, shopId: string, now = new Date()): Promise<number> {
  const row = await ctx.trx
    .selectFrom('appointments')
    .select(sql<number>`count(*)::int`.as('n'))
    .where('shop_id', '=', shopId)
    .where('deleted_at', 'is', null)
    .where('status', 'in', ['tentative', 'confirmed', 'checked_in', 'in_service'])
    .where('end_at', '>', now)
    .executeTakeFirstOrThrow();
  return row.n;
}
