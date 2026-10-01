import { sql } from 'kysely';
import type { Ctx } from '../../auth/actor.js';
import { Errors } from '../../lib/errors.js';
import { parseShopSettings, type ShopSettings } from '../../lib/shop-settings.js';
import { addMinutes, dateRange, dayBounds, localDate, type Range } from '../../lib/time.js';
import { effectiveMenus, type EffectiveMenu } from '../catalog/service.js';
import { loadScheduleData, resourceBlockedRanges, staffWorkRanges, type ScheduleData } from '../schedules/calendar.js';

export const ACTIVE_STATUSES = ['tentative', 'confirmed', 'checked_in', 'in_service', 'completed'] as const;

export interface AvailabilityQuery {
  shopId: string;
  menuIds: string[];
  /** specific staff (指名) or undefined for any (フリー) */
  staffId?: string | null;
  from: string; // YYYY-MM-DD (shop local)
  to: string;
  /** apply online booking constraints (lead time, horizon, public menus) */
  publicBooking?: boolean;
  /** ignore this appointment's own occupancy (reschedule) */
  excludeAppointmentId?: string;
  now?: Date;
}

export interface Slot {
  start: Date;
  end: Date;
  staffIds: string[];
}

export interface ServicePlan {
  menuId: string;
  name: string;
  offsetMin: number;
  durationMin: number;
  price: number;
  taxRateBp: number;
}

export interface StaffPlan {
  staffId: string;
  durationMin: number;
  bufferBeforeMin: number;
  bufferAfterMin: number;
  services: ServicePlan[];
  /** resource needs relative to service start */
  resourceNeeds: { resourceType: string; offsetMin: number; durationMin: number }[];
}

interface ShopRow {
  id: string;
  timezone: string;
  settings: unknown;
  status: string;
  public_booking_enabled: boolean;
}

export async function loadShop(ctx: Ctx, shopId: string): Promise<ShopRow & { parsed: ShopSettings }> {
  const shop = await ctx.trx
    .selectFrom('shops')
    .select(['id', 'timezone', 'settings', 'status', 'public_booking_enabled'])
    .where('id', '=', shopId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (!shop) throw Errors.notFound('店舗', shopId);
  return { ...shop, parsed: parseShopSettings(shop.settings) };
}

/** Bookable staff assigned to the shop who can perform all requested menus */
export async function candidateStaff(ctx: Ctx, shopId: string, menuIds: string[], staffId?: string | null): Promise<string[]> {
  let q = ctx.trx
    .selectFrom('staffs')
    .innerJoin('staff_shop_assignments as a', 'a.staff_id', 'staffs.id')
    .select(['staffs.id'])
    .where('a.shop_id', '=', shopId)
    .where('a.ended_on', 'is', null)
    .where('staffs.status', '=', 'active')
    .where('staffs.is_bookable', '=', true)
    .where('staffs.deleted_at', 'is', null)
    .orderBy('staffs.sort_order');
  if (staffId) q = q.where('staffs.id', '=', staffId);
  const staff = (await q.execute()).map((s) => s.id);
  if (!staff.length) return [];
  const caps = await ctx.trx.selectFrom('staff_menus').select(['staff_id', 'menu_id']).where('staff_id', 'in', staff).execute();
  return staff.filter((s) => {
    const mine = caps.filter((c) => c.staff_id === s);
    return mine.length === 0 || menuIds.every((m) => mine.some((c) => c.menu_id === m));
  });
}

/** Build per-staff duration/price plan (staff-specific durations & prices apply) */
export async function buildPlans(ctx: Ctx, menus: EffectiveMenu[], staffIds: string[]): Promise<Map<string, StaffPlan>> {
  const overrides = staffIds.length
    ? await ctx.trx
        .selectFrom('staff_menus')
        .select(['staff_id', 'menu_id', 'duration_min', 'price'])
        .where('staff_id', 'in', staffIds)
        .where('menu_id', 'in', menus.map((m) => m.id))
        .execute()
    : [];
  const plans = new Map<string, StaffPlan>();
  for (const staffId of staffIds) {
    let offset = 0;
    const services: ServicePlan[] = [];
    const resourceNeeds: StaffPlan['resourceNeeds'] = [];
    for (const m of menus) {
      const o = overrides.find((x) => x.staff_id === staffId && x.menu_id === m.id);
      const duration = o?.duration_min ?? m.durationMin;
      services.push({ menuId: m.id, name: m.name, offsetMin: offset, durationMin: duration, price: o?.price ?? m.price, taxRateBp: m.taxRateBp });
      for (const r of m.resourceRequirements) {
        resourceNeeds.push({ resourceType: r.resourceType, offsetMin: offset + r.offsetMin, durationMin: r.durationMin ?? duration - r.offsetMin });
      }
      offset += duration;
    }
    plans.set(staffId, {
      staffId,
      durationMin: offset,
      bufferBeforeMin: menus[0]?.bufferBeforeMin ?? 0,
      bufferAfterMin: menus[menus.length - 1]?.bufferAfterMin ?? 0,
      services,
      resourceNeeds,
    });
  }
  return plans;
}

interface Occupancy {
  staffBusy: Map<string, Range[]>;
  resources: Map<string, { id: string; busy: Range[] }[]>; // resourceType -> units
}

export async function loadOccupancy(ctx: Ctx, shopId: string, staffIds: string[], from: Date, to: Date, data: ScheduleData, excludeAppointmentId?: string): Promise<Occupancy> {
  const appts = staffIds.length
    ? await ctx.trx
        .selectFrom('appointments')
        .select(['id', 'staff_id', 'occupied_start_at', 'occupied_end_at'])
        .where('staff_id', 'in', staffIds)
        .where('status', 'in', [...ACTIVE_STATUSES])
        .where('deleted_at', 'is', null)
        .where('occupied_start_at', '<', to)
        .where('occupied_end_at', '>', from)
        .$if(!!excludeAppointmentId, (q) => q.where('id', '!=', excludeAppointmentId!))
        .execute()
    : [];
  const staffBusy = new Map<string, Range[]>();
  for (const a of appts) {
    const list = staffBusy.get(a.staff_id!) ?? [];
    list.push({ start: a.occupied_start_at, end: a.occupied_end_at });
    staffBusy.set(a.staff_id!, list);
  }
  const units = await ctx.trx.selectFrom('resources').select(['id', 'resource_type']).where('shop_id', '=', shopId).where('status', '=', 'active').where('deleted_at', 'is', null).orderBy('sort_order').execute();
  const busyRes = units.length
    ? await ctx.trx
        .selectFrom('appointment_resources')
        .select(['resource_id', 'start_at', 'end_at', 'appointment_id'])
        .where('resource_id', 'in', units.map((u) => u.id))
        .where('is_active', '=', true)
        .where('start_at', '<', to)
        .where('end_at', '>', from)
        .$if(!!excludeAppointmentId, (q) => q.where('appointment_id', '!=', excludeAppointmentId!))
        .execute()
    : [];
  const resources = new Map<string, { id: string; busy: Range[] }[]>();
  for (const u of units) {
    const busy = busyRes.filter((b) => b.resource_id === u.id).map((b) => ({ start: b.start_at, end: b.end_at }));
    busy.push(...resourceBlockedRanges(data, u.id));
    resources.set(u.resource_type, [...(resources.get(u.resource_type) ?? []), { id: u.id, busy }]);
  }
  return { staffBusy, resources };
}

function fits(range: Range, free: Range[]): boolean {
  return free.some((f) => f.start <= range.start && f.end >= range.end);
}

function clashes(range: Range, busy: Range[]): boolean {
  return busy.some((b) => b.start < range.end && range.start < b.end);
}

/** Pick one free unit per resource need; returns null when any need cannot be satisfied */
export function pickResources(plan: StaffPlan, start: Date, occupancy: Occupancy): { resourceId: string; start: Date; end: Date }[] | null {
  const picked: { resourceId: string; start: Date; end: Date }[] = [];
  for (const need of plan.resourceNeeds) {
    const interval = { start: addMinutes(start, need.offsetMin), end: addMinutes(start, need.offsetMin + need.durationMin) };
    const units = occupancy.resources.get(need.resourceType) ?? [];
    const unit = units.find((u) => !clashes(interval, u.busy) && !picked.some((p) => p.resourceId === u.id && p.start < interval.end && interval.start < p.end));
    if (!unit) return null;
    picked.push({ resourceId: unit.id, ...interval });
  }
  return picked;
}

export function occupiedRange(plan: StaffPlan, start: Date): Range {
  return { start: addMinutes(start, -plan.bufferBeforeMin), end: addMinutes(start, plan.durationMin + plan.bufferAfterMin) };
}

export interface SlotCheck {
  ok: boolean;
  reason?: 'outside_schedule' | 'staff_busy' | 'resource_unavailable' | 'lead_time' | 'horizon';
}

export function checkSlot(
  plan: StaffPlan,
  start: Date,
  data: ScheduleData,
  occupancy: Occupancy,
  opts: { publicBooking?: boolean; settings: ShopSettings; now: Date },
): SlotCheck {
  if (opts.publicBooking) {
    if (start < addMinutes(opts.now, opts.settings.booking.leadTimeMin)) return { ok: false, reason: 'lead_time' };
    if (start > addMinutes(opts.now, opts.settings.booking.horizonDays * 24 * 60)) return { ok: false, reason: 'horizon' };
  }
  const occ = occupiedRange(plan, start);
  const date = localDate(start, data.tz);
  // buffers may extend before opening / after closing only if still within working range
  if (!fits(occ, staffWorkRanges(data, plan.staffId, date))) return { ok: false, reason: 'outside_schedule' };
  if (clashes(occ, occupancy.staffBusy.get(plan.staffId) ?? [])) return { ok: false, reason: 'staff_busy' };
  if (plan.resourceNeeds.length && !pickResources(plan, start, occupancy)) return { ok: false, reason: 'resource_unavailable' };
  return { ok: true };
}

/** Compute bookable slots for a shop/menu set/date range */
export async function computeAvailability(ctx: Ctx, query: AvailabilityQuery) {
  if (query.menuIds.length === 0) throw Errors.validation('メニューを1つ以上選択してください');
  const shop = await loadShop(ctx, query.shopId);
  const settings = shop.parsed;
  if (query.menuIds.length > settings.booking.maxServicesPerBooking) throw Errors.validation('選択できるメニュー数を超えています');
  const menus = await effectiveMenus(ctx, query.shopId, { publicOnly: query.publicBooking, menuIds: query.menuIds });
  const ordered = query.menuIds.map((id) => menus.find((m) => m.id === id));
  if (ordered.some((m) => !m)) throw Errors.validation('予約できないメニューが含まれています');
  const days = dateRange(query.from, query.to);
  if (days.length > 62) throw Errors.validation('検索期間は62日以内にしてください');

  const staffIds = await candidateStaff(ctx, query.shopId, query.menuIds, query.staffId);
  const plans = await buildPlans(ctx, ordered as EffectiveMenu[], staffIds);
  const data = await loadScheduleData(ctx, query.shopId, staffIds, query.from, query.to, shop.timezone);
  const rangeStart = addMinutes(dayBounds(query.from, shop.timezone).start, -24 * 60);
  const rangeEnd = addMinutes(dayBounds(query.to, shop.timezone).end, 24 * 60);
  const occupancy = await loadOccupancy(ctx, query.shopId, staffIds, rangeStart, rangeEnd, data, query.excludeAppointmentId);
  const now = query.now ?? new Date();
  const step = settings.booking.slotIntervalMin;

  const result: { date: string; slots: Slot[] }[] = [];
  for (const date of days) {
    const byStart = new Map<number, Slot>();
    for (const staffId of staffIds) {
      const plan = plans.get(staffId)!;
      for (const w of staffWorkRanges(data, staffId, date)) {
        // align candidate starts to the slot grid (minutes since local midnight)
        const firstStart = addMinutes(w.start, plan.bufferBeforeMin);
        const minuteOfDay = Math.round((firstStart.getTime() - dayBounds(date, data.tz).start.getTime()) / 60000);
        const aligned = addMinutes(firstStart, (step - (((minuteOfDay % step) + step) % step)) % step);
        for (let s = aligned; addMinutes(s, plan.durationMin + plan.bufferAfterMin) <= w.end; s = addMinutes(s, step)) {
          const check = checkSlot(plan, s, data, occupancy, { publicBooking: query.publicBooking, settings, now });
          if (!check.ok) continue;
          const key = s.getTime();
          const existing = byStart.get(key);
          if (existing) existing.staffIds.push(staffId);
          else byStart.set(key, { start: s, end: addMinutes(s, plan.durationMin), staffIds: [staffId] });
        }
      }
    }
    result.push({ date, slots: [...byStart.values()].sort((a, b) => a.start.getTime() - b.start.getTime()) });
  }
  return {
    shopId: query.shopId,
    timezone: shop.timezone,
    slotIntervalMin: step,
    menus: (ordered as EffectiveMenu[]).map((m) => ({ id: m.id, name: m.name, durationMin: m.durationMin, price: m.price })),
    days: result,
  };
}

/** For フリー bookings: choose the available staff with the fewest booked minutes that day (load balancing) */
export async function chooseLeastBusyStaff(ctx: Ctx, staffIds: string[], date: string, tz: string): Promise<string | null> {
  if (staffIds.length <= 1) return staffIds[0] ?? null;
  const rows = await ctx.trx
    .selectFrom('appointments')
    .select(['staff_id', sql<number>`coalesce(sum(extract(epoch from (end_at - start_at)) / 60), 0)::int`.as('minutes')])
    .where('staff_id', 'in', staffIds)
    .where('status', 'in', [...ACTIVE_STATUSES])
    .where(sql<string>`(start_at AT TIME ZONE ${tz})::date`, '=', date)
    .groupBy('staff_id')
    .execute();
  const minutes = new Map(rows.map((r) => [r.staff_id!, r.minutes]));
  return [...staffIds].sort((a, b) => (minutes.get(a) ?? 0) - (minutes.get(b) ?? 0))[0]!;
}
