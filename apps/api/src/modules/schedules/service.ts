import { assertShopAccess, requirePermission, type Ctx } from '../../auth/actor.js';
import { audit } from '../../lib/audit.js';
import { Errors } from '../../lib/errors.js';
import { getShop } from '../org/service.js';
import { loadScheduleData, shopOpenRanges, staffWorkRanges, datesBetween } from './calendar.js';

const trimTime = (t: string | null) => (t ? t.slice(0, 5) : t);

export async function getBusinessHours(ctx: Ctx, shopId: string) {
  assertShopAccess(ctx.actor, shopId);
  const rows = await ctx.trx.selectFrom('shop_business_hours').select(['id', 'weekday', 'open_time', 'close_time']).where('shop_id', '=', shopId).orderBy('weekday').orderBy('open_time').execute();
  return rows.map((r) => ({ ...r, open_time: trimTime(r.open_time)!, close_time: trimTime(r.close_time)! }));
}

export async function replaceBusinessHours(ctx: Ctx, shopId: string, hours: { weekday: number; openTime: string; closeTime: string }[]) {
  requirePermission(ctx.actor, 'schedule.manage');
  assertShopAccess(ctx.actor, shopId);
  for (const h of hours) if (h.closeTime <= h.openTime) throw Errors.validation('終了時刻は開始時刻より後にしてください', h);
  const before = await getBusinessHours(ctx, shopId);
  await ctx.trx.deleteFrom('shop_business_hours').where('shop_id', '=', shopId).execute();
  if (hours.length) {
    await ctx.trx
      .insertInto('shop_business_hours')
      .values(hours.map((h) => ({ organization_id: ctx.actor.organizationId, shop_id: shopId, weekday: h.weekday, open_time: h.openTime, close_time: h.closeTime })))
      .execute();
  }
  const after = await getBusinessHours(ctx, shopId);
  await audit(ctx, { action: 'shop.business_hours_update', resourceType: 'shop', resourceId: shopId, shopId, before, after });
  return after;
}

export async function listExceptions(ctx: Ctx, shopId: string, from: string, to: string) {
  assertShopAccess(ctx.actor, shopId);
  const rows = await ctx.trx
    .selectFrom('shop_calendar_exceptions')
    .select(['id', 'date', 'is_closed', 'open_time', 'close_time', 'note'])
    .where('shop_id', '=', shopId)
    .where('date', '>=', from)
    .where('date', '<=', to)
    .orderBy('date')
    .execute();
  return rows.map((r) => ({ ...r, open_time: trimTime(r.open_time), close_time: trimTime(r.close_time) }));
}

export async function upsertException(ctx: Ctx, shopId: string, date: string, input: { isClosed: boolean; openTime?: string | null; closeTime?: string | null; note?: string | null }) {
  requirePermission(ctx.actor, 'schedule.manage');
  assertShopAccess(ctx.actor, shopId);
  const values = {
    is_closed: input.isClosed,
    open_time: input.isClosed ? null : (input.openTime ?? null),
    close_time: input.isClosed ? null : (input.closeTime ?? null),
    note: input.note ?? null,
  };
  const row = await ctx.trx
    .insertInto('shop_calendar_exceptions')
    .values({ organization_id: ctx.actor.organizationId, shop_id: shopId, date, ...values })
    .onConflict((oc) => oc.columns(['shop_id', 'date']).doUpdateSet(values))
    .returning(['id', 'date', 'is_closed', 'open_time', 'close_time', 'note'])
    .executeTakeFirstOrThrow();
  await audit(ctx, { action: 'shop.calendar_exception', resourceType: 'shop', resourceId: shopId, shopId, after: { date, ...values } });
  return row;
}

export async function deleteException(ctx: Ctx, shopId: string, date: string) {
  requirePermission(ctx.actor, 'schedule.manage');
  assertShopAccess(ctx.actor, shopId);
  await ctx.trx.deleteFrom('shop_calendar_exceptions').where('shop_id', '=', shopId).where('date', '=', date).execute();
}

export async function getWeeklySchedule(ctx: Ctx, staffId: string, shopId: string) {
  assertShopAccess(ctx.actor, shopId);
  const rows = await ctx.trx
    .selectFrom('staff_weekly_schedules')
    .select(['id', 'weekday', 'start_time', 'end_time'])
    .where('staff_id', '=', staffId)
    .where('shop_id', '=', shopId)
    .orderBy('weekday')
    .orderBy('start_time')
    .execute();
  return rows.map((r) => ({ ...r, start_time: trimTime(r.start_time)!, end_time: trimTime(r.end_time)! }));
}

export async function replaceWeeklySchedule(ctx: Ctx, staffId: string, shopId: string, rows: { weekday: number; startTime: string; endTime: string }[]) {
  const isSelf = ctx.actor.kind === 'staff' && ctx.actor.staffId === staffId;
  if (!isSelf) requirePermission(ctx.actor, 'schedule.manage');
  assertShopAccess(ctx.actor, shopId);
  await ctx.trx.deleteFrom('staff_weekly_schedules').where('staff_id', '=', staffId).where('shop_id', '=', shopId).execute();
  if (rows.length) {
    await ctx.trx
      .insertInto('staff_weekly_schedules')
      .values(rows.map((r) => ({ organization_id: ctx.actor.organizationId, staff_id: staffId, shop_id: shopId, weekday: r.weekday, start_time: r.startTime, end_time: r.endTime })))
      .execute();
  }
  await audit(ctx, { action: 'staff.weekly_schedule_update', resourceType: 'staff', resourceId: staffId, shopId, after: rows });
  return getWeeklySchedule(ctx, staffId, shopId);
}

export async function listShifts(ctx: Ctx, shopId: string, from: string, to: string) {
  requirePermission(ctx.actor, 'schedule.read');
  assertShopAccess(ctx.actor, shopId);
  const rows = await ctx.trx
    .selectFrom('staff_shifts')
    .select(['id', 'staff_id', 'shop_id', 'date', 'shift_type', 'start_time', 'end_time', 'note'])
    .where('shop_id', '=', shopId)
    .where('date', '>=', from)
    .where('date', '<=', to)
    .orderBy('date')
    .execute();
  return rows.map((r) => ({ ...r, start_time: trimTime(r.start_time), end_time: trimTime(r.end_time) }));
}

/** Bulk upsert: for each (staff, date) present in input, existing rows for that date are replaced */
export async function upsertShifts(
  ctx: Ctx,
  shopId: string,
  shifts: { staffId: string; date: string; shiftType: 'work' | 'off'; startTime?: string | null; endTime?: string | null; note?: string | null }[],
) {
  requirePermission(ctx.actor, 'schedule.manage');
  assertShopAccess(ctx.actor, shopId);
  const keys = new Map<string, { staffId: string; date: string }>();
  for (const s of shifts) keys.set(`${s.staffId}:${s.date}`, { staffId: s.staffId, date: s.date });
  for (const k of keys.values()) {
    await ctx.trx.deleteFrom('staff_shifts').where('staff_id', '=', k.staffId).where('date', '=', k.date).where('shop_id', '=', shopId).execute();
  }
  const rows = shifts.filter((s) => s.shiftType === 'off' || (s.startTime && s.endTime));
  if (rows.length) {
    await ctx.trx
      .insertInto('staff_shifts')
      .values(
        rows.map((s) => ({
          organization_id: ctx.actor.organizationId,
          staff_id: s.staffId,
          shop_id: shopId,
          date: s.date,
          shift_type: s.shiftType,
          start_time: s.shiftType === 'work' ? s.startTime! : null,
          end_time: s.shiftType === 'work' ? s.endTime! : null,
          note: s.note ?? null,
        })),
      )
      .execute();
  }
  await audit(ctx, { action: 'shift.bulk_update', resourceType: 'shop', resourceId: shopId, shopId, metadata: { count: shifts.length } });
  const dates = [...keys.values()].map((k) => k.date).sort();
  return dates.length ? listShifts(ctx, shopId, dates[0]!, dates[dates.length - 1]!) : [];
}

export async function listBlocks(ctx: Ctx, shopId: string, from: Date, to: Date) {
  assertShopAccess(ctx.actor, shopId);
  return ctx.trx
    .selectFrom('schedule_blocks')
    .select(['id', 'shop_id', 'staff_id', 'resource_id', 'start_at', 'end_at', 'reason', 'source'])
    .where('shop_id', '=', shopId)
    .where('start_at', '<', to)
    .where('end_at', '>', from)
    .orderBy('start_at')
    .execute();
}

export async function createBlock(ctx: Ctx, input: { shopId: string; staffId?: string | null; resourceId?: string | null; startAt: string; endAt: string; reason?: string | null }) {
  requirePermission(ctx.actor, 'appointment.write');
  assertShopAccess(ctx.actor, input.shopId);
  if (!input.staffId && !input.resourceId) throw Errors.validation('staffIdまたはresourceIdが必要です');
  const start = new Date(input.startAt);
  const end = new Date(input.endAt);
  if (end <= start) throw Errors.validation('終了は開始より後にしてください');
  const row = await ctx.trx
    .insertInto('schedule_blocks')
    .values({
      organization_id: ctx.actor.organizationId,
      shop_id: input.shopId,
      staff_id: input.staffId ?? null,
      resource_id: input.resourceId ?? null,
      start_at: start,
      end_at: end,
      reason: input.reason ?? null,
      created_by: ctx.actor.kind === 'staff' ? ctx.actor.staffId : null,
    })
    .returning(['id', 'shop_id', 'staff_id', 'resource_id', 'start_at', 'end_at', 'reason', 'source'])
    .executeTakeFirstOrThrow();
  await audit(ctx, { action: 'schedule_block.create', resourceType: 'schedule_block', resourceId: row.id, shopId: input.shopId, after: input });
  return row;
}

export async function deleteBlock(ctx: Ctx, id: string) {
  requirePermission(ctx.actor, 'appointment.write');
  const b = await ctx.trx.selectFrom('schedule_blocks').select(['shop_id']).where('id', '=', id).executeTakeFirst();
  if (!b) throw Errors.notFound('ブロック', id);
  assertShopAccess(ctx.actor, b.shop_id);
  await ctx.trx.deleteFrom('schedule_blocks').where('id', '=', id).execute();
}

/** Computed working ranges per staff for a day (calendar background shading) */
export async function dayStaffSchedule(ctx: Ctx, shopId: string, date: string, staffIds: string[]) {
  const shop = await getShop(ctx, shopId);
  const data = await loadScheduleData(ctx, shopId, staffIds, date, date, shop.timezone);
  return {
    date,
    timezone: shop.timezone,
    shopOpen: shopOpenRanges(data, date),
    staff: staffIds.map((id) => ({ staffId: id, working: staffWorkRanges(data, id, date) })),
  };
}

export { datesBetween };
