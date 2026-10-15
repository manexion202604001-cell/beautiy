import { sql } from 'kysely';
import type { Ctx } from '../../auth/actor.js';
import { Errors } from '../../lib/errors.js';
import { ACTIVE_STATUSES, loadShop } from './availability.js';

/** Highest number of ranges running at the same moment inside [start, end) */
export function peakConcurrency(ranges: { start: Date; end: Date }[], start: Date, end: Date): number {
  const points: { at: number; delta: number }[] = [];
  for (const r of ranges) {
    const s = Math.max(r.start.getTime(), start.getTime());
    const e = Math.min(r.end.getTime(), end.getTime());
    if (e <= s) continue;
    points.push({ at: s, delta: 1 }, { at: e, delta: -1 });
  }
  // a booking ending at 11:00 frees its seat for one starting at 11:00
  points.sort((a, b) => a.at - b.at || a.delta - b.delta);
  let current = 0;
  let peak = 0;
  for (const p of points) {
    current += p.delta;
    if (current > peak) peak = current;
  }
  return peak;
}

/**
 * 席数アラート (店舗設定 › 店舗情報): when the shop turned it on, refuse a booking that would run
 * at the same time as `limit` or more other bookings of the shop. Serialized per shop with an
 * advisory lock so two staff booking the last seat at once cannot both pass.
 */
export async function assertSeatLimit(ctx: Ctx, p: { shopId: string; start: Date; end: Date; excludeAppointmentId?: string }): Promise<void> {
  const shop = await loadShop(ctx, p.shopId);
  const { alertEnabled, limit } = shop.parsed.seats;
  if (!alertEnabled || limit <= 0) return;
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'seats:' + p.shopId}, 0))`.execute(ctx.trx);
  const others = await ctx.trx
    .selectFrom('appointments')
    .select(['start_at', 'end_at'])
    .where('shop_id', '=', p.shopId)
    .where('status', 'in', [...ACTIVE_STATUSES])
    .where('deleted_at', 'is', null)
    .where('start_at', '<', p.end)
    .where('end_at', '>', p.start)
    .$if(!!p.excludeAppointmentId, (q) => q.where('id', '!=', p.excludeAppointmentId!))
    .execute();
  const peak = peakConcurrency(
    others.map((a) => ({ start: a.start_at, end: a.end_at })),
    p.start,
    p.end,
  );
  if (peak + 1 > limit) {
    throw Errors.conflict('SEAT_LIMIT_EXCEEDED', `同時刻の予約数が上限（${limit}件）に達しているため、この時間帯は予約できません`, { limit, current: peak });
  }
}
