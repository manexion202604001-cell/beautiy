import { describe, expect, it } from 'vitest';
import { isJpHoliday } from '../../lib/jp-holidays.js';
import { mergeShopSettings, parseShopSettings } from '../../lib/shop-settings.js';
import { api, asSystem, createCustomer, createMenu, createStaffUser, createTenant, jst, jstDate, nextWeekday, type Tenant } from '../../test/helpers.js';
import type { ScheduleData, StaffReservationSettings } from '../schedules/calendar.js';
import { bookingWindowViolation, freeLane, lastBookableDate, peakOverlap, shopCapacity } from './booking-rules.js';

const TZ = 'Asia/Tokyo';
const at = (date: string, time: string) => new Date(`${date}T${time}:00+09:00`);

/** Shop open every day except Tuesday, 10:00–20:00 */
function scheduleData(settings: unknown, opts: { closed?: string[]; staff?: Record<string, StaffReservationSettings> } = {}): ScheduleData {
  return {
    tz: TZ,
    shopId: 'shop',
    businessHours: [0, 1, 3, 4, 5, 6].map((weekday) => ({ weekday, open_time: '10:00', close_time: '20:00' })),
    exceptions: new Map((opts.closed ?? []).map((d) => [d, { is_closed: true, open_time: null, close_time: null }])),
    weekly: new Map(),
    shifts: new Map(),
    blocks: [],
    settings: parseShopSettings(settings),
    staffSettings: new Map(Object.entries(opts.staff ?? {}).map(([id, reservation]) => [id, { weeklyAllClosed: false, reservation }])),
  };
}

describe('Japanese public holidays', () => {
  it('knows fixed, Monday, equinox, substitute and sandwiched holidays', () => {
    expect(isJpHoliday('2026-01-01')).toBe(true);
    expect(isJpHoliday('2026-01-12')).toBe(true); // 成人の日 (2nd Monday)
    expect(isJpHoliday('2026-03-20')).toBe(true); // 春分の日
    expect(isJpHoliday('2026-05-06')).toBe(true); // 振替休日 (5/3 is a Sunday)
    expect(isJpHoliday('2026-09-21')).toBe(true); // 敬老の日
    expect(isJpHoliday('2026-09-22')).toBe(true); // 国民の休日 (between two holidays)
    expect(isJpHoliday('2026-09-23')).toBe(true); // 秋分の日
    expect(isJpHoliday('2027-03-22')).toBe(true); // 振替休日 (春分の日 3/21 is a Sunday)
    expect(isJpHoliday('2026-10-13')).toBe(false);
    expect(isJpHoliday('2026-12-25')).toBe(false);
  });
});

describe('booking window (受付開始 / 受付締切)', () => {
  it('受付開始 in months: open until the last day of this month + N months', () => {
    expect(lastBookableDate('2026-10-13', 2)).toBe('2026-12-31');
    expect(lastBookableDate('2026-12-31', 2)).toBe('2027-02-28');
    const data = scheduleData({ booking: { advanceMonths: 2, leadTimeMin: 0 } });
    const now = at('2026-10-13', '09:00');
    expect(bookingWindowViolation(data, 's', at('2026-12-31', '19:00'), now)).toBeNull();
    expect(bookingWindowViolation(data, 's', at('2027-01-01', '10:00'), now)).toBe('horizon');
  });

  it('without months, the N-days horizon and the minutes-before deadline apply as before', () => {
    const data = scheduleData({ booking: { horizonDays: 7, leadTimeMin: 120 } });
    const now = at('2026-10-13', '09:00');
    expect(bookingWindowViolation(data, 's', at('2026-10-13', '10:59'), now)).toBe('lead_time');
    expect(bookingWindowViolation(data, 's', at('2026-10-13', '11:00'), now)).toBeNull();
    expect(bookingWindowViolation(data, 's', at('2026-10-20', '10:00'), now)).toBe('horizon');
  });

  it('前日以前に締め切る: closes at the chosen time N calendar days earlier', () => {
    const data = scheduleData({ booking: { cutoffType: 'days_before', cutoffDaysBefore: 1, cutoffTime: '18:00', horizonDays: 60 } });
    const start = at('2026-10-15', '11:00');
    expect(bookingWindowViolation(data, 's', start, at('2026-10-14', '17:59'))).toBeNull();
    expect(bookingWindowViolation(data, 's', start, at('2026-10-14', '18:00'))).toBe('lead_time');
    // 24時まで = until the end of that day
    const midnight = scheduleData({ booking: { cutoffType: 'days_before', cutoffDaysBefore: 2, cutoffTime: '24:00' } });
    expect(bookingWindowViolation(midnight, 's', start, at('2026-10-13', '23:59'))).toBeNull();
    expect(bookingWindowViolation(midnight, 's', start, at('2026-10-14', '00:00'))).toBe('lead_time');
  });

  it('営業日で計算: closed weekdays and 臨時休業日 are skipped when counting days', () => {
    // Wed 10/21 ← Tue 10/20 is the regular day off, Mon 10/19 is a temporary closure → deadline is Sun 10/18
    const data = scheduleData({ booking: { cutoffType: 'days_before', cutoffDaysBefore: 1, cutoffTime: '24:00', calcMethod: 'business_days' } }, { closed: ['2026-10-19'] });
    const start = at('2026-10-21', '11:00');
    expect(bookingWindowViolation(data, 's', start, at('2026-10-18', '23:00'))).toBeNull();
    expect(bookingWindowViolation(data, 's', start, at('2026-10-19', '09:00'))).toBe('lead_time');
    const calendar = scheduleData({ booking: { cutoffType: 'days_before', cutoffDaysBefore: 1, cutoffTime: '24:00' } }, { closed: ['2026-10-19'] });
    expect(bookingWindowViolation(calendar, 's', start, at('2026-10-20', '23:00'))).toBeNull();
  });

  it("a staff member's own 予約設定 replace the shop's window", () => {
    const own: StaffReservationSettings = { advanceBookingDays: 30, sameDayCutoffHours: 3, maxConcurrent: 1, acceptSameStartTime: false, acceptOutsideHours: false };
    const data = scheduleData({ booking: { advanceMonths: 6, cutoffType: 'days_before', cutoffDaysBefore: 3 } }, { staff: { own } });
    const now = at('2026-10-13', '09:00');
    // shop rule (3 days before) does not apply to this staff member: same day, 3 hours ahead is enough
    expect(bookingWindowViolation(data, 'own', at('2026-10-13', '11:59'), now)).toBe('lead_time');
    expect(bookingWindowViolation(data, 'own', at('2026-10-13', '12:00'), now)).toBeNull();
    expect(bookingWindowViolation(data, 'own', at('2026-11-12', '12:00'), now)).toBeNull();
    expect(bookingWindowViolation(data, 'own', at('2026-11-13', '12:00'), now)).toBe('horizon');
    // staff without their own settings follow the shop
    expect(bookingWindowViolation(data, 'other', at('2026-10-13', '12:00'), now)).toBe('lead_time');
    expect(bookingWindowViolation(data, 'other', at('2027-04-30', '12:00'), now)).toBeNull();
  });
});

describe('capacity helpers', () => {
  it('finds a free lane up to the number of bookings a staff member takes at once', () => {
    const busy = [{ start: at('2026-10-13', '10:00'), end: at('2026-10-13', '11:00'), lane: 0, startAt: at('2026-10-13', '10:00') }];
    const range = { start: at('2026-10-13', '10:30'), end: at('2026-10-13', '11:30') };
    expect(freeLane(range, busy, 1)).toBeNull();
    expect(freeLane(range, busy, 2)).toBe(1);
    expect(freeLane({ start: at('2026-10-13', '11:00'), end: at('2026-10-13', '12:00') }, busy, 1)).toBe(0);
  });

  it('counts bookings running at the same moment, not just overlapping ones', () => {
    const ranges = [
      { start: at('2026-10-13', '10:00'), end: at('2026-10-13', '11:00') },
      { start: at('2026-10-13', '11:00'), end: at('2026-10-13', '12:00') },
    ];
    expect(peakOverlap(ranges, at('2026-10-13', '10:30'), at('2026-10-13', '11:30'))).toBe(1);
    expect(peakOverlap([...ranges, ranges[0]!], at('2026-10-13', '10:30'), at('2026-10-13', '11:30'))).toBe(2);
  });

  it('受付可能数: weekday number, else the default, else no limit; holidays have their own row', () => {
    expect(shopCapacity(scheduleData({}), '2026-10-14')).toBeNull();
    const data = scheduleData({ capacity: { default: 3, weekdays: [null, null, null, 11, null, null, null], holiday: 5 }, hours: { holidayEnabled: true } });
    expect(shopCapacity(data, '2026-10-14')).toBe(11); // Wednesday
    expect(shopCapacity(data, '2026-10-15')).toBe(3);
    expect(shopCapacity(data, '2026-11-03')).toBe(5); // 文化の日
    const off = scheduleData({ capacity: { default: 3, holiday: 5 } });
    expect(shopCapacity(off, '2026-11-03')).toBe(3);
  });
});

describe('shop settings: two ways to set the same rule', () => {
  it('the last change decides between days / months and minutes / a day earlier', () => {
    const saved = mergeShopSettings({}, { booking: { advanceMonths: 2, cutoffType: 'days_before', cutoffDaysBefore: 2 } });
    expect(saved.booking.advanceMonths).toBe(2);
    // the older settings screen sends the whole booking group back unchanged: nothing is lost
    const untouched = mergeShopSettings(saved, { booking: { horizonDays: saved.booking.horizonDays, leadTimeMin: saved.booking.leadTimeMin, slotIntervalMin: 30 } });
    expect(untouched.booking.advanceMonths).toBe(2);
    expect(untouched.booking.cutoffType).toBe('days_before');
    // ... but changing the days / minutes there takes over
    const changed = mergeShopSettings(saved, { booking: { horizonDays: 90, leadTimeMin: 30 } });
    expect(changed.booking.advanceMonths).toBeNull();
    expect(changed.booking.cutoffType).toBe('same_day');
  });
});

// ---------------------------------------------------------------- through the API

async function setup() {
  const t = await createTenant();
  const stylist = await createStaffUser(t, 'stylist', { displayName: '設定スタイリスト' });
  const menu = await createMenu(t, { name: 'カット', durationMin: 60 });
  const slug = (await t.owner.get(`/v1/shops/${t.shopId}`)).body.slug as string;
  // the owner created at signup is bookable too: keep the tests to one staff member unless stated
  await t.owner.patch(`/v1/staff/${t.ownerStaffId}`, { isBookable: false });
  return { t, stylist, menu, slug };
}

const guest = (n: number) => ({ lastName: '受付', firstName: `太郎${n}`, phone: `0908888${String(1000 + n)}` });

async function publicBook(slug: string, menuId: string, startAt: string, n: number, staffId?: string) {
  return api().post(`/v1/public/shops/${slug}/appointments`, { menuIds: [menuId], startAt, staffId, customer: guest(n) });
}

async function slotsOf(slug: string, menuId: string, date: string, staffId?: string): Promise<string[]> {
  const res = await api().get(`/v1/public/shops/${slug}/availability`, { menuIds: menuId, from: date, to: date, staffId });
  expect(res.status).toBe(200);
  return (res.body.days[0].slots as { start: string }[]).map((s) => s.start);
}

async function staffBook(t: Tenant, menuId: string, staffId: string, startAt: string) {
  const customer = await createCustomer(t);
  return t.owner.post('/v1/appointments', { shopId: t.shopId, customerId: customer.id, staffId, menuIds: [menuId], startAt, source: 'phone' });
}

describe('スタッフ別 営業時間', () => {
  it('unset → shop hours; saved → those hours; every day off → not working (not "unset")', async () => {
    const { t, stylist, menu, slug } = await setup();
    const url = `/v1/staff/${stylist.staffId}/business-hours`;
    const initial = await t.owner.get(url, { shopId: t.shopId });
    expect(initial.status).toBe(200);
    expect(initial.body.configured).toBe(false);
    expect(initial.body.hours).toHaveLength(7);
    // seeded shop hours: 10:00–20:00, closed on Tuesday
    expect(initial.body.hours[1]).toMatchObject({ weekday: 1, openTime: '10:00', closeTime: '20:00', isClosed: false });
    expect(initial.body.hours[2].isClosed).toBe(true);

    const hours = initial.body.hours.map((h: { weekday: number }) => ({ ...h, openTime: '12:00', closeTime: '16:00', isClosed: h.weekday !== 3 }));
    const saved = await t.owner.put(url, { shopId: t.shopId, hours });
    expect(saved.status).toBe(200);
    expect(saved.body.configured).toBe(true);
    expect(saved.body.hours[3]).toMatchObject({ openTime: '12:00', closeTime: '16:00', isClosed: false });
    expect(saved.body.hours[4].isClosed).toBe(true);

    const wed = nextWeekday(3);
    const thu = nextWeekday(4);
    const day = await t.owner.get(`/v1/shops/${t.shopId}/staff-schedule`, { date: wed });
    const working = day.body.staff.find((s: { staffId: string }) => s.staffId === stylist.staffId).working;
    expect(working).toHaveLength(1);
    expect(working[0].start).toBe(jst(wed, '12:00'));
    expect(working[0].end).toBe(jst(wed, '16:00'));
    expect(await slotsOf(slug, menu.id, thu, stylist.staffId)).toHaveLength(0);
    const wedSlots = await slotsOf(slug, menu.id, wed, stylist.staffId);
    expect(wedSlots[0]).toBe(jst(wed, '12:00'));
    expect(wedSlots.at(-1)).toBe(jst(wed, '15:00'));

    // every day 休み
    const allOff = await t.owner.put(url, { shopId: t.shopId, hours: hours.map((h: object) => ({ ...h, isClosed: true })) });
    expect(allOff.body.configured).toBe(true);
    expect(allOff.body.hours.every((h: { isClosed: boolean }) => h.isClosed)).toBe(true);
    expect(await slotsOf(slug, menu.id, wed, stylist.staffId)).toHaveLength(0);
    const overview = await t.owner.get(`/v1/shops/${t.shopId}/staff-settings`);
    expect(overview.body.hours).toContain(stylist.staffId);

    // サロンの営業時間を反映
    const copied = await t.owner.post(`${url}/copy-shop`, { shopId: t.shopId });
    expect(copied.body.configured).toBe(true);
    expect(copied.body.hours[3]).toMatchObject({ openTime: '10:00', closeTime: '20:00', isClosed: false });
    expect(copied.body.hours[2].isClosed).toBe(true);
    expect((await slotsOf(slug, menu.id, wed, stylist.staffId))[0]).toBe(jst(wed, '10:00'));
  });

  it('is limited to schedule managers (or the staff member themself) and to the own organization', async () => {
    const { t, stylist } = await setup();
    const other = await createStaffUser(t, 'stylist');
    const hours = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, openTime: '11:00', closeTime: '15:00', isClosed: false }));
    const denied = await other.api.put(`/v1/staff/${stylist.staffId}/business-hours`, { shopId: t.shopId, hours });
    expect(denied.status).toBe(403);
    const own = await stylist.api.put(`/v1/staff/${stylist.staffId}/business-hours`, { shopId: t.shopId, hours });
    expect(own.status).toBe(200);
    const invalid = await t.owner.put(`/v1/staff/${stylist.staffId}/business-hours`, { shopId: t.shopId, hours: hours.map((h) => ({ ...h, closeTime: '10:00' })) });
    expect(invalid.status).toBe(400);
    const stranger = await createTenant('別サロン');
    const foreign = await stranger.owner.get(`/v1/staff/${stylist.staffId}/business-hours`, { shopId: stranger.shopId });
    expect(foreign.status).toBe(404);
    const foreignWrite = await stranger.owner.put(`/v1/staff/${stylist.staffId}/reservation-settings`, {
      shopId: stranger.shopId,
      advanceBookingDays: 30,
      sameDayCutoffHours: 1,
      maxConcurrent: 2,
      acceptSameStartTime: true,
      acceptOutsideHours: false,
    });
    expect(foreignWrite.status).toBe(404);
  });
});

describe('スタッフ別 予約設定', () => {
  const own = { advanceBookingDays: 30, sameDayCutoffHours: 3, maxConcurrent: 2, acceptSameStartTime: false, acceptOutsideHours: false };

  it('saves, reads back and resets to the shop settings', async () => {
    const { t, stylist } = await setup();
    const url = `/v1/staff/${stylist.staffId}/reservation-settings`;
    const initial = await t.owner.get(url, { shopId: t.shopId });
    expect(initial.body.individual).toBe(false);
    expect(initial.body.settings.maxConcurrent).toBe(1);
    const saved = await t.owner.put(url, { shopId: t.shopId, ...own });
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ individual: true, settings: own });
    expect((await t.owner.get(`/v1/shops/${t.shopId}/staff-settings`)).body.reservation).toEqual([stylist.staffId]);
    const denied = await stylist.api.put(url, { shopId: t.shopId, ...own, maxConcurrent: 5 });
    expect(denied.status).toBe(403);
    const invalid = await t.owner.put(url, { shopId: t.shopId, ...own, maxConcurrent: 11 });
    expect(invalid.status).toBe(400);
    const reset = await t.owner.delete(`${url}?shopId=${t.shopId}`);
    expect(reset.status).toBe(200);
    expect(reset.body.individual).toBe(false);
  });

  it('同時刻に予約可能な人数: a staff member set to 2 takes two bookings at once, not three', async () => {
    const { t, stylist, menu } = await setup();
    const date = nextWeekday(3);
    const first = await staffBook(t, menu.id, stylist.staffId, jst(date, '11:00'));
    expect(first.status).toBe(201);
    // default: one at a time
    const clash = await staffBook(t, menu.id, stylist.staffId, jst(date, '11:30'));
    expect(clash.status).toBe(409);
    expect(clash.body.error.details.reason).toBe('staff_busy');

    await t.owner.put(`/v1/staff/${stylist.staffId}/reservation-settings`, { shopId: t.shopId, ...own });
    const second = await staffBook(t, menu.id, stylist.staffId, jst(date, '11:30'));
    expect(second.status).toBe(201);
    const third = await staffBook(t, menu.id, stylist.staffId, jst(date, '11:45'));
    expect(third.status).toBe(409);
    const lanes = await asSystem(t.organizationId, (ctx) => ctx.trx.selectFrom('appointments').select(['id', 'staff_lane']).where('staff_id', '=', stylist.staffId).orderBy('start_at').execute());
    expect(lanes.map((l) => l.staff_lane)).toEqual([0, 1]);
    // moving the second booking keeps it valid, and the freed time is bookable again
    const moved = await t.owner.patch(`/v1/appointments/${second.body.id}`, { startAt: jst(date, '14:00'), version: second.body.version });
    expect(moved.status).toBe(200);
    expect((await staffBook(t, menu.id, stylist.staffId, jst(date, '11:45'))).status).toBe(201);
  });

  it('開始時刻が同じ予約: online bookings at the very same start are refused unless switched on', async () => {
    const { t, stylist, menu, slug } = await setup();
    const date = nextWeekday(3, 5);
    await t.owner.put(`/v1/staff/${stylist.staffId}/reservation-settings`, { shopId: t.shopId, ...own, sameDayCutoffHours: 0 });
    expect((await publicBook(slug, menu.id, jst(date, '13:00'), 1, stylist.staffId)).status).toBe(201);
    const same = await publicBook(slug, menu.id, jst(date, '13:00'), 2, stylist.staffId);
    expect(same.status).toBe(409);
    expect(same.body.error.details.reason).toBe('same_start');
    const slots = await slotsOf(slug, menu.id, date, stylist.staffId);
    expect(slots).not.toContain(jst(date, '13:00'));
    expect(slots).toContain(jst(date, '13:15'));
    expect((await publicBook(slug, menu.id, jst(date, '13:15'), 3, stylist.staffId)).status).toBe(201);

    await t.owner.put(`/v1/staff/${stylist.staffId}/reservation-settings`, { shopId: t.shopId, ...own, sameDayCutoffHours: 0, acceptSameStartTime: true });
    const date2 = nextWeekday(4, 5);
    expect((await publicBook(slug, menu.id, jst(date2, '13:00'), 4, stylist.staffId)).status).toBe(201);
    expect((await publicBook(slug, menu.id, jst(date2, '13:00'), 5, stylist.staffId)).status).toBe(201);
  });

  it('何日先まで: the staff member is bookable online only that far ahead', async () => {
    const { t, stylist, menu, slug } = await setup();
    await t.owner.patch(`/v1/shops/${t.shopId}`, { settings: { booking: { horizonDays: 60 } } });
    await t.owner.put(`/v1/staff/${stylist.staffId}/reservation-settings`, { shopId: t.shopId, ...own, advanceBookingDays: 5 });
    // a non-Tuesday date 6–13 days ahead: inside the shop's 60 days, outside this staff member's 5
    let far = jstDate(6);
    if (new Date(`${far}T12:00:00+09:00`).getUTCDay() === 2) far = jstDate(7);
    expect(await slotsOf(slug, menu.id, far, stylist.staffId)).toHaveLength(0);
    const refused = await publicBook(slug, menu.id, jst(far, '13:00'), 6, stylist.staffId);
    expect(refused.status).toBe(409);
    expect(refused.body.error.details.reason).toBe('horizon');
    // staff can still enter the booking themselves
    expect((await staffBook(t, menu.id, stylist.staffId, jst(far, '13:00'))).status).toBe(201);
  });

  it('営業時間外の予約を受付する: online slots outside the hours on working days only', async () => {
    const { t, stylist, menu, slug } = await setup();
    const wed = nextWeekday(3, 5);
    const tue = nextWeekday(2, 5);
    expect(await slotsOf(slug, menu.id, wed, stylist.staffId)).not.toContain(jst(wed, '21:00'));
    await t.owner.put(`/v1/staff/${stylist.staffId}/reservation-settings`, { shopId: t.shopId, ...own, maxConcurrent: 1, acceptOutsideHours: true });
    expect(await slotsOf(slug, menu.id, wed, stylist.staffId)).toContain(jst(wed, '21:00'));
    expect((await publicBook(slug, menu.id, jst(wed, '21:00'), 7, stylist.staffId)).status).toBe(201);
    // the regular day off stays closed
    expect(await slotsOf(slug, menu.id, tue, stylist.staffId)).toHaveLength(0);
    expect((await publicBook(slug, menu.id, jst(tue, '12:00'), 8, stylist.staffId)).status).toBe(409);
  });
});

describe('予約受付設定 (店舗)', () => {
  it('受付可能数: online bookings stop at the number for the weekday; staff can still add bookings', async () => {
    const { t, stylist, menu, slug } = await setup();
    const second = await createStaffUser(t, 'stylist', { displayName: '二人目' });
    const wed = nextWeekday(3, 5);
    const thu = nextWeekday(4, 5);
    const saved = await t.owner.patch(`/v1/shops/${t.shopId}`, { settings: { capacity: { default: 2, weekdays: [null, null, null, 1, null, null, null] } } });
    expect(saved.status).toBe(200);
    expect(saved.body.settings.capacity).toEqual({ default: 2, weekdays: [null, null, null, 1, null, null, null], holiday: null });

    expect((await publicBook(slug, menu.id, jst(wed, '11:00'), 1, stylist.staffId)).status).toBe(201);
    const full = await publicBook(slug, menu.id, jst(wed, '11:30'), 2, second.staffId);
    expect(full.status).toBe(409);
    expect(full.body.error.details.reason).toBe('capacity');
    const slots = await slotsOf(slug, menu.id, wed);
    expect(slots).not.toContain(jst(wed, '11:30'));
    expect(slots).toContain(jst(wed, '12:00'));
    expect((await staffBook(t, menu.id, second.staffId, jst(wed, '11:30'))).status).toBe(201);

    // Thursday has no number of its own: the default (2) applies
    expect((await publicBook(slug, menu.id, jst(thu, '11:00'), 3, stylist.staffId)).status).toBe(201);
    expect((await publicBook(slug, menu.id, jst(thu, '11:00'), 4, second.staffId)).status).toBe(201);
    const third = await createStaffUser(t, 'stylist', { displayName: '三人目' });
    expect((await publicBook(slug, menu.id, jst(thu, '11:30'), 5, third.staffId)).status).toBe(409);
  });

  it('受付開始 in months and 受付締切 a day earlier are applied to online bookings', async () => {
    const { t, stylist, menu, slug } = await setup();
    await t.owner.patch(`/v1/shops/${t.shopId}`, { settings: { booking: { advanceMonths: 1 } } });
    const last = lastBookableDate(jstDate(0), 1);
    const notTuesday = (d: string) => (new Date(`${d}T12:00:00+09:00`).getUTCDay() === 2 ? null : d);
    const shift = (d: string, n: number) => new Date(new Date(`${d}T12:00:00+09:00`).getTime() + n * 86_400_000).toISOString().slice(0, 10);
    const inside = notTuesday(last) ?? shift(last, -1);
    const outside = notTuesday(shift(last, 1)) ?? shift(last, 2);
    expect((await slotsOf(slug, menu.id, inside, stylist.staffId)).length).toBeGreaterThan(0);
    expect(await slotsOf(slug, menu.id, outside, stylist.staffId)).toHaveLength(0);
    const info = await api().get(`/v1/public/shops/${slug}`);
    expect(info.body.booking.lastBookableDate).toBe(last);

    // 前日以前に締め切る (3日前の24時まで): tomorrow and the day after are closed for online booking
    // (the day after stands in for tomorrow when tomorrow is the test shop's closed Tuesday), staff are not affected
    await t.owner.patch(`/v1/shops/${t.shopId}`, { settings: { booking: { cutoffType: 'days_before', cutoffDaysBefore: 3, cutoffTime: '24:00' } } });
    const tomorrow = notTuesday(jstDate(1)) ?? jstDate(2);
    expect(await slotsOf(slug, menu.id, tomorrow, stylist.staffId)).toHaveLength(0);
    const refused = await publicBook(slug, menu.id, jst(tomorrow, '15:00'), 1, stylist.staffId);
    expect(refused.status).toBe(409);
    expect(refused.body.error.details.reason).toBe('lead_time');
    const later = notTuesday(jstDate(4)) ?? jstDate(5);
    expect((await slotsOf(slug, menu.id, later, stylist.staffId)).length).toBeGreaterThan(0);
  });

  it('祝日の営業時間: a public holiday uses the holiday row instead of the weekday row', async () => {
    const { t } = await setup();
    let holiday = '';
    for (let i = 1; i < 200 && !holiday; i++) if (isJpHoliday(jstDate(i))) holiday = jstDate(i);
    expect(holiday).not.toBe('');
    await t.owner.patch(`/v1/shops/${t.shopId}`, { settings: { hours: { holidayEnabled: true, holidayOpenTime: '12:00', holidayCloseTime: '17:00' } } });
    const open = await t.owner.get(`/v1/shops/${t.shopId}/staff-schedule`, { date: holiday });
    expect(open.body.shopOpen).toEqual([{ start: jst(holiday, '12:00'), end: jst(holiday, '17:00') }]);
    // the booking page is told about the holiday as a day with its own hours
    const slug = (await t.owner.get(`/v1/shops/${t.shopId}`)).body.slug;
    await t.owner.patch(`/v1/shops/${t.shopId}`, { settings: { booking: { advanceMonths: 12 } } });
    const listed = (await api().get(`/v1/public/shops/${slug}`)).body.exceptions.find((e: { date: string }) => e.date === holiday);
    expect(listed).toMatchObject({ is_closed: false, open_time: '12:00', close_time: '17:00' });
    await t.owner.patch(`/v1/shops/${t.shopId}`, { settings: { hours: { holidayClosed: true } } });
    expect((await t.owner.get(`/v1/shops/${t.shopId}/staff-schedule`, { date: holiday })).body.shopOpen).toEqual([]);
    // switched off again: the weekday row is back
    await t.owner.patch(`/v1/shops/${t.shopId}`, { settings: { hours: { holidayEnabled: false } } });
    const weekday = new Date(`${holiday}T12:00:00+09:00`).getUTCDay();
    const back = (await t.owner.get(`/v1/shops/${t.shopId}/staff-schedule`, { date: holiday })).body.shopOpen;
    expect(back).toEqual(weekday === 2 ? [] : [{ start: jst(holiday, '10:00'), end: jst(holiday, '20:00') }]);
  });

  it('お客様に非表示 のスタッフ takes no online bookings, nominated or free', async () => {
    const { t, stylist, menu, slug } = await setup();
    await asSystem(t.organizationId, (ctx) =>
      ctx.trx.updateTable('staff_shop_assignments').set({ is_visible_to_customer: false }).where('staff_id', '=', stylist.staffId).where('shop_id', '=', t.shopId).execute(),
    );
    const date = nextWeekday(3, 5);
    expect(await slotsOf(slug, menu.id, date)).toHaveLength(0);
    const free = await publicBook(slug, menu.id, jst(date, '11:00'), 1);
    expect(free.status).toBeGreaterThanOrEqual(400);
    expect((await staffBook(t, menu.id, stylist.staffId, jst(date, '11:00'))).status).toBe(201);
  });
});
