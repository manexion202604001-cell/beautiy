import { sql } from 'kysely';
import { assertShopAccess, requirePermission, type Ctx } from '../../auth/actor.js';
import { audit } from '../../lib/audit.js';
import { Errors } from '../../lib/errors.js';
import { decodeCursor, paginate } from '../../lib/pagination.js';
import { dayBounds } from '../../lib/time.js';
import { CAPTURED, findOpenSession, loadPosShop, SOLD_STATUSES } from './common.js';
import type { CloseRegisterInput } from './schemas.js';

/**
 * レジ開局・締め (register sessions). Only one open session per shop (partial unique index).
 * expected_cash = opening + cash sales (applied amount, i.e. net of change) + pay_in − pay_out − cash refunds
 */
type SessionRow = NonNullable<Awaited<ReturnType<typeof findOpenSession>>>;

function staffId(ctx: Ctx): string {
  if (ctx.actor.kind !== 'staff') throw Errors.forbidden('スタッフのみ実行できます');
  return ctx.actor.staffId;
}

export async function sessionFigures(ctx: Ctx, session: SessionRow) {
  const [payments, refunds, movements, staff, counts, drafts] = await Promise.all([
    ctx.trx
      .selectFrom('payments as p')
      .innerJoin('transactions as t', 't.id', 'p.transaction_id')
      .leftJoin('custom_payment_methods as cm', 'cm.id', 'p.custom_method_id')
      .select(['p.method', 'cm.name as custom_name', sql<number>`sum(p.amount)::int`.as('amount'), sql<number>`count(*)::int`.as('count')])
      .where('t.register_session_id', '=', session.id)
      .where('p.status', 'in', [...CAPTURED])
      .groupBy(['p.method', 'cm.name'])
      .execute(),
    ctx.trx
      .selectFrom('refunds as r')
      .innerJoin('payments as p', 'p.id', 'r.payment_id')
      .select(['p.method', sql<number>`sum(r.amount)::int`.as('amount')])
      .where('r.register_session_id', '=', session.id)
      .where('r.status', '!=', 'failed')
      .groupBy('p.method')
      .execute(),
    ctx.trx.selectFrom('register_cash_movements').selectAll().where('register_session_id', '=', session.id).orderBy('created_at').execute(),
    ctx.trx
      .selectFrom('transaction_item_staff as tis')
      .innerJoin('transaction_items as ti', 'ti.id', 'tis.transaction_item_id')
      .innerJoin('transactions as t', 't.id', 'ti.transaction_id')
      .innerJoin('staffs as s', 's.id', 'tis.staff_id')
      .select(['tis.staff_id', 's.display_name', sql<number>`sum(tis.allocated_amount)::int`.as('amount'), sql<number>`count(DISTINCT t.id)::int`.as('transactions')])
      .where('t.register_session_id', '=', session.id)
      .where('t.status', 'in', [...SOLD_STATUSES])
      .groupBy(['tis.staff_id', 's.display_name'])
      .orderBy('amount', 'desc')
      .execute(),
    ctx.trx
      .selectFrom('transactions')
      .select([
        sql<number>`count(*) FILTER (WHERE status IN ('completed','partially_refunded','refunded'))::int`.as('completed'),
        sql<number>`count(*) FILTER (WHERE status = 'voided')::int`.as('voided'),
        sql<number>`coalesce(sum(total) FILTER (WHERE status IN ('completed','partially_refunded','refunded')), 0)::int`.as('sales'),
      ])
      .where('register_session_id', '=', session.id)
      .executeTakeFirstOrThrow(),
    ctx.trx.selectFrom('transactions').select(sql<number>`count(*)::int`.as('n')).where('shop_id', '=', session.shop_id).where('status', '=', 'draft').executeTakeFirstOrThrow(),
  ]);
  const byMethod: Record<string, number> = {};
  const customMethods: Record<string, number> = {};
  for (const p of payments) {
    byMethod[p.method] = (byMethod[p.method] ?? 0) + p.amount;
    if (p.method === 'custom') customMethods[p.custom_name ?? '店舗独自決済'] = (customMethods[p.custom_name ?? '店舗独自決済'] ?? 0) + p.amount;
  }
  const refundsByMethod: Record<string, number> = Object.fromEntries(refunds.map((r) => [r.method, r.amount]));
  const payIn = movements.filter((m) => m.movement_type === 'pay_in').reduce((s, m) => s + m.amount, 0);
  const payOut = movements.filter((m) => m.movement_type === 'pay_out').reduce((s, m) => s + m.amount, 0);
  const cashSales = byMethod.cash ?? 0;
  const cashRefunds = refundsByMethod.cash ?? 0;
  const expectedCash = session.opening_cash + cashSales + payIn - payOut - cashRefunds;
  return {
    expectedCash,
    summary: {
      openingCash: session.opening_cash,
      cashSales,
      cashRefunds,
      payIn,
      payOut,
      sales: counts.sales,
      transactionCount: counts.completed,
      voidedCount: counts.voided,
      openDrafts: drafts.n,
      byMethod,
      customMethods,
      refundsByMethod,
      byStaff: staff.map((s) => ({ staffId: s.staff_id, name: s.display_name, amount: s.amount, transactions: s.transactions })),
    },
    movements,
  };
}

export async function openRegister(ctx: Ctx, input: { shopId: string; openingCash: number; note?: string }) {
  requirePermission(ctx.actor, 'register.manage');
  assertShopAccess(ctx.actor, input.shopId);
  await loadPosShop(ctx, input.shopId);
  const existing = await findOpenSession(ctx, input.shopId);
  if (existing) throw Errors.conflict('REGISTER_ALREADY_OPEN', 'この店舗のレジは既に開局しています', { registerSessionId: existing.id });
  let row;
  try {
    row = await ctx.trx
      .insertInto('register_sessions')
      .values({ organization_id: ctx.actor.organizationId, shop_id: input.shopId, opened_by: staffId(ctx), opening_cash: input.openingCash, note: input.note ?? null })
      .returningAll()
      .executeTakeFirstOrThrow();
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw Errors.conflict('REGISTER_ALREADY_OPEN', 'この店舗のレジは既に開局しています');
    throw err;
  }
  await audit(ctx, { action: 'register.open', resourceType: 'register_session', resourceId: row.id, shopId: input.shopId, after: { openingCash: input.openingCash } });
  return row;
}

async function loadSession(ctx: Ctx, id: string, lock = false) {
  let q = ctx.trx.selectFrom('register_sessions').selectAll().where('id', '=', id);
  if (lock) q = q.forUpdate();
  const s = await q.executeTakeFirst();
  if (!s) throw Errors.notFound('レジセッション', id);
  assertShopAccess(ctx.actor, s.shop_id);
  return s;
}

export async function currentRegister(ctx: Ctx, shopId: string) {
  requirePermission(ctx.actor, 'pos.read');
  assertShopAccess(ctx.actor, shopId);
  const s = await findOpenSession(ctx, shopId);
  if (!s) return { session: null };
  const fig = await sessionFigures(ctx, s);
  return { session: { ...s, expected_cash: fig.expectedCash, summary: fig.summary, movements: fig.movements } };
}

export async function getRegisterSession(ctx: Ctx, id: string) {
  requirePermission(ctx.actor, 'pos.read');
  const s = await loadSession(ctx, id);
  const fig = await sessionFigures(ctx, s);
  // closed sessions show the snapshot taken at close; open ones show live figures
  return s.status === 'open' ? { ...s, expected_cash: fig.expectedCash, summary: fig.summary, movements: fig.movements } : { ...s, movements: fig.movements };
}

export async function addCashMovement(ctx: Ctx, id: string, input: { type: 'pay_in' | 'pay_out'; amount: number; reason: string }) {
  requirePermission(ctx.actor, 'register.manage');
  const s = await loadSession(ctx, id, true);
  if (s.status !== 'open') throw Errors.business('REGISTER_CLOSED', 'レジは締め済みです');
  const row = await ctx.trx
    .insertInto('register_cash_movements')
    .values({ organization_id: ctx.actor.organizationId, register_session_id: id, movement_type: input.type, amount: input.amount, reason: input.reason, staff_id: staffId(ctx) })
    .returningAll()
    .executeTakeFirstOrThrow();
  await audit(ctx, { action: `register.${input.type}`, resourceType: 'register_session', resourceId: id, shopId: s.shop_id, after: { amount: input.amount, reason: input.reason } });
  return row;
}

export async function closeRegister(ctx: Ctx, id: string, input: CloseRegisterInput) {
  requirePermission(ctx.actor, 'register.manage');
  const s = await loadSession(ctx, id, true);
  if (s.status !== 'open') throw Errors.business('REGISTER_CLOSED', 'レジは締め済みです');
  let counted = input.countedCash;
  if (input.cashBreakdown) {
    const fromBreakdown = Object.entries(input.cashBreakdown).reduce((sum, [denom, n]) => sum + Number(denom) * n, 0);
    if (counted !== undefined && counted !== fromBreakdown) {
      throw Errors.validation('金種別の合計と実査金額が一致しません', { countedCash: counted, breakdownTotal: fromBreakdown });
    }
    counted = fromBreakdown;
  }
  const fig = await sessionFigures(ctx, s);
  const difference = counted! - fig.expectedCash;
  const closed = await ctx.trx
    .updateTable('register_sessions')
    .set({
      status: 'closed',
      closed_by: staffId(ctx),
      closed_at: new Date(),
      expected_cash: fig.expectedCash,
      counted_cash: counted!,
      difference,
      cash_breakdown: input.cashBreakdown ? JSON.stringify(input.cashBreakdown) : null,
      summary: JSON.stringify(fig.summary),
      note: input.note ?? s.note,
    })
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirstOrThrow();
  await audit(ctx, { action: 'register.close', resourceType: 'register_session', resourceId: id, shopId: s.shop_id, after: { expectedCash: fig.expectedCash, countedCash: counted, difference } });
  return { ...closed, movements: fig.movements };
}

export async function listRegisterSessions(ctx: Ctx, input: { shopId: string; from?: string; to?: string; cursor?: string; limit: number }) {
  requirePermission(ctx.actor, 'pos.read');
  assertShopAccess(ctx.actor, input.shopId);
  const shop = await loadPosShop(ctx, input.shopId);
  let q = ctx.trx.selectFrom('register_sessions').selectAll().where('shop_id', '=', input.shopId).orderBy(sql`date_trunc('milliseconds', opened_at)`, 'desc').orderBy('id', 'desc').limit(input.limit + 1);
  if (input.from) q = q.where('opened_at', '>=', dayBounds(input.from, shop.timezone).start);
  if (input.to) q = q.where('opened_at', '<', dayBounds(input.to, shop.timezone).end);
  const c = decodeCursor(input.cursor);
  if (c) q = q.where(sql<boolean>`(date_trunc('milliseconds', opened_at), id) < (${new Date(String(c.v))}::timestamptz, ${c.id}::uuid)`);
  return paginate(await q.execute(), input.limit, (r) => r.opened_at);
}
