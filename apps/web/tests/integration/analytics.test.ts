import { beforeAll, describe, expect, it } from 'vitest';
import { localToUtc } from '@salonos/core';
import { prisma } from '@salonos/db';
import {
  cohortRepeat, customerStats, makePeriod, menuRanking, nominationSplit, paymentBreakdown, previousPeriod, resolvePeriod,
  salesByShop, salesSeries, salesTotals, sourcePerformance, staffKpi,
} from '@/lib/server/analytics';
import { recomputeCustomerStats } from '@/lib/server/customers';
import { makeOrg } from './helpers';

const TZ = 'Asia/Tokyo';
const at = (date: string, hh = 12) => localToUtc(date, hh * 60, TZ);

type Item = { kind: 'SERVICE' | 'RETAIL'; price: number; staffId: string; nominated?: boolean; name?: string; menuId?: string | null };
async function tx(orgId: string, shopId: string, o: { customerId?: string | null; date: string; hour?: number; items: Item[]; discount?: number; status?: any; method?: any; refund?: { amount: number; date: string } }) {
  const subtotal = o.items.reduce((s, i) => s + i.price, 0);
  const total = subtotal - (o.discount ?? 0);
  const paidAt = at(o.date, o.hour ?? 12);
  const t = await prisma.transaction.create({
    data: {
      organizationId: orgId, shopId, customerId: o.customerId ?? null, status: o.status ?? (o.refund ? 'PARTIALLY_REFUNDED' : 'PAID'),
      subtotal, discountTotal: o.discount ?? 0, total, taxTotal: Math.floor(total * 10 / 110), refundedTotal: o.refund?.amount ?? 0, paidAt, createdAt: paidAt,
      items: { create: o.items.map((i) => ({ kind: i.kind, name: i.name ?? (i.kind === 'SERVICE' ? 'カット' : 'シャンプー'), menuId: i.menuId ?? null, unitPrice: i.price, staffId: i.staffId, nominated: !!i.nominated })) },
      payments: { create: [{ method: o.method ?? 'CASH', amount: total, createdAt: paidAt }] },
    },
  });
  if (o.refund) await prisma.refund.create({ data: { transactionId: t.id, amount: o.refund.amount, method: 'CASH', createdAt: at(o.refund.date, 15) } });
  return t;
}

describe('analytics (DB)', () => {
  let ctx: Awaited<ReturnType<typeof makeOrg>>;
  let A: string, B: string, s0: string, s1: string, cut: string;
  const p = makePeriod('2025-05-01', '2025-05-31', TZ);

  beforeAll(async () => {
    ctx = await makeOrg({ staff: 2 });
    const { org, shop, staff, menus } = ctx;
    s0 = staff[0].userId; s1 = staff[1].userId;
    cut = menus.find((m) => m.name === 'カット')!.id;
    A = (await prisma.customer.create({ data: { organizationId: org.id, lastName: '既存', firstName: 'A', assignedStaffId: s0 } })).id;
    B = (await prisma.customer.create({ data: { organizationId: org.id, lastName: '新規', firstName: 'B', assignedStaffId: s1 } })).id;

    // before the period: A's first visit
    await tx(org.id, shop.id, { customerId: A, date: '2025-03-20', items: [{ kind: 'SERVICE', price: 4000, staffId: s0 }] });
    // in period
    await tx(org.id, shop.id, {
      customerId: A, date: '2025-05-03', discount: 1200, method: 'CARD',
      items: [{ kind: 'SERVICE', price: 10000, staffId: s0, nominated: true, menuId: cut, name: 'カット' }, { kind: 'RETAIL', price: 2000, staffId: s0 }],
    });
    await tx(org.id, shop.id, { customerId: B, date: '2025-05-10', items: [{ kind: 'SERVICE', price: 5000, staffId: s1, name: 'カラー' }], refund: { amount: 1000, date: '2025-05-12' } });
    await tx(org.id, shop.id, { customerId: null, date: '2025-05-31', hour: 20, items: [{ kind: 'SERVICE', price: 3000, staffId: s1, menuId: cut, name: 'カット' }] });
    // excluded: void & draft & next day (local) boundary
    await tx(org.id, shop.id, { customerId: A, date: '2025-05-20', status: 'VOID', items: [{ kind: 'SERVICE', price: 9999, staffId: s0 }] });
    await tx(org.id, shop.id, { customerId: A, date: '2025-05-21', status: 'DRAFT', items: [{ kind: 'SERVICE', price: 8888, staffId: s0 }] });
    await tx(org.id, shop.id, { customerId: A, date: '2025-06-01', hour: 0, items: [{ kind: 'SERVICE', price: 7777, staffId: s0 }] });
    // after the period: B returns within 90 days
    await tx(org.id, shop.id, { customerId: B, date: '2025-06-15', items: [{ kind: 'SERVICE', price: 5000, staffId: s1 }] });
    await recomputeCustomerStats(A); await recomputeCustomerStats(B);

    await prisma.appointment.createMany({
      data: [
        { organizationId: org.id, shopId: shop.id, customerId: A, staffId: s0, startAt: at('2025-05-03', 10), endAt: at('2025-05-03', 11), status: 'COMPLETED', source: 'WEB', nominated: true },
        { organizationId: org.id, shopId: shop.id, customerId: B, staffId: s1, startAt: at('2025-05-10', 10), endAt: at('2025-05-10', 11), status: 'COMPLETED', source: 'HOTPEPPER' },
        { organizationId: org.id, shopId: shop.id, customerId: B, staffId: s1, startAt: at('2025-05-11', 10), endAt: at('2025-05-11', 11), status: 'CANCELLED', source: 'HOTPEPPER' },
      ],
    });
  });

  it('sales totals: gross, discounts, refunds, net, service/retail, tax, avg ticket', async () => {
    const t = await salesTotals(ctx.org.id, [ctx.shop.id], p);
    expect(t.txCount).toBe(3);
    expect(t.gross).toBe(20000);
    expect(t.discounts).toBe(1200);
    expect(t.sales).toBe(18800);
    expect(t.refunds).toBe(1000);
    expect(t.net).toBe(17800);
    // ticket discount allocated proportionally: 10000*0.9 + 5000 + 3000 / 2000*0.9
    expect(t.service).toBe(17000);
    expect(t.retail).toBe(1800);
    expect(t.service + t.retail).toBe(t.sales);
    expect(t.customers).toBe(2);
    expect(t.walkIns).toBe(1);
    expect(t.avgTicket).toBe(Math.round(18800 / 3));
    expect(t.tax).toBe(Math.floor(10800 * 10 / 110) + Math.floor(5000 * 10 / 110) + Math.floor(3000 * 10 / 110));
  });

  it('new vs repeat customers by first visit', async () => {
    const t = await salesTotals(ctx.org.id, [ctx.shop.id], p);
    expect(t.newCustomers).toBe(1); // B
    expect(t.repeatCustomers).toBe(1); // A
  });

  it('refunds reduce net on the refund date; buckets are shop-local', async () => {
    const s = await salesSeries(ctx.org.id, [ctx.shop.id], p, 'day');
    expect(s.buckets).toHaveLength(31);
    const get = (d: string) => s.points.find((x) => x.bucket === d)!;
    expect(get('2025-05-10')).toMatchObject({ sales: 5000, refunds: 0 });
    expect(get('2025-05-12')).toMatchObject({ sales: 0, refunds: 1000, net: -1000 });
    expect(get('2025-05-31').sales).toBe(3000); // 20:00 JST = 11:00 UTC same day
    const m = await salesSeries(ctx.org.id, [ctx.shop.id], makePeriod('2025-03-01', '2025-06-30', TZ), 'month');
    expect(m.buckets).toEqual(['2025-03', '2025-04', '2025-05', '2025-06']);
    expect(m.points.map((x) => x.sales)).toEqual([4000, 0, 18800, 7777 + 5000]);
  });

  it('shop scoping and payment/nomination/source breakdowns', async () => {
    const other = await makeOrg();
    expect((await salesTotals(other.org.id, [ctx.shop.id], p)).txCount).toBe(0); // org mismatch → nothing
    const [row] = await salesByShop(ctx.org.id, [ctx.shop.id], p);
    expect(row).toMatchObject({ sales: 18800, refunds: 1000, net: 17800, tx: 3 });
    const pay = await paymentBreakdown(ctx.org.id, [ctx.shop.id], p);
    expect(pay).toEqual(expect.arrayContaining([{ method: 'CARD', amount: 10800, count: 1 }, { method: 'CASH', amount: 8000, count: 2 }]));
    const nom = await nominationSplit(ctx.org.id, [ctx.shop.id], p);
    expect(nom).toMatchObject({ nominatedSales: 9000, freeSales: 8000, nominatedTickets: 1, freeTickets: 2, nominatedAppts: 1, freeAppts: 1 });
    const src = await sourcePerformance(ctx.org.id, [ctx.shop.id], p);
    expect(src.find((s) => s.source === 'HOTPEPPER')).toMatchObject({ appointments: 2, completed: 1, cancelled: 1 });
  });

  it('staff KPI: sales net of refunds, nomination rate, repeat within 90 days, assigned LTV', async () => {
    const rows = await staffKpi(ctx.org.id, [ctx.shop.id], p);
    const r0 = rows.find((r) => r.userId === s0)!, r1 = rows.find((r) => r.userId === s1)!;
    expect(r0).toMatchObject({ service: 9000, retail: 1800, total: 10800, tickets: 1, customers: 1, nominationRate: 1, served: 1, returned: 1, repeatRate: 1 }); // A returns 6/1
    expect(r1).toMatchObject({ service: 7000, retail: 0, total: 7000, tickets: 2, nominationRate: 0, served: 1, returned: 1, repeatRate: 1 });
    expect(r0.avgTicket).toBe(10800);
    // A: 4000 + 10800 + 7777 ; B: (5000 - 1000 refund) + 5000 — partial refund stays a visit, LTV is net
    expect(r0.avgAssignedLtv).toBe(4000 + 10800 + 7777);
    expect(r1.avgAssignedLtv).toBe(4000 + 5000);
  });

  it('menu ranking and customer lifecycle / cohort repeat', async () => {
    const menus = await menuRanking(ctx.org.id, [ctx.shop.id], p);
    expect(menus[0]).toMatchObject({ name: 'カット', count: 2, revenue: 12000 });
    const cs = await customerStats(ctx.org.id, null, at('2025-07-01'));
    expect(cs.find((c) => c.id === A)).toMatchObject({ visitCount: 3, lifecycle: 'ACTIVE' });
    const cohorts = await cohortRepeat(ctx.org.id, [ctx.shop.id], TZ, 6, 90, at('2025-08-15'));
    expect(cohorts.find((c) => c.month === '2025-03')).toMatchObject({ newCustomers: 1, returned: 1 }); // A: 3/20 → 5/3 (44 days)
    expect(cohorts.find((c) => c.month === '2025-05')).toMatchObject({ newCustomers: 1, returned: 1, rate: 1 });
  });

  it('periods: presets, custom, and month-to-date comparison', () => {
    const now = new Date('2025-05-20T03:00:00Z');
    const mtd = resolvePeriod({ range: 'thisMonth' }, TZ, now);
    expect([mtd.fromDate, mtd.toDate]).toEqual(['2025-05-01', '2025-05-20']);
    expect([previousPeriod(mtd).fromDate, previousPeriod(mtd).toDate]).toEqual(['2025-04-01', '2025-04-20']);
    const c = resolvePeriod({ from: '2025-02-10', to: '2025-02-01' }, TZ, now);
    expect([c.range, c.fromDate, c.toDate, c.days]).toEqual(['custom', '2025-02-01', '2025-02-10', 10]);
    expect(resolvePeriod({ range: 'lastMonth' }, TZ, now).toDate).toBe('2025-04-30');
  });
});
