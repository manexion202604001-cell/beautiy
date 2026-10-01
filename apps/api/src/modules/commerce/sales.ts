import { sql } from 'kysely';
import { accessibleShopIds, assertShopAccess, can, requireAnyPermission, type Ctx } from '../../auth/actor.js';
import { audit } from '../../lib/audit.js';
import { dayBounds } from '../../lib/time.js';
import type { SalesQueryInput } from './schemas.js';

/**
 * 商品別 / スタッフ別 売上 (FR-08), read-only:
 *  - online: paid EC orders (paid/processing/shipped/delivered) by paid_at — cancelled orders are excluded;
 *    staff = orders.attributed_staff_id (item subtotal, shipping excluded)
 *  - store:  POS product lines (transaction_items.item_type = 'product') of completed transactions by
 *    completed_at; staff = transaction_item_staff allocation (allocated_amount, or share_bp of the line)
 * Amounts are tax-inclusive line amounts before transaction-level discounts.
 */
const PAID = ['paid', 'processing', 'shipped', 'delivered'];
const COMPLETED = ['completed', 'partially_refunded'];
const NO_SHOP = '00000000-0000-0000-0000-000000000000';

interface Bucket {
  quantity: number;
  amount: number;
  count: number;
}

const empty = (): Bucket => ({ quantity: 0, amount: 0, count: 0 });

export async function commerceSales(ctx: Ctx, input: SalesQueryInput) {
  requireAnyPermission(ctx.actor, 'sales.read', 'sales.read_own');
  const ownStaffId = ctx.actor.kind === 'staff' && !can(ctx.actor, 'sales.read') ? ctx.actor.staffId : null;
  if (input.shopId) assertShopAccess(ctx.actor, input.shopId);
  const accessible = accessibleShopIds(ctx.actor);
  const shopIds = input.shopId ? [input.shopId] : accessible ? (accessible.length ? [...accessible] : [NO_SHOP]) : null;
  const org = await ctx.trx.selectFrom('organizations').select('timezone').where('id', '=', ctx.actor.organizationId).executeTakeFirstOrThrow();
  const start = dayBounds(input.from, org.timezone).start;
  const end = dayBounds(input.to, org.timezone).end;

  const online = new Map<string, Bucket>();
  const store = new Map<string, Bucket>();
  const names = new Map<string, string>();
  const add = (m: Map<string, Bucket>, key: string | null, q: unknown, a: unknown, c: unknown) => {
    const k = key ?? 'unassigned';
    const b = m.get(k) ?? empty();
    b.quantity += Number(q ?? 0);
    b.amount += Number(a ?? 0);
    b.count += Number(c ?? 0);
    m.set(k, b);
  };

  if (input.groupBy === 'product') {
    let oq = ctx.trx
      .selectFrom('order_items as oi')
      .innerJoin('orders as o', 'o.id', 'oi.order_id')
      .select(['oi.product_id', sql<string>`max(oi.name)`.as('name'), sql<number>`sum(oi.quantity)`.as('qty'), sql<number>`sum(oi.amount)`.as('amount'), sql<number>`count(DISTINCT o.id)`.as('cnt')])
      .where('o.status', 'in', PAID)
      .where('o.paid_at', '>=', start)
      .where('o.paid_at', '<', end)
      .groupBy('oi.product_id');
    if (shopIds) oq = oq.where((eb) => eb.or([eb('o.shop_id', 'in', shopIds), ...(input.shopId ? [] : [eb('o.shop_id', 'is', null)])]));
    if (ownStaffId) oq = oq.where('o.attributed_staff_id', '=', ownStaffId);
    for (const r of await oq.execute()) {
      add(online, r.product_id, r.qty, r.amount, r.cnt);
      names.set(r.product_id, r.name);
    }

    let pq = ctx.trx
      .selectFrom('transaction_items as ti')
      .innerJoin('transactions as t', 't.id', 'ti.transaction_id')
      .select(['ti.product_id', sql<string>`max(ti.name)`.as('name'), sql<number>`sum(ti.quantity)`.as('qty'), sql<number>`sum(ti.amount)`.as('amount'), sql<number>`count(DISTINCT t.id)`.as('cnt')])
      .where('ti.item_type', '=', 'product')
      .where('t.status', 'in', COMPLETED)
      .where('t.completed_at', '>=', start)
      .where('t.completed_at', '<', end)
      .groupBy('ti.product_id');
    if (shopIds) pq = pq.where('t.shop_id', 'in', shopIds);
    if (ownStaffId) {
      pq = pq.where((eb) => eb.exists(eb.selectFrom('transaction_item_staff as s').select(sql`1`.as('x')).whereRef('s.transaction_item_id', '=', 'ti.id').where('s.staff_id', '=', ownStaffId)));
    }
    for (const r of await pq.execute()) {
      add(store, r.product_id, r.qty, r.amount, r.cnt);
      if (r.product_id && !names.has(r.product_id)) names.set(r.product_id, r.name);
    }
  } else {
    let oq = ctx.trx
      .selectFrom('orders as o')
      .select(['o.attributed_staff_id', sql<number>`sum((SELECT coalesce(sum(quantity), 0) FROM order_items WHERE order_id = o.id))`.as('qty'), sql<number>`sum(o.subtotal)`.as('amount'), sql<number>`count(*)`.as('cnt')])
      .where('o.status', 'in', PAID)
      .where('o.paid_at', '>=', start)
      .where('o.paid_at', '<', end)
      .groupBy('o.attributed_staff_id');
    if (shopIds) oq = oq.where((eb) => eb.or([eb('o.shop_id', 'in', shopIds), ...(input.shopId ? [] : [eb('o.shop_id', 'is', null)])]));
    if (ownStaffId) oq = oq.where('o.attributed_staff_id', '=', ownStaffId);
    for (const r of await oq.execute()) add(online, r.attributed_staff_id, r.qty, r.amount, r.cnt);

    let pq = ctx.trx
      .selectFrom('transaction_item_staff as s')
      .innerJoin('transaction_items as ti', 'ti.id', 's.transaction_item_id')
      .innerJoin('transactions as t', 't.id', 'ti.transaction_id')
      .select([
        's.staff_id',
        sql<number>`sum(ti.quantity)`.as('qty'),
        sql<number>`sum(CASE WHEN s.allocated_amount = 0 AND s.share_bp > 0 THEN round(ti.amount * s.share_bp / 10000.0) ELSE s.allocated_amount END)`.as('amount'),
        sql<number>`count(DISTINCT t.id)`.as('cnt'),
      ])
      .where('ti.item_type', '=', 'product')
      .where('t.status', 'in', COMPLETED)
      .where('t.completed_at', '>=', start)
      .where('t.completed_at', '<', end)
      .groupBy('s.staff_id');
    if (shopIds) pq = pq.where('t.shop_id', 'in', shopIds);
    if (ownStaffId) pq = pq.where('s.staff_id', '=', ownStaffId);
    for (const r of await pq.execute()) add(store, r.staff_id, r.qty, r.amount, r.cnt);

    const ids = [...new Set([...online.keys(), ...store.keys()])].filter((k) => k !== 'unassigned');
    if (ids.length) for (const s of await ctx.trx.selectFrom('staffs').select(['id', 'display_name']).where('id', 'in', ids).execute()) names.set(s.id, s.display_name);
  }

  if (input.groupBy === 'product') {
    const ids = [...new Set([...online.keys(), ...store.keys()])].filter((k) => k !== 'unassigned');
    if (ids.length) for (const p of await ctx.trx.selectFrom('products').select(['id', 'name']).where('id', 'in', ids).execute()) names.set(p.id, p.name);
  }

  const keys = [...new Set([...online.keys(), ...store.keys()])];
  const rows = keys
    .map((k) => {
      const o = online.get(k) ?? empty();
      const s = store.get(k) ?? empty();
      return {
        [input.groupBy === 'product' ? 'productId' : 'staffId']: k === 'unassigned' ? null : k,
        name: k === 'unassigned' ? (input.groupBy === 'staff' ? '担当なし' : '不明な商品') : (names.get(k) ?? ''),
        online: { quantity: o.quantity, amount: o.amount, orders: o.count },
        store: { quantity: s.quantity, amount: s.amount, transactions: s.count },
        quantity: o.quantity + s.quantity,
        total: o.amount + s.amount,
      };
    })
    .sort((a, b) => b.total - a.total);
  const totals = rows.reduce((acc, r) => ({ online: acc.online + r.online.amount, store: acc.store + r.store.amount, total: acc.total + r.total }), { online: 0, store: 0, total: 0 });
  await audit(ctx, { action: 'sales.view', resourceType: 'commerce_sales', shopId: input.shopId ?? null, metadata: { from: input.from, to: input.to, groupBy: input.groupBy, ownOnly: !!ownStaffId } });
  return { from: input.from, to: input.to, groupBy: input.groupBy, rows, totals };
}
