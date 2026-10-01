/* Test-only helpers for the POS / payments suites (not imported by application code). */
import { randomUUID } from 'node:crypto';
import { asSystem, createCustomer, createMenu, createStaffUser, createTenant, jst, nextWeekday, type Api, type Tenant } from '../../test/helpers.js';
import { applyPoints } from './points.js';

export const WED = 3;
export const year = String(new Date().getFullYear());

/** tenant + nominated stylist (指名料 1,100円) + 5,500円 menu + customer */
export async function posSetup() {
  const t = await createTenant();
  const stylist = await createStaffUser(t, 'stylist', { displayName: '指名スタイリスト', nominationFee: 1100 });
  const menu = await createMenu(t, { name: 'カット', price: 5500 });
  const customer = await createCustomer(t);
  return { t, stylist, menu, customer };
}

export async function createProduct(t: Tenant, overrides: { name?: string; price?: number; taxRateBp?: number; stock?: number | null; shopId?: string | null; stockManaged?: boolean } = {}) {
  return asSystem(t.organizationId, async (ctx) => {
    const p = await ctx.trx
      .insertInto('products')
      .values({
        organization_id: t.organizationId,
        shop_id: overrides.shopId ?? null,
        name: overrides.name ?? `シャンプー ${randomUUID().slice(0, 4)}`,
        price: overrides.price ?? 3300,
        tax_rate_bp: overrides.taxRateBp ?? 1000,
        stock_managed: overrides.stockManaged ?? true,
      })
      .returning(['id', 'name'])
      .executeTakeFirstOrThrow();
    if (overrides.stock !== null && overrides.stock !== undefined) {
      await ctx.trx.insertInto('product_stocks').values({ organization_id: t.organizationId, product_id: p.id, shop_id: t.shopId, quantity: overrides.stock }).execute();
    }
    return p;
  });
}

export async function stockOf(t: Tenant, productId: string, shopId = t.shopId): Promise<number | null> {
  return asSystem(t.organizationId, async (ctx) => {
    const r = await ctx.trx.selectFrom('product_stocks').select('quantity').where('product_id', '=', productId).where('shop_id', '=', shopId).executeTakeFirst();
    return r?.quantity ?? null;
  });
}

export async function grantPoints(t: Tenant, customerId: string, points: number) {
  await asSystem(t.organizationId, (ctx) => applyPoints(ctx, { customerId, delta: points, reason: 'adjust', note: 'テスト付与' }));
}

export async function customerRow(t: Tenant, customerId: string) {
  return asSystem(t.organizationId, (ctx) => ctx.trx.selectFrom('customers').selectAll().where('id', '=', customerId).executeTakeFirstOrThrow());
}

export async function openRegister(api: Api, shopId: string, openingCash = 10000) {
  const res = await api.post('/v1/register-sessions/open', { shopId, openingCash });
  if (res.status !== 201) throw new Error(`open register failed ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { id: string };
}

export async function setPosSettings(t: Tenant, pos: Record<string, unknown>) {
  const res = await t.owner.patch(`/v1/shops/${t.shopId}`, { settings: { pos } });
  if (res.status !== 200) throw new Error(`settings failed ${res.status} ${JSON.stringify(res.body)}`);
}

let slot = 0;
/** Book an appointment on a future Wednesday (distinct hour per call to avoid overlaps) */
export async function book(t: Tenant, input: { staffId: string; customerId?: string; menuIds: string[]; couponId?: string; time?: string }) {
  const hour = 10 + (slot++ % 8);
  const res = await t.owner.post('/v1/appointments', {
    shopId: t.shopId,
    staffId: input.staffId,
    customerId: input.customerId,
    menuIds: input.menuIds,
    couponId: input.couponId,
    startAt: jst(nextWeekday(WED), input.time ?? `${String(hour).padStart(2, '0')}:00`),
  });
  if (res.status !== 201) throw new Error(`appointment failed ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { id: string; status: string };
}

let keySeq = 0;
export const key = (prefix = 'k') => `${prefix}-${Date.now()}-${++keySeq}-${randomUUID().slice(0, 6)}`;

/** Create a draft with the given items and pay it in cash */
export async function quickSale(
  api: Api,
  shopId: string,
  items: Record<string, unknown>[],
  opts: { customerId?: string; staffId?: string; complete?: boolean; method?: string; tendered?: number } = {},
) {
  const created = await api.post('/v1/transactions', { shopId, customerId: opts.customerId, staffId: opts.staffId });
  if (created.status !== 201) throw new Error(`create tx failed ${created.status} ${JSON.stringify(created.body)}`);
  const put = await api.put(`/v1/transactions/${created.body.id}/items`, { version: created.body.version, items });
  if (put.status !== 200) throw new Error(`items failed ${put.status} ${JSON.stringify(put.body)}`);
  if (put.body.total > 0) {
    const pay = await api.post(`/v1/transactions/${created.body.id}/payments`, { method: opts.method ?? 'cash', tenderedAmount: opts.tendered, idempotencyKey: key('pay') });
    if (pay.status !== 201) throw new Error(`pay failed ${pay.status} ${JSON.stringify(pay.body)}`);
  }
  if (opts.complete === false) return put.body;
  const done = await api.post(`/v1/transactions/${created.body.id}/complete`);
  if (done.status !== 200) throw new Error(`complete failed ${done.status} ${JSON.stringify(done.body)}`);
  return done.body;
}
