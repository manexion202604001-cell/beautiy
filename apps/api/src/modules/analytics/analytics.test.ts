import { beforeAll, describe, expect, it } from 'vitest';
import { withSystem } from '../../db/tenant.js';
import { enqueue } from '../../jobs/queue.js';
import { emit } from '../../lib/events.js';
import {
  asSystem,
  createCustomer,
  createMenu,
  createStaffUser,
  createTenant,
  insertAppointment,
  insertTransaction,
  jst,
  jstDate,
  nextWeekday,
  runJobs,
  type Api,
  type Tenant,
} from '../../test/helpers.js';
import { NIGHTLY_JOB } from './jobs.js';

/**
 * Synthetic dataset (shop TZ = Asia/Tokyo). Day D = 2025-06-12 (Thu, shop open 10:00-20:00).
 *
 *  T1  C1 (first visit, flag NULL)  11:00  cut 5500 [A main, nominated] + shampoo 3300 [A referral] − discount 880 = 7920
 *  T2  C2 (repeat, flag false)      14:00  color 8800 [B main 70% / A assistant 30%], partially refunded 1100 → net 7700; appt A2 (line)
 *  T3  C3 (flag true)               16:00  cut 5500 [B main]; appt A3 (web, nominated)
 *  T4  anonymous                    17:00  product 2200 [B main]
 *  T5  C1 VOIDED                    18:00  color 8800 → excluded
 *  T6  C4 fully REFUNDED            18:30  cut 5500 → net 0, not a visit
 *  Appointments on D: A2 line completed 14:00-15:30 (B), A3 web completed 16:00-17:00 (B, nominated),
 *    A4 phone cancelled 12:00 (A), A5 web no_show 19:00-19:30 (A), A6 staff confirmed 15:00-16:00 (A)
 *  Staff B has a shift 12:00-18:00 on D; staff A follows shop hours.
 *  Other visits: P0 C2 2025-05-13 14:00 cut 5500 [A]; C5 2025-03-20 4400; C6 2025-03-25 3300 + 2025-05-01 3300;
 *    C1 returns 2025-07-02 11:00 (5500); C3 returns 2025-08-20 16:00 (5500).
 */
const D = '2025-06-12';
const JUNE = { from: '2025-06-01', to: '2025-06-30' };

interface Fixture {
  t: Tenant;
  a: { staffId: string; api: Api };
  b: { staffId: string; api: Api };
  m1: string;
  m2: string;
  c: Record<'c1' | 'c2' | 'c3' | 'c4' | 'c5' | 'c6', string>;
  shopName: string;
}

async function seed(): Promise<Fixture> {
  const t = await createTenant('分析サロン');
  const a = await createStaffUser(t, 'stylist', { displayName: 'スタイリストA' });
  const b = await createStaffUser(t, 'stylist', { displayName: 'スタイリストB' });
  const catCut = (await t.owner.post('/v1/menu-categories', { name: 'カット' })).body.id;
  const catColor = (await t.owner.post('/v1/menu-categories', { name: 'カラー' })).body.id;
  const m1 = (await createMenu(t, { name: 'カット', price: 5500, categoryId: catCut })).id;
  const m2 = (await createMenu(t, { name: 'カラー', price: 8800, durationMin: 90, categoryId: catColor })).id;
  const c1 = (await createCustomer(t, { lastName: '一', firstName: '花子', acquisitionSource: 'instagram' })).id;
  const c2 = (await createCustomer(t, { lastName: '二', firstName: '次郎', acquisitionSource: 'instagram' })).id;
  const c3 = (await createCustomer(t, { lastName: '三', firstName: '三郎', acquisitionSource: 'hotpepper' })).id;
  const c4 = (await createCustomer(t, { lastName: '四', firstName: '四郎' })).id;
  const c5 = (await createCustomer(t, { lastName: '五', firstName: '五郎' })).id;
  const c6 = (await createCustomer(t, { lastName: '六', firstName: '六子' })).id;
  const org = t.organizationId;
  const shopId = t.shopId;
  const shopName = (await t.owner.get(`/v1/shops/${shopId}`)).body.name;

  const A = a.staffId;
  const B = b.staffId;
  const a2 = await insertAppointment(org, { shopId, customerId: c2, staffId: B, startAt: jst(D, '14:00'), durationMin: 90, status: 'completed', source: 'line', estimatedTotal: 8800 });
  const a3 = await insertAppointment(org, { shopId, customerId: c3, staffId: B, startAt: jst(D, '16:00'), status: 'completed', source: 'web', isNominated: true, estimatedTotal: 5500 });
  await insertAppointment(org, { shopId, customerId: c4, staffId: A, startAt: jst(D, '12:00'), status: 'cancelled', source: 'phone', estimatedTotal: 5500 });
  await insertAppointment(org, { shopId, customerId: c5, staffId: A, startAt: jst(D, '19:00'), durationMin: 30, status: 'no_show', source: 'web' });
  await insertAppointment(org, { shopId, customerId: c6, staffId: A, startAt: jst(D, '15:00'), status: 'confirmed', source: 'staff', estimatedTotal: 5500 });
  await asSystem(org, (ctx) =>
    ctx.trx.insertInto('staff_shifts').values({ organization_id: org, staff_id: B, shop_id: shopId, date: D, shift_type: 'work', start_time: '12:00', end_time: '18:00' }).execute(),
  );

  // D transactions
  await insertTransaction(org, {
    shopId,
    customerId: c1,
    completedAt: jst(D, '11:00'),
    items: [
      { itemType: 'service', menuId: m1, unitPrice: 5500, staff: [{ staffId: A, isNominated: true }] },
      { itemType: 'product', name: 'シャンプー', unitPrice: 3300, staff: [{ staffId: A, role: 'referral' }] },
      { itemType: 'discount', name: '値引', unitPrice: -880 },
    ],
  });
  await insertTransaction(org, {
    shopId,
    customerId: c2,
    appointmentId: a2.id,
    completedAt: jst(D, '14:00'),
    isNewCustomer: false,
    status: 'partially_refunded',
    refundedTotal: 1100,
    items: [{ itemType: 'service', menuId: m2, unitPrice: 8800, staff: [{ staffId: B, shareBp: 7000 }, { staffId: A, role: 'assistant', shareBp: 3000 }] }],
  });
  await insertTransaction(org, {
    shopId,
    customerId: c3,
    appointmentId: a3.id,
    completedAt: jst(D, '16:00'),
    isNewCustomer: true,
    items: [{ itemType: 'service', menuId: m1, unitPrice: 5500, staff: [{ staffId: B }] }],
  });
  await insertTransaction(org, { shopId, completedAt: jst(D, '17:00'), items: [{ itemType: 'product', unitPrice: 2200, staff: [{ staffId: B }] }] });
  await insertTransaction(org, { shopId, customerId: c1, completedAt: jst(D, '18:00'), status: 'voided', items: [{ itemType: 'service', menuId: m2, unitPrice: 8800, staff: [{ staffId: A }] }] });
  await insertTransaction(org, { shopId, customerId: c4, completedAt: jst(D, '18:30'), status: 'refunded', items: [{ itemType: 'service', menuId: m1, unitPrice: 5500, staff: [{ staffId: A }] }] });

  // other visits
  await insertTransaction(org, { shopId, customerId: c2, completedAt: jst('2025-05-13', '14:00'), items: [{ itemType: 'service', menuId: m1, unitPrice: 5500, staff: [{ staffId: A }] }] });
  await insertTransaction(org, { shopId, customerId: c5, completedAt: jst('2025-03-20', '12:00'), items: [{ itemType: 'service', unitPrice: 4400, staff: [{ staffId: A }] }] });
  await insertTransaction(org, { shopId, customerId: c6, completedAt: jst('2025-03-25', '12:00'), items: [{ itemType: 'service', unitPrice: 3300 }] });
  await insertTransaction(org, { shopId, customerId: c6, completedAt: jst('2025-05-01', '12:00'), items: [{ itemType: 'service', unitPrice: 3300 }] });
  await insertTransaction(org, { shopId, customerId: c1, completedAt: jst('2025-07-02', '11:00'), items: [{ itemType: 'service', menuId: m1, unitPrice: 5500, staff: [{ staffId: A }] }] });
  await insertTransaction(org, { shopId, customerId: c3, completedAt: jst('2025-08-20', '16:00'), items: [{ itemType: 'service', menuId: m1, unitPrice: 5500, staff: [{ staffId: B }] }] });

  return { t, a, b, m1, m2, c: { c1, c2, c3, c4, c5, c6 }, shopName };
}

async function rebuild(t: Tenant, from: string, to = from) {
  const res = await t.owner.post('/v1/analytics/rebuild', { shopId: t.shopId, from, to });
  expect(res.status).toBe(202);
  await runJobs();
  return res.body;
}

describe('analytics aggregation', () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await seed();
    const r = await rebuild(f.t, D);
    expect(r.enqueued).toBe(1);
    await rebuild(f.t, '2025-05-13');
  });

  it('rebuild_day computes shop / staff / menu / source aggregates', async () => {
    const { t, a, b, m1, m2 } = f;
    const rows = await asSystem(t.organizationId, async (ctx) => ({
      shop: await ctx.trx.selectFrom('analytics_daily_shop').selectAll().where('shop_id', '=', t.shopId).where('date', '=', D).execute(),
      staff: await ctx.trx.selectFrom('analytics_daily_staff').selectAll().where('shop_id', '=', t.shopId).where('date', '=', D).execute(),
      menus: await ctx.trx.selectFrom('analytics_daily_menu').selectAll().where('shop_id', '=', t.shopId).where('date', '=', D).execute(),
      sources: await ctx.trx.selectFrom('analytics_daily_source').selectAll().where('shop_id', '=', t.shopId).where('date', '=', D).execute(),
    }));
    expect(rows.shop).toHaveLength(1);
    expect(rows.shop[0]).toMatchObject({
      sales_total: 23320, // 7920 + 7700 + 5500 + 2200 + 0
      service_sales: 18150, // 4950 (cut after pro-rata discount) + 7700 + 5500
      product_sales: 5170, // 2970 + 2200
      discount_total: 880,
      tax_total: 2120, // 720 + (800 − 100) + 500 + 200 + (500 − 500)
      refund_total: 6600, // 1100 + 5500
      transaction_count: 4,
      customer_count: 4, // C1, C2, C3 + 1 anonymous
      new_customer_count: 2, // C1 (first visit), C3 (flag)
      repeat_customer_count: 1, // C2
      nominated_count: 2, // T1 (allocation), T3 (appointment)
      appointment_count: 5,
      cancel_count: 1,
      no_show_count: 1,
    });

    const sa = rows.staff.find((s) => s.staff_id === a.staffId)!;
    const sb = rows.staff.find((s) => s.staff_id === b.staffId)!;
    expect(sa).toMatchObject({ sales_total: 10230, service_sales: 7260, product_sales: 2970, customer_count: 1, new_customer_count: 1, nominated_count: 1, scheduled_minutes: 600, booked_minutes: 60 });
    expect(sb).toMatchObject({ sales_total: 13090, service_sales: 10890, product_sales: 2200, customer_count: 3, new_customer_count: 1, nominated_count: 1, scheduled_minutes: 360, booked_minutes: 150 });
    // owner (assigned today, no activity on D) has no row
    expect(rows.staff.map((s) => s.staff_id).sort()).toEqual([a.staffId, b.staffId].sort());

    expect(rows.menus.find((m) => m.menu_id === m1)).toMatchObject({ count: 2, sales: 10450 });
    expect(rows.menus.find((m) => m.menu_id === m2)).toMatchObject({ count: 1, sales: 7700 });
    expect(rows.menus).toHaveLength(2);

    const src = Object.fromEntries(rows.sources.map((s) => [s.source, { a: s.appointment_count, c: s.completed_count, s: s.sales }]));
    expect(src).toEqual({
      line: { a: 1, c: 1, s: 7700 },
      web: { a: 2, c: 1, s: 5500 },
      phone: { a: 1, c: 0, s: 0 },
      staff: { a: 1, c: 0, s: 0 },
      none: { a: 0, c: 0, s: 10120 },
    });

    // idempotent: rebuilding again yields the same single row set
    await rebuild(t, D);
    const again = await asSystem(t.organizationId, (ctx) =>
      ctx.trx.selectFrom('analytics_daily_staff').select(['staff_id', 'sales_total']).where('shop_id', '=', t.shopId).where('date', '=', D).execute(),
    );
    expect(again).toHaveLength(2);
    expect(again.reduce((s, r) => s + r.sales_total, 0)).toBe(23320);
  });

  it('GET /analytics/sales: summary, buckets, shop/staff grouping and comparison deltas', async () => {
    const { t, a, b, shopName } = f;
    const res = await t.owner.get('/v1/analytics/sales', { ...JUNE, groupBy: 'week' });
    expect(res.status).toBe(200);
    expect(res.body.summary).toMatchObject({
      salesTotal: 23320,
      serviceSales: 18150,
      productSales: 5170,
      discountTotal: 880,
      taxTotal: 2120,
      refundTotal: 6600,
      transactionCount: 4,
      customerCount: 4,
      newCustomerCount: 2,
      repeatCustomerCount: 1,
      nominatedCount: 2,
      avgTicket: 5830, // 23320 / 4
      nominatedRate: 50,
    });
    // previous_period = 2025-05-02 .. 2025-05-31 (P0 only)
    expect(res.body.comparison.range).toMatchObject({ from: '2025-05-02', to: '2025-05-31', days: 30 });
    expect(res.body.comparison.summary).toMatchObject({ salesTotal: 5500, transactionCount: 1, customerCount: 1, avgTicket: 5500 });
    expect(res.body.comparison.deltas).toMatchObject({ salesTotal: 324, transactionCount: 300, avgTicket: 6, repeatCustomerCount: null });
    expect(res.body.rows.map((r: { period: string }) => r.period)).toEqual(['2025-05-26', '2025-06-02', '2025-06-09', '2025-06-16', '2025-06-23', '2025-06-30']);
    expect(res.body.rows[2].salesTotal).toBe(23320);
    expect(res.body.rows[0].salesTotal).toBe(0);

    const month = await t.owner.get('/v1/analytics/sales', { ...JUNE, groupBy: 'month', compareTo: 'none' });
    expect(month.body.comparison).toBeNull();
    expect(month.body.rows).toEqual([expect.objectContaining({ period: '2025-06', salesTotal: 23320 })]);

    const yoy = await t.owner.get('/v1/analytics/sales', { ...JUNE, compareTo: 'previous_year' });
    expect(yoy.body.comparison.range).toMatchObject({ from: '2024-06-01', to: '2024-06-30' });
    expect(yoy.body.comparison.deltas.salesTotal).toBeNull();

    const byShop = await t.owner.get('/v1/analytics/sales', { ...JUNE, groupBy: 'shop' });
    expect(byShop.body.rows).toEqual([expect.objectContaining({ shopId: t.shopId, label: shopName, salesTotal: 23320, previousSalesTotal: 5500, salesDelta: 324 })]);

    const byStaff = await t.owner.get('/v1/analytics/sales', { ...JUNE, groupBy: 'staff' });
    expect(byStaff.body.level).toBe('staff');
    expect(byStaff.body.rows.map((r: { staffId: string; salesTotal: number; salesDelta: number | null }) => [r.staffId, r.salesTotal, r.salesDelta])).toEqual([
      [b.staffId, 13090, null],
      [a.staffId, 10230, 86], // vs 5500 in May
    ]);

    const oneStaff = await t.owner.get('/v1/analytics/sales', { ...JUNE, staffId: b.staffId, groupBy: 'month' });
    expect(oneStaff.body.summary).toMatchObject({ salesTotal: 13090, customerCount: 3, avgTicket: 4363 });
  });

  it('GET /analytics/customers: new / repeat / lost and visit-cycle distribution', async () => {
    const { t } = f;
    const res = await t.owner.get('/v1/analytics/customers', JUNE);
    expect(res.status).toBe(200);
    expect(res.body.summary).toEqual({ visitors: 3, newCustomers: 2, repeatCustomers: 1, lostCustomers: 1, repeatRate: 33.3 });
    expect(res.body.lostWindow).toEqual({ from: '2025-03-03', to: '2025-04-01' }); // C5 (last 03-20) lost; C6 came back 05-01
    expect(res.body.comparison.summary).toEqual({ visitors: 1, newCustomers: 1, repeatCustomers: 0, lostCustomers: 0, repeatRate: 0 });
    expect(res.body.comparison.deltas).toMatchObject({ visitors: 200, newCustomers: 100, repeatCustomers: null, lostCustomers: null });
    // C2: 05-13 → 06-12 = 30.0 days; C1 / C3 single visit up to 06-30
    expect(res.body.visitCycle).toMatchObject({ customers: 3, multiVisitCustomers: 1, singleVisitCustomers: 2, avgCycleDays: 30, medianCycleDays: 30 });
    expect(res.body.visitCycle.buckets[0]).toMatchObject({ key: 'le30', count: 1, share: 100 });
    expect(res.body.rows).toEqual([{ period: '2025-06', newCustomerVisits: 2, repeatCustomerVisits: 1, customerVisits: 4 }]);

    const shorter = await t.owner.get('/v1/analytics/customers', { ...JUNE, lostThresholdDays: 60, compareTo: 'none' });
    // window 2025-04-02 .. 2025-05-01 → C6 (last visit 05-01)
    expect(shorter.body.summary.lostCustomers).toBe(1);
  });

  it('GET /analytics/repeat-rate and /analytics/ltv', async () => {
    const { t, c } = f;
    const rr = await t.owner.get('/v1/analytics/repeat-rate', JUNE);
    expect(rr.status).toBe(200);
    // cohort: C1 (returns after 20 days), C3 (after 69 days)
    expect(rr.body.summary).toMatchObject({ cohortSize: 2, returnedEver: 2, returnedEverRate: 100 });
    expect(rr.body.summary.windows).toEqual({
      d30: { eligible: 2, returned: 1, rate: 50 },
      d60: { eligible: 2, returned: 1, rate: 50 },
      d90: { eligible: 2, returned: 2, rate: 100 },
    });
    expect(rr.body.overallRepeatRate).toEqual({ visitors: 3, repeatCustomers: 1, rate: 33.3 });
    expect(rr.body.cohorts).toEqual([expect.objectContaining({ cohort: '2025-06', cohortSize: 2 })]);
    expect(rr.body.comparison.summary.cohortSize).toBe(1); // C2 (May)

    const ltv = await t.owner.get('/v1/analytics/ltv', { top: 2 });
    expect(ltv.status).toBe(200);
    // C1 13420, C2 13200, C3 11000, C5 4400, C6 6600 (C4 only had a fully refunded sale)
    expect(ltv.body.summary).toMatchObject({ customers: 5, totalSales: 48620, ltvAllTime: 9724, maturedCustomers: 5, ltv12m: 9724, avgVisits: 1.8, avgTicket: 5402 });
    expect(ltv.body.bySource.map((s: { source: string; ltvAllTime: number; customers: number }) => [s.source, s.customers, s.ltvAllTime])).toEqual([
      ['instagram', 2, 13310],
      ['hotpepper', 1, 11000],
      ['不明', 2, 5500],
    ]);
    expect(ltv.body.byCohort.map((r: { cohort: string; ltvAllTime: number }) => [r.cohort, r.ltvAllTime])).toEqual([
      ['2025-03', 5500],
      ['2025-05', 13200],
      ['2025-06', 12210],
    ]);
    expect(ltv.body.byShop).toEqual([expect.objectContaining({ shopId: t.shopId, customers: 5, ltvAllTime: 9724 })]);
    expect(ltv.body.topCustomers.map((x: { customerId: string; totalSales: number }) => [x.customerId, x.totalSales])).toEqual([
      [c.c1, 13420],
      [c.c2, 13200],
    ]);
    expect(ltv.body.topCustomers[0].customerName).toBe('一 花子');

    const june = await t.owner.get('/v1/analytics/ltv', { ...JUNE, top: 0 });
    expect(june.body.summary).toMatchObject({ customers: 2, ltvAllTime: 12210 });
    expect(june.body.topCustomers).toEqual([]);
  });

  it('GET /analytics/menus, /analytics/staff and /analytics/channels', async () => {
    const { t, a, b, m1, m2 } = f;
    const menus = await t.owner.get('/v1/analytics/menus', JUNE);
    expect(menus.status).toBe(200);
    expect(menus.body.summary).toEqual({ totalCount: 3, totalSales: 18150 });
    expect(menus.body.comparison.deltas).toEqual({ totalCount: 200, totalSales: 230 });
    expect(menus.body.menus).toEqual([
      expect.objectContaining({ menuId: m1, categoryName: 'カット', count: 2, sales: 10450, countShare: 66.7, salesShare: 57.6, avgPrice: 5225, previousSales: 5500, salesDelta: 90 }),
      expect.objectContaining({ menuId: m2, categoryName: 'カラー', count: 1, sales: 7700, countShare: 33.3, salesShare: 42.4, previousSales: 0, salesDelta: null }),
    ]);
    expect(menus.body.categories.map((c: { categoryName: string; salesShare: number }) => [c.categoryName, c.salesShare])).toEqual([
      ['カット', 57.6],
      ['カラー', 42.4],
    ]);

    const staff = await t.owner.get('/v1/analytics/staff', JUNE);
    expect(staff.status).toBe(200);
    const [rb, ra] = staff.body.rows;
    expect(rb).toMatchObject({
      staffId: b.staffId,
      staffName: 'スタイリストB',
      salesTotal: 13090,
      customerCount: 3,
      nominatedCount: 1,
      nominatedRate: 33.3,
      newCustomerCount: 1,
      bookedHours: 2.5,
      scheduledHours: 6,
      salesPerBookedHour: 5236, // 13090 / 2.5h
      salesPerScheduledHour: 2182, // 13090 / 6h
      utilization: 41.7, // 150 / 360
      salesDelta: null,
    });
    expect(ra).toMatchObject({
      staffId: a.staffId,
      salesTotal: 10230,
      customerCount: 1,
      nominatedRate: 100,
      bookedHours: 1,
      scheduledHours: 10,
      salesPerBookedHour: 10230,
      salesPerScheduledHour: 1023,
      utilization: 10,
      salesDelta: 86,
    });
    expect(ra.previous).toMatchObject({ salesTotal: 5500, customerCount: 1 });

    const ch = await t.owner.get('/v1/analytics/channels', JUNE);
    expect(ch.status).toBe(200);
    expect(ch.body.summary).toEqual({ totalSales: 23320, totalAppointments: 5 });
    expect(ch.body.rows.map((r: { source: string; label: string; appointmentCount: number; completedCount: number; sales: number; salesShare: number }) => [r.source, r.label, r.appointmentCount, r.completedCount, r.sales, r.salesShare])).toEqual([
      ['none', '予約なし(直接会計)', 0, 0, 10120, 43.4],
      ['line', 'LINE予約', 1, 1, 7700, 33],
      ['web', 'Web予約', 2, 1, 5500, 23.6],
      ['phone', '電話', 1, 0, 0, 0],
      ['staff', 'スタッフ登録', 1, 0, 0, 0],
    ]);
    expect(ch.body.rows[2].completionRate).toBe(50);
    // May: P0 had no appointment → none 5500
    expect(ch.body.rows[0].previousSales).toBe(5500);
  });

  it('restricts stylists (analytics.read_own) to their own metrics and audits sales views', async () => {
    const { t, a, b } = f;
    const own = await a.api.get('/v1/analytics/staff', JUNE);
    expect(own.status).toBe(200);
    expect(own.body.ownOnly).toBe(true);
    expect(own.body.rows).toHaveLength(1);
    expect(own.body.rows[0]).toMatchObject({ staffId: a.staffId, salesTotal: 10230 });
    expect((await a.api.get('/v1/analytics/staff', { ...JUNE, staffId: b.staffId })).status).toBe(403);

    const sales = await a.api.get('/v1/analytics/sales', JUNE);
    expect(sales.status).toBe(200);
    expect(sales.body).toMatchObject({ level: 'staff', staffId: a.staffId });
    expect(sales.body.summary.salesTotal).toBe(10230);
    expect((await a.api.get('/v1/analytics/sales', { ...JUNE, groupBy: 'shop' })).status).toBe(403);
    expect((await a.api.get('/v1/analytics/sales', { ...JUNE, staffId: b.staffId })).status).toBe(403);
    for (const path of ['customers', 'repeat-rate', 'ltv', 'menus', 'channels', 'dashboard']) {
      expect((await a.api.get(`/v1/analytics/${path}`, JUNE)).status, path).toBe(403);
    }
    // stylists have no export.data
    expect((await a.api.get('/v1/analytics/staff', { ...JUNE, format: 'csv' })).status).toBe(403);
    // and cannot trigger rebuilds
    expect((await a.api.post('/v1/analytics/rebuild', { shopId: t.shopId, from: D, to: D })).status).toBe(403);

    const logs = await asSystem(t.organizationId, (ctx) =>
      ctx.trx.selectFrom('audit_logs').select(['action', 'metadata']).where('actor_id', '=', a.staffId).where('action', '=', 'sales.view').execute(),
    );
    expect(logs.map((l) => (l.metadata as { report: string }).report).sort()).toEqual(['sales', 'staff']);
    expect((logs[0]!.metadata as { ownStaffId: string }).ownStaffId).toBe(a.staffId);
  });

  it('exports CSV with export.data and audits export.csv', async () => {
    const { t } = f;
    const res = await t.owner.get('/v1/analytics/sales', { ...JUNE, groupBy: 'month', format: 'csv' });
    expect(res.status).toBe(200);
    expect(String(res.headers['content-type'])).toContain('text/csv');
    const body = res.body as string;
    expect(body.startsWith('﻿区分,純売上,施術売上,店販売上')).toBe(true);
    expect(body).toContain('2025-06,23320,18150,5170,880,2120,6600,4,4,2,1,5830,50');

    const menuCsv = await t.owner.get('/v1/analytics/menus', { ...JUNE, format: 'csv', csvTable: 'category' });
    expect(menuCsv.body).toContain('カット,2,66.7,10450,57.6');
    const ltvCsv = await t.owner.get('/v1/analytics/ltv', { format: 'csv', csvTable: 'source' });
    expect(ltvCsv.body).toContain('instagram,2,13310,13310,2,2,6655');

    const logs = await asSystem(t.organizationId, (ctx) =>
      ctx.trx.selectFrom('audit_logs').select(['metadata']).where('action', '=', 'export.csv').execute(),
    );
    expect(logs.map((l) => (l.metadata as { kind: string }).kind).sort()).toEqual(['analytics.ltv', 'analytics.menus', 'analytics.sales']);
    expect((logs.find((l) => (l.metadata as { kind: string }).kind === 'analytics.sales')!.metadata as { rowCount: number }).rowCount).toBe(1);
  });

  it('isolates tenants', async () => {
    const other = await createTenant('別法人');
    expect((await other.owner.get('/v1/analytics/sales', { shopId: f.t.shopId, ...JUNE })).status).toBe(404);
    expect((await other.owner.post('/v1/analytics/rebuild', { shopId: f.t.shopId, from: D, to: D })).status).toBe(404);
    const own = await other.owner.get('/v1/analytics/sales', JUNE);
    expect(own.body.summary.salesTotal).toBe(0);
    const ltv = await other.owner.get('/v1/analytics/ltv');
    expect(ltv.body.summary.customers).toBe(0);
    const cust = await other.owner.get('/v1/analytics/customers', JUNE);
    expect(cust.body.summary.visitors).toBe(0);
  });
});

describe('analytics triggers', () => {
  it('debounces event-triggered rebuilds per shop-day (transaction + appointment events)', async () => {
    const t = await createTenant();
    const day = '2025-07-15';
    const tx = await insertTransaction(t.organizationId, { shopId: t.shopId, completedAt: jst(day, '13:00'), items: [{ itemType: 'service', unitPrice: 5500 }] });
    for (let i = 0; i < 2; i++) {
      await asSystem(t.organizationId, (ctx) =>
        emit(ctx, {
          type: 'transaction.completed',
          aggregateType: 'transaction',
          aggregateId: tx.id,
          payload: { transactionId: tx.id, shopId: t.shopId, customerId: null, appointmentId: null, total: 5500, completedAt: jst(day, '13:00') },
        }),
      );
    }
    const key = `analytics:${t.shopId}:${day}`;
    const jobs = await asSystem(t.organizationId, (ctx) => ctx.trx.selectFrom('jobs').select(['id', 'run_at', 'state']).where('dedupe_key', '=', key).execute());
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.state).toBe('queued');
    expect(jobs[0]!.run_at.getTime()).toBeGreaterThan(Date.now() + 20_000); // debounce delay

    await runJobs(); // not due yet
    const before = await asSystem(t.organizationId, (ctx) => ctx.trx.selectFrom('analytics_daily_shop').select('sales_total').where('shop_id', '=', t.shopId).where('date', '=', day).execute());
    expect(before).toHaveLength(0);

    await asSystem(t.organizationId, (ctx) => ctx.trx.updateTable('jobs').set({ run_at: new Date() }).where('dedupe_key', '=', key).execute());
    await runJobs();
    const after = await asSystem(t.organizationId, (ctx) =>
      ctx.trx.selectFrom('analytics_daily_shop').select(['sales_total', 'transaction_count']).where('shop_id', '=', t.shopId).where('date', '=', day).executeTakeFirst(),
    );
    expect(after).toEqual({ sales_total: 5500, transaction_count: 1 });

    // appointment events via the real appointments API
    const stylist = await createStaffUser(t, 'stylist');
    const menu = await createMenu(t, { durationMin: 60 });
    const date = nextWeekday(3);
    const created = await t.owner.post('/v1/appointments', { shopId: t.shopId, staffId: stylist.staffId, startAt: jst(date, '11:00'), menuIds: [menu.id] });
    expect(created.status).toBe(201);
    const apptKey = `analytics:${t.shopId}:${date}`;
    await asSystem(t.organizationId, (ctx) => ctx.trx.updateTable('jobs').set({ run_at: new Date() }).where('dedupe_key', '=', apptKey).where('state', '=', 'queued').execute());
    await runJobs();
    const [shopRow, staffRow] = await asSystem(t.organizationId, async (ctx) => [
      await ctx.trx.selectFrom('analytics_daily_shop').select(['appointment_count']).where('shop_id', '=', t.shopId).where('date', '=', date).executeTakeFirst(),
      await ctx.trx.selectFrom('analytics_daily_staff').select(['booked_minutes', 'scheduled_minutes']).where('staff_id', '=', stylist.staffId).where('date', '=', date).executeTakeFirst(),
    ]);
    expect(shopRow).toEqual({ appointment_count: 1 });
    expect(staffRow).toEqual({ booked_minutes: 60, scheduled_minutes: 600 });
  });

  it('nightly job fans out per organization and rebuilds the last 3 days', async () => {
    const t = await createTenant();
    await insertTransaction(t.organizationId, { shopId: t.shopId, completedAt: jst(jstDate(-2), '12:00'), items: [{ itemType: 'service', unitPrice: 3300 }] });
    await withSystem((trx) => enqueue(trx, { type: NIGHTLY_JOB, organizationId: null }));
    await runJobs();
    const rows = await asSystem(t.organizationId, (ctx) =>
      ctx.trx.selectFrom('analytics_daily_shop').select(['date', 'sales_total']).where('shop_id', '=', t.shopId).orderBy('date').execute(),
    );
    expect(rows.map((r) => r.date)).toEqual([jstDate(-3), jstDate(-2), jstDate(-1)]);
    expect(rows.find((r) => r.date === jstDate(-2))!.sales_total).toBe(3300);
  });
});

describe('analytics dashboard', () => {
  it('returns live KPIs for today and month-to-date progress against the target', async () => {
    const t = await createTenant();
    const today = jstDate(0);
    const customer = await createCustomer(t);
    const now = new Date();
    const appt = await insertAppointment(t.organizationId, { shopId: t.shopId, customerId: customer.id, startAt: now, status: 'completed', estimatedTotal: 5500 });
    await insertAppointment(t.organizationId, { shopId: t.shopId, startAt: now, status: 'confirmed', estimatedTotal: 8800 });
    await insertAppointment(t.organizationId, { shopId: t.shopId, startAt: now, status: 'cancelled', estimatedTotal: 3000 });
    await insertAppointment(t.organizationId, { shopId: t.shopId, startAt: now, status: 'no_show', estimatedTotal: 3000 });
    await insertTransaction(t.organizationId, { shopId: t.shopId, customerId: customer.id, appointmentId: appt.id, completedAt: now, items: [{ itemType: 'service', unitPrice: 5500 }] });
    const firstOfMonth = `${today.slice(0, 7)}-01`;
    const past = firstOfMonth < today ? 10000 : 0;
    if (past) {
      await asSystem(t.organizationId, (ctx) =>
        ctx.trx.insertInto('analytics_daily_shop').values({ organization_id: t.organizationId, shop_id: t.shopId, date: firstOfMonth, sales_total: past, customer_count: 2 }).execute(),
      );
    }
    await t.owner.patch('/v1/organization', { settings: { monthlyTargets: { [t.shopId]: 100000 } } });

    const res = await t.owner.get('/v1/analytics/dashboard', { shopId: t.shopId });
    expect(res.status).toBe(200);
    expect(res.body.date).toBe(today);
    const s = res.body.shops[0];
    expect(s.today).toMatchObject({
      appointments: 2,
      expectedSales: 14300, // 5500 completed + 8800 pending (the completed appointment already has a transaction)
      completedSales: 5500,
      transactions: 1,
      newCustomers: 1,
      cancellations: 1,
      noShows: 1,
    });
    expect(s.monthToDate).toMatchObject({ from: firstOfMonth, to: today, sales: past + 5500, target: 100000, achievementRate: (past + 5500) / 1000 });
    expect(res.body.total.monthToDate).toMatchObject({ sales: past + 5500, target: 100000 });

    const csv = await t.owner.get('/v1/analytics/dashboard', { shopId: t.shopId, format: 'csv' });
    expect(csv.body).toContain(',2,14300,5500,1,1,1,');
  });
});
