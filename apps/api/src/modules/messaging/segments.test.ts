import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import {
  asSystem,
  createCustomer,
  createMenu,
  createStaffUser,
  createTenant,
  daysAgo,
  jst,
  nextWeekday,
  updateCustomer,
  type Tenant,
} from '../../test/helpers.js';

async function preview(t: Tenant, rule: unknown, extra: Record<string, unknown> = {}) {
  const res = await t.owner.post('/v1/segments/preview', { rule, sampleSize: 100, ...extra });
  if (res.status !== 200) throw new Error(`preview failed ${res.status} ${JSON.stringify(res.body)}`);
  return new Set<string>(res.body.sample.map((s: { id: string }) => s.id));
}

async function customer(t: Tenant, patch: Record<string, unknown> = {}, body: Record<string, unknown> = {}) {
  const c = await createCustomer(t, body);
  if (Object.keys(patch).length) await updateCustomer(t, c.id, patch);
  return c.id;
}

async function completedSale(t: Tenant, customerId: string, menuId: string, completedAt: Date) {
  await asSystem(t.organizationId, async (ctx) => {
    const tx = await ctx.trx
      .insertInto('transactions')
      .values({ organization_id: t.organizationId, shop_id: t.shopId, customer_id: customerId, status: 'completed', total: 5000, subtotal: 5000, completed_at: completedAt })
      .returning('id')
      .executeTakeFirstOrThrow();
    await ctx.trx
      .insertInto('transaction_items')
      .values({ organization_id: t.organizationId, transaction_id: tx.id, item_type: 'service', menu_id: menuId, name: 'menu', unit_price: 5000, amount: 5000 })
      .execute();
  });
}

describe('segment DSL', () => {
  it('last_visit_days_gt / lte and no_future_appointment (要件13.1: 45日超かつ次回予約なし)', async () => {
    const t = await createTenant();
    const stylist = await createStaffUser(t, 'stylist');
    const menu = await createMenu(t);
    const dormant = await customer(t, { last_visit_at: daysAgo(50), visit_count: 3 });
    const dormantBooked = await customer(t);
    const recent = await customer(t, { last_visit_at: daysAgo(10), visit_count: 5 });
    const never = await customer(t);
    const appt = await t.owner.post('/v1/appointments', { shopId: t.shopId, customerId: dormantBooked, staffId: stylist.staffId, startAt: jst(nextWeekday(3), '12:00'), menuIds: [menu.id] });
    expect(appt.status).toBe(201);
    // (booking recomputes denormalized stats, so set the visit history afterwards)
    await updateCustomer(t, dormantBooked, { last_visit_at: daysAgo(60), visit_count: 2 });

    expect(await preview(t, { type: 'last_visit_days_gt', days: 45 })).toEqual(new Set([dormant, dormantBooked]));
    expect(await preview(t, { all: [{ type: 'last_visit_days_gt', days: 45 }, { type: 'no_future_appointment' }] })).toEqual(new Set([dormant]));
    expect(await preview(t, { type: 'last_visit_days_lte', days: 30 })).toEqual(new Set([recent]));
    expect(await preview(t, { type: 'has_future_appointment' })).toEqual(new Set([dormantBooked]));
    expect((await preview(t, { type: 'no_future_appointment' })).has(never)).toBe(true);
    const res = await t.owner.post('/v1/segments/preview', { rule: { type: 'last_visit_days_gt', days: 45 } });
    expect(res.body.count).toBe(2);
    expect(res.body.sample[0]).toHaveProperty('display_name');
  });

  it('first_visit_within_days_without_return (初回来店から60日以内に再来店なし)', async () => {
    const t = await createTenant();
    const lapsed = await customer(t, { first_visit_at: daysAgo(70), last_visit_at: daysAgo(70), visit_count: 1 });
    const fresh = await customer(t, { first_visit_at: daysAgo(10), last_visit_at: daysAgo(10), visit_count: 1 });
    const returned = await customer(t, { first_visit_at: daysAgo(90), last_visit_at: daysAgo(30), visit_count: 2 });
    expect(await preview(t, { type: 'first_visit_within_days_without_return', days: 60 })).toEqual(new Set([lapsed]));
    expect(await preview(t, { type: 'first_visit_within_days_without_return', days: 60, windowElapsed: false })).toEqual(new Set([fresh]));
    expect((await preview(t, { type: 'first_visit_within_days_without_return', days: 60 })).has(returned)).toBe(false);
  });

  it('ltv_top_percent uses percent_rank over total sales', async () => {
    const t = await createTenant();
    const ids: string[] = [];
    for (const sales of [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]) ids.push(await customer(t, { total_sales: sales }));
    await customer(t, { total_sales: 0 });
    expect(await preview(t, { type: 'ltv_top_percent', percent: 20 })).toEqual(new Set([ids[9], ids[8]]));
    expect((await preview(t, { type: 'ltv_top_percent', percent: 100 })).size).toBe(10);
  });

  it('used_menu (completed appointments or sales lines, optional window)', async () => {
    const t = await createTenant();
    const cut = await createMenu(t, { name: 'カット' });
    const color = await createMenu(t, { name: 'カラー' });
    const a = await customer(t);
    const b = await customer(t);
    const old = await customer(t);
    await completedSale(t, a, cut.id, daysAgo(5));
    await completedSale(t, b, color.id, daysAgo(5));
    await completedSale(t, old, cut.id, daysAgo(400));
    // completed appointment path
    const viaAppt = await customer(t);
    await asSystem(t.organizationId, async (ctx) => {
      const ap = await ctx.trx
        .insertInto('appointments')
        .values({
          organization_id: t.organizationId,
          shop_id: t.shopId,
          customer_id: viaAppt,
          booking_reference: `T${Date.now()}`,
          start_at: daysAgo(3),
          end_at: new Date(daysAgo(3).getTime() + 3600_000),
          occupied_start_at: daysAgo(3),
          occupied_end_at: new Date(daysAgo(3).getTime() + 3600_000),
          status: 'completed',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await ctx.trx.insertInto('appointment_services').values({ organization_id: t.organizationId, appointment_id: ap.id, menu_id: cut.id, name: 'カット', duration_min: 60, price: 5000 }).execute();
    });
    expect(await preview(t, { type: 'used_menu', menuIds: [cut.id] })).toEqual(new Set([a, old, viaAppt]));
    expect(await preview(t, { type: 'used_menu', menuIds: [cut.id], withinDays: 90 })).toEqual(new Set([a, viaAppt]));
    expect(await preview(t, { type: 'used_menu', menuIds: [cut.id, color.id], withinDays: 90 })).toEqual(new Set([a, b, viaAppt]));
  });

  it('birthday_month (current / specific / next)', async () => {
    const t = await createTenant();
    const now = DateTime.now().setZone('Asia/Tokyo');
    const thisMonth = await customer(t, {}, { birthday: `1990-${String(now.month).padStart(2, '0')}-15` });
    const next = now.plus({ months: 1 });
    const nextMonth = await customer(t, {}, { birthday: `1985-${String(next.month).padStart(2, '0')}-01` });
    await customer(t);
    expect(await preview(t, { type: 'birthday_month' })).toEqual(new Set([thisMonth]));
    expect(await preview(t, { type: 'birthday_month', month: 'next' })).toEqual(new Set([nextMonth]));
    expect(await preview(t, { type: 'birthday_month', month: next.month })).toEqual(new Set([nextMonth]));
  });

  it('primary_staff, shop and tag (any / all)', async () => {
    const t = await createTenant();
    const stylist = await createStaffUser(t, 'stylist');
    const shop2 = (await t.owner.post('/v1/shops', { name: '2号店', slug: `seg-${Date.now()}` })).body;
    const mine = await customer(t, {}, { primaryShopId: t.shopId, primaryStaffId: stylist.staffId });
    const other = await customer(t, {}, { primaryShopId: shop2.id });
    const tagA = (await t.owner.post('/v1/tags', { name: 'VIP' })).body;
    const tagB = (await t.owner.post('/v1/tags', { name: 'カラー好き' })).body;
    await t.owner.put(`/v1/customers/${mine}/tags`, { tagIds: [tagA.id, tagB.id] });
    await t.owner.put(`/v1/customers/${other}/tags`, { tagIds: [tagA.id] });

    expect(await preview(t, { type: 'primary_staff', staffIds: [stylist.staffId] })).toEqual(new Set([mine]));
    expect(await preview(t, { type: 'shop', shopIds: [shop2.id] })).toEqual(new Set([other]));
    expect(await preview(t, { type: 'tag', tagIds: [tagA.id] })).toEqual(new Set([mine, other]));
    expect(await preview(t, { type: 'tag', tagIds: [tagA.id, tagB.id], match: 'all' })).toEqual(new Set([mine]));
    // shop filter parameter of preview
    expect(await preview(t, { type: 'tag', tagIds: [tagA.id] }, { shopId: shop2.id })).toEqual(new Set([other]));
  });

  it('visit_count, no_review, marketing_opt_in and combinators', async () => {
    const t = await createTenant();
    const one = await customer(t, { visit_count: 1 });
    const five = await customer(t, { visit_count: 5 });
    const ten = await customer(t, { visit_count: 10 }, { marketingOptIn: false });
    await asSystem(t.organizationId, (ctx) =>
      ctx.trx.insertInto('reviews').values({ organization_id: t.organizationId, shop_id: t.shopId, customer_id: five, rating: 5, posted_at: daysAgo(100) }).execute(),
    );
    expect(await preview(t, { type: 'visit_count', gte: 2, lte: 9 })).toEqual(new Set([five]));
    expect(await preview(t, { type: 'visit_count', gte: 5 })).toEqual(new Set([five, ten]));
    expect(await preview(t, { type: 'no_review' })).toEqual(new Set([one, ten]));
    expect(await preview(t, { type: 'no_review', withinDays: 30 })).toEqual(new Set([one, five, ten]));
    expect(await preview(t, { type: 'marketing_opt_in' })).toEqual(new Set([one, five]));
    expect(await preview(t, { type: 'marketing_opt_in', value: false })).toEqual(new Set([ten]));
    expect(await preview(t, { any: [{ type: 'visit_count', lte: 1 }, { type: 'visit_count', gte: 10 }] })).toEqual(new Set([one, ten]));
    expect(await preview(t, { not: { type: 'visit_count', gte: 5 } })).toEqual(new Set([one]));
    expect(await preview(t, { all: [{ type: 'no_review' }, { any: [{ type: 'marketing_opt_in' }, { type: 'visit_count', gte: 100 }] }] })).toEqual(new Set([one]));
  });

  it('rejects invalid rules without touching SQL', async () => {
    const t = await createTenant();
    await customer(t);
    const bad = [
      { type: 'unknown' },
      { type: 'last_visit_days_gt', days: "1; DROP TABLE customers; --" },
      { type: 'visit_count' },
      { all: [] },
      { type: 'tag', tagIds: ["x' OR '1'='1"] },
      { type: 'last_visit_days_gt', days: 1, extra: true },
      { not: { not: { not: { not: { not: { not: { type: 'marketing_opt_in' } } } } } } },
    ];
    for (const rule of bad) {
      const res = await t.owner.post('/v1/segments/preview', { rule });
      expect(res.status, JSON.stringify(rule)).toBe(400);
    }
    const ok = await t.owner.post('/v1/segments/preview', { rule: { type: 'marketing_opt_in' } });
    expect(ok.body.count).toBe(1);
  });

  it('CRUD with permissions, customer visibility and tenant isolation', async () => {
    const t = await createTenant();
    const other = await createTenant();
    const created = await t.owner.post('/v1/segments', { name: '休眠45日', rule: { all: [{ type: 'last_visit_days_gt', days: 45 }, { type: 'no_future_appointment' }] } });
    expect(created.status).toBe(201);
    expect((await t.owner.get('/v1/segments')).body.items).toHaveLength(1);
    const upd = await t.owner.patch(`/v1/segments/${created.body.id}`, { name: '休眠60日', rule: { type: 'last_visit_days_gt', days: 60 } });
    expect(upd.body.rule).toEqual({ type: 'last_visit_days_gt', days: 60 });
    expect((await t.owner.patch(`/v1/segments/${created.body.id}`, { rule: { type: 'bogus' } })).status).toBe(400);

    const stylist = await createStaffUser(t, 'stylist');
    expect((await stylist.api.get('/v1/segments')).status).toBe(403);
    expect((await stylist.api.post('/v1/segments/preview', { rule: { type: 'marketing_opt_in' } })).status).toBe(403);
    expect((await other.owner.get(`/v1/segments/${created.body.id}`)).status).toBe(404);
    expect((await other.owner.delete(`/v1/segments/${created.body.id}`)).status).toBe(404);

    // a shop-limited marketer (campaign.manage without customer.read_all_shops) does not see shop 2 customers
    const shop2 = (await t.owner.post('/v1/shops', { name: '2号店', slug: `segv-${Date.now()}` })).body;
    const inShop1 = await customer(t, {}, { primaryShopId: t.shopId });
    const inShop2 = await customer(t, {}, { primaryShopId: shop2.id });
    const role = await t.owner.post('/v1/roles', { key: 'marketer', name: '販促担当', permissions: ['campaign.manage', 'customer.read'] });
    expect(role.status).toBe(201);
    const manager = await createStaffUser(t, 'marketer');
    const mres = await manager.api.post('/v1/segments/preview', { rule: { type: 'marketing_opt_in' }, sampleSize: 50 });
    expect(mres.status).toBe(200);
    const ids = mres.body.sample.map((s: { id: string }) => s.id);
    expect(ids).toContain(inShop1);
    expect(ids).not.toContain(inShop2);
    expect(await preview(t, { type: 'marketing_opt_in' })).toEqual(new Set([inShop1, inShop2]));
    // other tenant's customers never appear
    expect((await other.owner.post('/v1/segments/preview', { rule: { type: 'marketing_opt_in' } })).body.count).toBe(0);

    expect((await t.owner.delete(`/v1/segments/${created.body.id}`)).status).toBe(204);
  });
});
