// POS service: tickets (drafts), checkout, refunds/voids, points and register sessions.
// All money is integer JPY, tax-inclusive (内税). Every mutation is tenant-scoped via a
// PosActor (org + accessible shops) so it can run from server actions, webhooks and tests.
import type { PaymentMethod, Prisma, TransactionStatus } from '@salonos/db';
import {
  ACTIVE_STATUSES, addDays, computeTicket, expectedCash, lineAmount, localToUtc, settle, toLocalParts, validateRefund,
  type CouponRule, type TicketLine, type TicketTotals,
} from '@salonos/core';
import { randomToken } from '@salonos/core/crypto';
import { prisma, type Tx } from './db';
import { AppError, ForbiddenError, NotFoundError } from './errors';
import { audit } from './audit';
import { pointsBalance, recomputeCustomerStats } from './customers';
import { lockKeys } from './booking';
import type { StaffContext } from './session';
import { createCheckoutSession, createStripeRefund, retrievePaymentIntent, stripeConfig } from './payments/stripe';
import { env } from './env';
import { createSquareRefund, createTerminalCheckout, retrieveSquarePayment, squareConfig, squareRef } from './payments/square';
import {
  CASH_TENDER_PREFIX, POINT_REASON, draftSchema, tenderSchema,
  type DraftInput, type DraftLine, type TenderInput,
} from '../pos-shared';

export interface PosActor { orgId: string; userId: string | null; shopIds: string[] }

export function actorOf(ctx: Pick<StaffContext, 'org' | 'user' | 'shops'>): PosActor {
  return { orgId: ctx.org.id, userId: ctx.user.id, shopIds: ctx.shops.map((s) => s.id) };
}

const auditActor = (a: PosActor) => ({ orgId: a.orgId, userId: a.userId });

function assertShopAccess(a: PosActor, shopId: string) {
  if (!a.shopIds.includes(shopId)) throw new ForbiddenError('この店舗へのアクセス権がありません');
}

const TX_OPTS = { timeout: 20000, maxWait: 15000 } as const;
export const PAID_STATUSES: TransactionStatus[] = ['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'];

type Db = Tx | typeof prisma;

// ───────────────────────── validation helpers ─────────────────────────

async function loadShop(db: Db, orgId: string, shopId: string) {
  const shop = await db.shop.findFirst({ where: { id: shopId, organizationId: orgId }, select: { id: true, name: true, timezone: true, taxRatePct: true, pointRatePct: true } });
  if (!shop) throw new NotFoundError('店舗が見つかりません');
  return shop;
}

async function assertCustomer(db: Db, orgId: string, customerId: string) {
  const c = await db.customer.findFirst({ where: { id: customerId, organizationId: orgId, mergedIntoId: null, deletedAt: null }, select: { id: true, visitCount: true } });
  if (!c) throw new NotFoundError('顧客が見つかりません');
  return c;
}

/** Menus must belong to the shop, products and staff to the organization. */
async function validateLines(db: Db, orgId: string, shopId: string, lines: DraftLine[]) {
  const menuIds = [...new Set(lines.map((l) => l.menuId).filter(Boolean) as string[])];
  const productIds = [...new Set(lines.map((l) => l.productId).filter(Boolean) as string[])];
  const staffIds = [...new Set(lines.map((l) => l.staffId).filter(Boolean) as string[])];
  const [menus, products, staff] = await Promise.all([
    menuIds.length ? db.menu.findMany({ where: { id: { in: menuIds }, shopId, organizationId: orgId }, select: { id: true } }) : [],
    productIds.length ? db.product.findMany({ where: { id: { in: productIds }, organizationId: orgId }, select: { id: true } }) : [],
    staffIds.length ? db.membership.findMany({ where: { organizationId: orgId, userId: { in: staffIds } }, select: { userId: true } }) : [],
  ]);
  if (menus.length !== menuIds.length) throw new AppError('この店舗のメニューではない明細が含まれています');
  if (products.length !== productIds.length) throw new AppError('登録されていない商品が含まれています');
  if (staff.length !== staffIds.length) throw new AppError('担当スタッフが見つかりません');
  for (const l of lines) {
    if (l.kind === 'RETAIL' && !l.productId) throw new AppError(`店販明細「${l.name}」に商品が指定されていません`);
    if (l.kind !== 'RETAIL' && l.productId) throw new AppError(`「${l.name}」は店販明細として登録してください`);
    if (l.discount > l.unitPrice * l.quantity) throw new AppError(`「${l.name}」の値引きが金額を超えています`);
  }
}

export interface CouponRow { id: string; name: string; discountType: string; discountValue: number; menuIds: string[]; newCustomerOnly: boolean; validFrom: Date | null; validTo: Date | null; active: boolean }

/** Returns the coupon when it may be applied to this ticket, otherwise throws with the reason. */
async function validateCoupon(db: Db, orgId: string, shopId: string, couponId: string, opts: { customerId?: string | null; lines: { menuId?: string | null }[]; now?: Date }): Promise<CouponRow> {
  const c = await db.coupon.findFirst({ where: { id: couponId, organizationId: orgId, shopId } });
  if (!c) throw new AppError('クーポンが見つかりません');
  const now = opts.now ?? new Date();
  if (!c.active) throw new AppError(`クーポン「${c.name}」は無効です`);
  if (c.validFrom && c.validFrom > now) throw new AppError(`クーポン「${c.name}」はまだ利用できません`);
  if (c.validTo && c.validTo < now) throw new AppError(`クーポン「${c.name}」は有効期限切れです`);
  if (c.menuIds.length && !opts.lines.some((l) => l.menuId && c.menuIds.includes(l.menuId))) throw new AppError(`クーポン「${c.name}」の対象メニューが明細にありません`);
  if (c.newCustomerOnly && opts.customerId) {
    const visits = await db.transaction.count({ where: { customerId: opts.customerId, status: { in: ['PAID', 'PARTIALLY_REFUNDED'] } } });
    if (visits > 0) throw new AppError(`クーポン「${c.name}」は新規のお客様限定です`);
  }
  return c;
}

export const couponRule = (c: Pick<CouponRow, 'discountType' | 'discountValue'> | null | undefined): CouponRule | null =>
  c ? { discountType: c.discountType === 'PERCENT' ? 'PERCENT' : 'AMOUNT', discountValue: c.discountValue } : null;

const ticketLines = (items: { kind: string; name: string; unitPrice: number; quantity: number; discount: number }[]): TicketLine[] =>
  items.map((i) => ({ kind: (i.kind === 'RETAIL' ? 'RETAIL' : i.kind === 'OTHER' ? 'OTHER' : 'SERVICE') as TicketLine['kind'], name: i.name, unitPrice: i.unitPrice, quantity: i.quantity, discount: i.discount }));

/**
 * The manual (whole-ticket) discount is not stored separately: it is the part of
 * discountTotal not explained by line discounts and the coupon.
 */
export function deriveManualDiscount(t: { discountTotal: number; items: { kind: string; name: string; unitPrice: number; quantity: number; discount: number }[] }, coupon: CouponRule | null): number {
  const base = computeTicket({ lines: ticketLines(t.items), coupon, taxRatePct: 0, pointRatePct: 0 });
  return Math.max(0, t.discountTotal - base.lineDiscounts - base.couponDiscount);
}

/** Split a ticket total into service vs retail in proportion to line amounts. */
export function splitServiceRetail(items: { kind: string; unitPrice: number; quantity: number; discount: number }[], total: number) {
  let gross = 0, retail = 0;
  for (const i of items) {
    const a = lineAmount({ kind: 'SERVICE', name: '', unitPrice: i.unitPrice, quantity: i.quantity, discount: i.discount });
    gross += a;
    if (i.kind === 'RETAIL') retail += a;
  }
  const retailTotal = gross > 0 ? Math.round((retail * total) / gross) : 0;
  return { serviceTotal: total - retailTotal, retailTotal };
}

type ApptForDraft = { id: string; shopId: string; staffId: string | null; nominated: boolean; couponId: string | null; customerId: string | null; menus: { menuId: string | null; name: string; price: number }[] };

/** Ticket lines for an appointment: menus (staff attributed), nomination fee, applicable coupon. */
export async function appointmentLines(orgId: string, appt: ApptForDraft): Promise<{ lines: DraftLine[]; coupon: CouponRow | null }> {
  const lines: DraftLine[] = appt.menus.map((m) => ({
    kind: 'SERVICE', menuId: m.menuId, productId: null, name: m.name, unitPrice: m.price, quantity: 1, discount: 0,
    staffId: appt.staffId, nominated: appt.nominated,
  }));
  if (lines.some((l) => l.menuId)) {
    // drop menu ids that no longer exist in this shop (deleted menus keep their name/price)
    const alive = new Set((await prisma.menu.findMany({ where: { id: { in: lines.map((l) => l.menuId!).filter(Boolean) }, shopId: appt.shopId }, select: { id: true } })).map((m) => m.id));
    for (const l of lines) if (l.menuId && !alive.has(l.menuId)) l.menuId = null;
  }
  if (appt.nominated && appt.staffId) {
    const m = await prisma.membership.findFirst({ where: { organizationId: orgId, userId: appt.staffId }, select: { nominationFee: true } });
    if (m && m.nominationFee > 0) lines.push({ kind: 'OTHER', menuId: null, productId: null, name: '指名料', unitPrice: m.nominationFee, quantity: 1, discount: 0, staffId: appt.staffId, nominated: true });
  }
  let coupon: CouponRow | null = null;
  if (appt.couponId) coupon = await validateCoupon(prisma, orgId, appt.shopId, appt.couponId, { customerId: appt.customerId, lines }).catch(() => null);
  return { lines, coupon };
}

// ───────────────────────── drafts ─────────────────────────

export interface CreateDraftInput { shopId: string; appointmentId?: string | null; customerId?: string | null }

/**
 * Open a ticket. From an appointment the lines come from AppointmentMenu with staff
 * attribution, nominated flag, nomination fee and coupon. Transaction.appointmentId is
 * unique, so an existing draft for the appointment is reused.
 */
export async function createDraft(actor: PosActor, input: CreateDraftInput): Promise<{ id: string; created: boolean }> {
  if (input.appointmentId) {
    const appt = await prisma.appointment.findFirst({ where: { id: input.appointmentId, organizationId: actor.orgId }, include: { menus: true, transaction: true } });
    if (!appt) throw new NotFoundError('予約が見つかりません');
    assertShopAccess(actor, appt.shopId);
    if (appt.transaction) {
      if (appt.transaction.status === 'DRAFT') return { id: appt.transaction.id, created: false };
      throw new AppError('この予約は既に会計済みです', 'ALREADY_PAID', 409);
    }
    const shop = await loadShop(prisma, actor.orgId, appt.shopId);
    const { lines, coupon } = await appointmentLines(actor.orgId, appt);
    const balance = appt.customerId ? await pointsBalance(appt.customerId) : 0;
    const totals = computeTicket({ lines: ticketLines(lines), coupon: couponRule(coupon), taxRatePct: shop.taxRatePct, pointRatePct: shop.pointRatePct, pointsBalance: balance });
    try {
      const t = await prisma.transaction.create({
        data: {
          organizationId: actor.orgId, shopId: appt.shopId, appointmentId: appt.id, customerId: appt.customerId, staffId: appt.staffId,
          couponId: coupon?.id ?? null, createdById: actor.userId, ...totalsColumns(totals, !!appt.customerId),
          items: { create: lines.map(itemData) },
        },
      });
      return { id: t.id, created: true };
    } catch (e: any) {
      if (e?.code === 'P2002') {
        const existing = await prisma.transaction.findUnique({ where: { appointmentId: appt.id } });
        if (existing?.status === 'DRAFT') return { id: existing.id, created: false };
        if (existing) throw new AppError('この予約は既に会計済みです', 'ALREADY_PAID', 409);
      }
      throw e;
    }
  }
  assertShopAccess(actor, input.shopId);
  await loadShop(prisma, actor.orgId, input.shopId);
  if (input.customerId) await assertCustomer(prisma, actor.orgId, input.customerId);
  const t = await prisma.transaction.create({
    data: { organizationId: actor.orgId, shopId: input.shopId, customerId: input.customerId ?? null, createdById: actor.userId },
  });
  return { id: t.id, created: true };
}

function itemData(l: DraftLine) {
  return {
    kind: l.kind, menuId: l.menuId ?? null, productId: l.productId ?? null, name: l.name, unitPrice: l.unitPrice,
    quantity: l.quantity, discount: l.discount ?? 0, staffId: l.staffId ?? null, nominated: !!l.nominated,
  };
}

function totalsColumns(t: TicketTotals, hasCustomer: boolean) {
  return {
    subtotal: t.subtotal, discountTotal: t.discountTotal, taxTotal: t.taxTotal, total: t.total,
    pointsUsed: hasCustomer ? t.pointsUsed : 0, pointsEarned: hasCustomer ? t.pointsEarned : 0,
  };
}

async function lockTransaction(db: Tx, id: string) {
  await db.$queryRaw`SELECT id FROM "Transaction" WHERE id = ${id} FOR UPDATE`;
}

/** Replace the lines/discounts of a DRAFT and persist recomputed totals. */
export async function updateDraft(actor: PosActor, id: string, raw: DraftInput): Promise<{ id: string; totals: TicketTotals }> {
  const input = draftSchema.parse(raw);
  return prisma.$transaction(async (db) => {
    await lockTransaction(db, id);
    const t = await db.transaction.findFirst({ where: { id, organizationId: actor.orgId } });
    if (!t) throw new NotFoundError('会計が見つかりません');
    assertShopAccess(actor, t.shopId);
    if (t.status !== 'DRAFT') throw new AppError('確定済みの会計は編集できません', 'ALREADY_PAID', 409);
    const shop = await loadShop(db, actor.orgId, t.shopId);
    const customerId = input.customerId === undefined ? t.customerId : input.customerId;
    if (customerId && customerId !== t.customerId) await assertCustomer(db, actor.orgId, customerId);
    await validateLines(db, actor.orgId, t.shopId, input.lines);
    if (input.staffId) {
      const m = await db.membership.findFirst({ where: { organizationId: actor.orgId, userId: input.staffId } });
      if (!m) throw new AppError('担当スタッフが見つかりません');
    }
    const coupon = input.couponId ? await validateCoupon(db, actor.orgId, t.shopId, input.couponId, { customerId, lines: input.lines }) : null;
    const balance = customerId ? await pointsBalance(customerId, db) : 0;
    if (!customerId && input.pointsToUse > 0) throw new AppError('ポイントを利用するにはお客様を選択してください');
    if (input.pointsToUse > balance) throw new AppError(`ポイント残高（${balance.toLocaleString()}pt）を超えています`);
    const totals = computeTicket({
      lines: ticketLines(input.lines), coupon: couponRule(coupon), manualDiscount: input.manualDiscount,
      pointsToUse: input.pointsToUse, pointsBalance: balance, taxRatePct: shop.taxRatePct, pointRatePct: shop.pointRatePct,
    });
    await db.transactionItem.deleteMany({ where: { transactionId: id } });
    if (input.lines.length) await db.transactionItem.createMany({ data: input.lines.map((l) => ({ ...itemData(l), transactionId: id })) });
    const staffId = input.staffId ?? t.staffId ?? input.lines.find((l) => l.staffId)?.staffId ?? null;
    await db.transaction.update({
      where: { id },
      data: { customerId: customerId ?? null, staffId, couponId: coupon?.id ?? null, note: input.note ?? null, ...totalsColumns(totals, !!customerId) },
    });
    return { id, totals };
  }, TX_OPTS);
}

/** Create-or-update convenience used by the checkout screen. */
export async function saveDraft(actor: PosActor, input: { transactionId?: string | null; shopId: string; appointmentId?: string | null; draft: DraftInput }) {
  let id = input.transactionId ?? null;
  if (!id) id = (await createDraft(actor, { shopId: input.shopId, appointmentId: input.appointmentId, customerId: input.draft.customerId })).id;
  return updateDraft(actor, id, input.draft);
}

// ───────────────────────── checkout ─────────────────────────

export interface CheckoutInput {
  tenders: TenderInput[];
  /** Total the cashier saw; a mismatch means the ticket changed underneath them. */
  expectedTotal?: number;
}

export interface CheckoutResult { id: string; number: number; total: number; change: number; pointsEarned: number; pointsUsed: number }

interface PreparedTender { method: PaymentMethod; amount: number; label: string | null; provider: string | null; externalRef: string | null; status: 'SUCCEEDED' }

/** Card-present / provider tenders: verify provider references before touching the ledger. */
async function prepareTenders(actor: PosActor, shopId: string, tenders: TenderInput[], providerVerified: boolean): Promise<PreparedTender[]> {
  const out: PreparedTender[] = [];
  for (const raw of tenders) {
    const t = { ...tenderSchema.parse(raw), externalRef: raw.externalRef ?? null };
    if (t.amount <= 0) continue;
    if (t.method === 'CUSTOM' && !t.label) throw new AppError('「その他」の支払い方法には名称を入力してください');
    let label = t.label || null;
    let externalRef = t.externalRef;
    let provider: string | null = null;
    if (t.method === 'CARD' || t.method === 'EMONEY' || t.method === 'QR') {
      // External terminal: recorded manually with an optional approval/reference number.
      if (t.reference) label = [label, `承認番号 ${t.reference}`].filter(Boolean).join(' ');
    }
    if (t.method === 'STRIPE' || t.method === 'SQUARE') {
      provider = t.method;
      if (!providerVerified) {
        if (t.reference) {
          const r = t.method === 'STRIPE' ? await retrievePaymentIntent(actor.orgId, t.reference, shopId) : await retrieveSquarePayment(actor.orgId, t.reference, shopId);
          const ok = t.method === 'STRIPE' ? r.status === 'succeeded' : r.status === 'COMPLETED';
          if (!ok) throw new AppError(`${t.method === 'STRIPE' ? 'Stripe' : 'Square'}の決済が完了していません（${r.status}）`);
          if (!r.sandbox && r.amount !== t.amount) throw new AppError(`決済額（¥${r.amount.toLocaleString()}）と支払額が一致しません`);
          externalRef = r.sandbox ? `sandbox_${t.method.toLowerCase()}_${randomToken(12)}` : r.id;
          if (r.sandbox) label = [label, `参照 ${t.reference}`, 'サンドボックス'].filter(Boolean).join(' ');
        } else {
          const live = t.method === 'STRIPE' ? (await stripeConfig(actor.orgId, shopId)).live : (await squareConfig(actor.orgId, shopId)).live;
          if (live) throw new AppError(`${t.method === 'STRIPE' ? 'Stripe' : 'Square'}の決済IDを入力するか、決済リンク／端末決済をご利用ください`);
          externalRef = `sandbox_${t.method.toLowerCase()}_${randomToken(12)}`;
          label = [label, 'サンドボックス'].filter(Boolean).join(' ');
        }
      }
    }
    out.push({ method: t.method as PaymentMethod, amount: t.amount, label, provider, externalRef, status: 'SUCCEEDED' });
  }
  return out;
}

/**
 * Finalize a DRAFT in one DB transaction: payments, PAID status, register session,
 * points ledger, stock, appointment completion. The row lock + status check makes
 * concurrent checkouts of the same ticket fail cleanly (only DRAFT can be paid).
 */
export async function checkout(actor: PosActor, id: string, input: CheckoutInput, opts: { providerVerified?: boolean } = {}): Promise<CheckoutResult> {
  const pre = await prisma.transaction.findFirst({ where: { id, organizationId: actor.orgId }, select: { shopId: true, status: true } });
  if (!pre) throw new NotFoundError('会計が見つかりません');
  assertShopAccess(actor, pre.shopId);
  if (pre.status !== 'DRAFT') throw new AppError('この会計は既に確定済みです', 'ALREADY_PAID', 409);
  const tenders = await prepareTenders(actor, pre.shopId, input.tenders, !!opts.providerVerified);

  const result = await prisma.$transaction(async (db) => {
    await lockTransaction(db, id);
    const t = await db.transaction.findFirst({ where: { id, organizationId: actor.orgId }, include: { items: true, appointment: { select: { id: true, status: true } } } });
    if (!t) throw new NotFoundError('会計が見つかりません');
    if (t.status !== 'DRAFT') throw new AppError('この会計は既に確定済みです', 'ALREADY_PAID', 409);
    if (!t.items.length) throw new AppError('明細がありません');
    const shop = await loadShop(db, actor.orgId, t.shopId);

    let balance = 0;
    if (t.customerId) {
      await lockKeys(db, [`points:${t.customerId}`]);
      balance = await pointsBalance(t.customerId, db);
    }
    if (t.pointsUsed > balance) throw new AppError(`ポイント残高（${balance.toLocaleString()}pt）が不足しています`);
    const coupon = t.couponId ? await validateCoupon(db, actor.orgId, t.shopId, t.couponId, { customerId: t.customerId, lines: t.items }) : null;
    const rule = couponRule(coupon);
    const manualDiscount = deriveManualDiscount(t, rule);
    const totals = computeTicket({
      lines: ticketLines(t.items), coupon: rule, manualDiscount, pointsToUse: t.pointsUsed, pointsBalance: balance,
      taxRatePct: shop.taxRatePct, pointRatePct: shop.pointRatePct,
    });
    if (input.expectedTotal !== undefined && input.expectedTotal !== totals.total) {
      throw new AppError('金額が変更されています。画面を更新して内容を再確認してください', 'STALE', 409);
    }
    const s = settle(totals.total, tenders);
    if (!s.ok) throw new AppError(s.error ?? '支払額が不足しています');

    const hasCash = tenders.some((x) => x.method === 'CASH');
    await lockKeys(db, [`register:${t.shopId}`]);
    const register = await db.registerSession.findFirst({ where: { shopId: t.shopId, closedAt: null }, orderBy: { openedAt: 'desc' } });
    if (hasCash && !register) throw new AppError('レジが開いていません。レジ開けを行ってから現金会計してください', 'REGISTER_CLOSED');

    const claimed = await db.transaction.updateMany({
      where: { id, status: 'DRAFT' },
      data: {
        status: 'PAID', paidAt: new Date(), registerSessionId: register?.id ?? null,
        staffId: t.staffId ?? t.items.find((i) => i.staffId)?.staffId ?? null,
        ...totalsColumns(totals, !!t.customerId),
      },
    });
    if (claimed.count !== 1) throw new AppError('この会計は既に確定済みです', 'ALREADY_PAID', 409);

    const cashTendered = tenders.filter((x) => x.method === 'CASH').reduce((a, x) => a + x.amount, 0);
    const rows: Prisma.PaymentCreateManyInput[] = tenders.filter((x) => x.method !== 'CASH').map((x) => ({
      transactionId: id, method: x.method, amount: x.amount, label: x.label, provider: x.provider, externalRef: x.externalRef, status: x.status,
    }));
    if (cashTendered > 0) rows.push({ transactionId: id, method: 'CASH', amount: cashTendered - s.change, label: `${CASH_TENDER_PREFIX}${cashTendered}`, status: 'SUCCEEDED' });
    if (rows.length) await db.payment.createMany({ data: rows });

    const pointsEarned = t.customerId ? totals.pointsEarned : 0;
    const pointsUsed = t.customerId ? totals.pointsUsed : 0;
    if (t.customerId) {
      const ledger: Prisma.PointLedgerCreateManyInput[] = [];
      if (pointsUsed > 0) ledger.push({ organizationId: actor.orgId, customerId: t.customerId, delta: -pointsUsed, reason: POINT_REASON.USE, transactionId: id });
      if (pointsEarned > 0) ledger.push({ organizationId: actor.orgId, customerId: t.customerId, delta: pointsEarned, reason: POINT_REASON.EARN, transactionId: id });
      if (ledger.length) await db.pointLedger.createMany({ data: ledger });
    }
    for (const i of t.items) {
      if (i.kind === 'RETAIL' && i.productId) await db.product.updateMany({ where: { id: i.productId, organizationId: actor.orgId }, data: { stock: { decrement: i.quantity } } });
    }
    // Appointment → COMPLETED (visit happened). Cancelled/no-show appointments (e.g. cancellation fees) keep their status.
    if (t.appointment && t.appointment.status !== 'COMPLETED' && (ACTIVE_STATUSES as readonly string[]).includes(t.appointment.status)) {
      await db.appointment.update({ where: { id: t.appointment.id }, data: { status: 'COMPLETED' } });
    }
    await audit(auditActor(actor), 'pos.checkout', 'Transaction', id, {
      number: t.number, total: totals.total, methods: tenders.map((x) => x.method), change: s.change, pointsUsed, pointsEarned,
    }, db);
    return { id, number: t.number, total: totals.total, change: s.change, pointsEarned, pointsUsed, customerId: t.customerId };
  }, TX_OPTS);

  if (result.customerId) await recomputeCustomerStats(result.customerId);
  const { customerId: _c, ...out } = result;
  return out;
}

// ───────────────────────── refunds / void ─────────────────────────

export interface RefundInput {
  amount: number;
  method: PaymentMethod;
  reason?: string | null;
  /** Retail lines to put back in stock. */
  restock?: { itemId: string; quantity: number }[];
  /** Provider refund id (webhook-originated refunds). Makes the call idempotent. */
  externalRef?: string | null;
}

async function previousRestocks(db: Db, orgId: string, txId: string): Promise<Map<string, number>> {
  const logs = await db.auditLog.findMany({ where: { organizationId: orgId, resourceType: 'Transaction', resourceId: txId, action: 'pos.refund' }, select: { metadata: true } });
  const m = new Map<string, number>();
  for (const l of logs) for (const r of ((l.metadata as any)?.restock ?? []) as { itemId: string; quantity: number }[]) m.set(r.itemId, (m.get(r.itemId) ?? 0) + r.quantity);
  return m;
}

export async function refundTransaction(actor: PosActor, id: string, input: RefundInput): Promise<{ refundId: string; status: TransactionStatus; refundedTotal: number; pointsReversed: number; duplicate?: boolean }> {
  const amount = Math.floor(Number(input.amount));
  const pre = await prisma.transaction.findFirst({ where: { id, organizationId: actor.orgId }, include: { payments: true } });
  if (!pre) throw new NotFoundError('会計が見つかりません');
  assertShopAccess(actor, pre.shopId);
  if (input.externalRef) {
    const dup = await prisma.refund.findUnique({ where: { externalRef: input.externalRef } });
    if (dup) return { refundId: dup.id, status: pre.status, refundedTotal: pre.refundedTotal, pointsReversed: 0, duplicate: true };
  }
  if (pre.status !== 'PAID' && pre.status !== 'PARTIALLY_REFUNDED') throw new AppError('この会計は返金できません');
  const err = validateRefund(pre.total, pre.refundedTotal, amount);
  if (err) throw new AppError(err);

  // Provider-side refund first (outside the DB tx). If the DB write then fails, the
  // provider's refund webhook reconciles it idempotently via Refund.externalRef.
  let externalRef = input.externalRef ?? null;
  if (!externalRef && (input.method === 'STRIPE' || input.method === 'SQUARE')) {
    const p = pre.payments.find((x) => x.method === input.method && x.status === 'SUCCEEDED' && x.externalRef);
    if (!p) throw new AppError('返金元となる決済が見つかりません。別の返金方法を選択してください');
    const key = `refund:${id}:${pre.refundedTotal}:${amount}`;
    const r = input.method === 'STRIPE'
      ? await createStripeRefund(actor.orgId, { paymentIntent: p.externalRef!, amount, metadata: { transaction_id: id }, shopId: pre.shopId, idempotencyKey: key })
      : await createSquareRefund(actor.orgId, { paymentId: p.externalRef!, amount, reason: input.reason ?? undefined, shopId: pre.shopId, idempotencyKey: key });
    externalRef = r.id;
  }

  const res = await prisma.$transaction(async (db) => {
    await lockTransaction(db, id);
    const t = await db.transaction.findFirst({ where: { id, organizationId: actor.orgId }, include: { items: true } });
    if (!t) throw new NotFoundError('会計が見つかりません');
    if (t.status !== 'PAID' && t.status !== 'PARTIALLY_REFUNDED') throw new AppError('この会計は返金できません');
    const e = validateRefund(t.total, t.refundedTotal, amount);
    if (e) throw new AppError(e);
    if (input.method === 'CASH') {
      await lockKeys(db, [`register:${t.shopId}`]);
      const open = await db.registerSession.findFirst({ where: { shopId: t.shopId, closedAt: null } });
      if (!open) throw new AppError('現金で返金するにはレジを開けてください', 'REGISTER_CLOSED');
    }
    // restock validation
    const restock = (input.restock ?? []).filter((r) => r.quantity > 0);
    if (restock.length) {
      const prev = await previousRestocks(db, actor.orgId, id);
      for (const r of restock) {
        const item = t.items.find((i) => i.id === r.itemId);
        if (!item || item.kind !== 'RETAIL' || !item.productId) throw new AppError('在庫を戻せない明細が指定されています');
        if (!Number.isInteger(r.quantity) || r.quantity + (prev.get(item.id) ?? 0) > item.quantity) throw new AppError(`「${item.name}」の返品数量が購入数を超えています`);
      }
    }
    const refund = await db.refund.create({
      data: { transactionId: id, amount, reason: input.reason ?? null, method: input.method, externalRef, createdById: actor.userId },
    });
    const refundedTotal = t.refundedTotal + amount;
    const status: TransactionStatus = refundedTotal >= t.total ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
    await db.transaction.update({ where: { id }, data: { refundedTotal, status } });

    let pointsReversed = 0;
    if (t.customerId) {
      await lockKeys(db, [`points:${t.customerId}`]);
      const ledger = await db.pointLedger.findMany({ where: { transactionId: id, customerId: t.customerId } });
      if (t.pointsEarned > 0 && t.total > 0) {
        const target = Math.floor((t.pointsEarned * refundedTotal) / t.total);
        const already = -ledger.filter((l) => l.reason === POINT_REASON.REFUND_EARN).reduce((a, l) => a + l.delta, 0);
        pointsReversed = Math.max(0, Math.min(target, t.pointsEarned) - already);
        if (pointsReversed > 0) await db.pointLedger.create({ data: { organizationId: actor.orgId, customerId: t.customerId, delta: -pointsReversed, reason: POINT_REASON.REFUND_EARN, transactionId: id } });
      }
      if (status === 'REFUNDED' && t.pointsUsed > 0 && !ledger.some((l) => l.reason === POINT_REASON.REFUND_USE)) {
        await db.pointLedger.create({ data: { organizationId: actor.orgId, customerId: t.customerId, delta: t.pointsUsed, reason: POINT_REASON.REFUND_USE, transactionId: id } });
      }
    }
    for (const r of restock) {
      const item = t.items.find((i) => i.id === r.itemId)!;
      await db.product.updateMany({ where: { id: item.productId!, organizationId: actor.orgId }, data: { stock: { increment: r.quantity } } });
    }
    await audit(auditActor(actor), 'pos.refund', 'Transaction', id, {
      number: t.number, amount, method: input.method, reason: input.reason ?? null, refundId: refund.id, externalRef, restock, pointsReversed, status,
    }, db);
    return { refundId: refund.id, status, refundedTotal, pointsReversed, customerId: t.customerId };
  }, TX_OPTS).catch(async (e: any) => {
    // concurrent webhook for the same provider refund already recorded it
    if (e?.code === 'P2002' && externalRef) {
      const dup = await prisma.refund.findUnique({ where: { externalRef } });
      if (dup) return { refundId: dup.id, status: pre.status, refundedTotal: pre.refundedTotal, pointsReversed: 0, customerId: null, duplicate: true };
    }
    throw e;
  });
  if (res.customerId) await recomputeCustomerStats(res.customerId);
  const { customerId: _c, ...out } = res;
  return out;
}

/** Local calendar date (shop timezone) of an instant. */
const localDate = (d: Date, tz: string) => toLocalParts(d, tz).date;

/**
 * Void: DRAFT at any time; PAID only on the same business day and before any refund
 * (afterwards use refunds). Reverses points and stock, and releases the appointment so
 * it can be re-rung.
 */
export async function voidTransaction(actor: PosActor, id: string, reason?: string | null, now = new Date()): Promise<{ status: 'VOID' }> {
  const pre = await prisma.transaction.findFirst({ where: { id, organizationId: actor.orgId }, include: { payments: true, shop: { select: { timezone: true } } } });
  if (!pre) throw new NotFoundError('会計が見つかりません');
  assertShopAccess(actor, pre.shopId);
  if (pre.status === 'VOID') throw new AppError('既に取消済みです');
  if (pre.status !== 'DRAFT' && pre.status !== 'PAID') throw new AppError('返金済みの会計は取消できません');
  if (pre.status === 'PAID' && (!pre.paidAt || localDate(pre.paidAt, pre.shop.timezone) !== localDate(now, pre.shop.timezone))) {
    throw new AppError('取消できるのは当日の会計のみです。返金をご利用ください');
  }
  if (pre.status === 'PAID') {
    for (const p of pre.payments) {
      if (p.status !== 'SUCCEEDED' || !p.externalRef || p.externalRef.startsWith('sandbox_')) continue;
      const key = `void:${id}:${p.id}`;
      if (p.method === 'STRIPE') await createStripeRefund(actor.orgId, { paymentIntent: p.externalRef, amount: p.amount, metadata: { transaction_id: id }, shopId: pre.shopId, idempotencyKey: key });
      if (p.method === 'SQUARE') await createSquareRefund(actor.orgId, { paymentId: p.externalRef, amount: p.amount, reason: '取消', shopId: pre.shopId, idempotencyKey: key });
    }
  }
  const customerId = await prisma.$transaction(async (db) => {
    await lockTransaction(db, id);
    const t = await db.transaction.findFirst({ where: { id, organizationId: actor.orgId }, include: { items: true } });
    if (!t) throw new NotFoundError('会計が見つかりません');
    if (t.status !== pre.status) throw new AppError('会計の状態が変更されました。画面を更新してください', 'STALE', 409);
    await db.transaction.update({
      where: { id },
      data: { status: 'VOID', voidedAt: now, appointmentId: null, note: [t.note, reason ? `取消理由: ${reason}` : null].filter(Boolean).join('\n') || null },
    });
    if (t.status === 'PAID') {
      await db.payment.updateMany({ where: { transactionId: id }, data: { status: 'REFUNDED' } });
      if (t.customerId) {
        await lockKeys(db, [`points:${t.customerId}`]);
        const ledger: Prisma.PointLedgerCreateManyInput[] = [];
        if (t.pointsEarned > 0) ledger.push({ organizationId: actor.orgId, customerId: t.customerId, delta: -t.pointsEarned, reason: POINT_REASON.VOID_EARN, transactionId: id });
        if (t.pointsUsed > 0) ledger.push({ organizationId: actor.orgId, customerId: t.customerId, delta: t.pointsUsed, reason: POINT_REASON.VOID_USE, transactionId: id });
        if (ledger.length) await db.pointLedger.createMany({ data: ledger });
      }
      for (const i of t.items) {
        if (i.kind === 'RETAIL' && i.productId) await db.product.updateMany({ where: { id: i.productId, organizationId: actor.orgId }, data: { stock: { increment: i.quantity } } });
      }
    }
    await audit(auditActor(actor), 'pos.void', 'Transaction', id, { number: t.number, previousStatus: t.status, total: t.total, appointmentId: t.appointmentId, reason: reason ?? null }, db);
    return t.status === 'PAID' ? t.customerId : null;
  }, TX_OPTS);
  if (customerId) await recomputeCustomerStats(customerId);
  return { status: 'VOID' };
}

// ───────────────────────── register ─────────────────────────

export async function openRegister(actor: PosActor, shopId: string, openingCash: number, note?: string | null) {
  assertShopAccess(actor, shopId);
  if (!Number.isInteger(openingCash) || openingCash < 0) throw new AppError('釣銭準備金を正しく入力してください');
  return prisma.$transaction(async (db) => {
    await lockKeys(db, [`register:${shopId}`]);
    const open = await db.registerSession.findFirst({ where: { shopId, closedAt: null } });
    if (open) throw new AppError('既にレジが開いています');
    const s = await db.registerSession.create({ data: { shopId, openedById: actor.userId ?? 'system', openingCash, note: note ?? null } });
    await audit(auditActor(actor), 'pos.register.open', 'RegisterSession', s.id, { shopId, openingCash }, db);
    return s;
  }, TX_OPTS);
}

export interface RegisterSummary {
  openingCash: number; cashSales: number; cashRefunds: number; expectedCash: number;
  byMethod: Record<string, number>; salesTotal: number; serviceTotal: number; retailTotal: number;
  txCount: number; customerCount: number; discountTotal: number; pointsUsed: number;
  refundTotal: number; refundCount: number; refundsByMethod: Record<string, number>;
  voidCount: number; from: string; to: string;
}

/** Live figures for a register session (tickets settled into it + refunds while it was open). */
export async function registerSummary(db: Db, sessionId: string, now = new Date()): Promise<RegisterSummary> {
  const s = await db.registerSession.findUnique({ where: { id: sessionId } });
  if (!s) throw new NotFoundError('レジセッションが見つかりません');
  const to = s.closedAt ?? now;
  const [txs, refunds, voidCount] = await Promise.all([
    db.transaction.findMany({ where: { registerSessionId: s.id, status: { in: PAID_STATUSES } }, include: { items: true, payments: true } }),
    db.refund.findMany({ where: { transaction: { shopId: s.shopId }, createdAt: { gte: s.openedAt, lte: to } } }),
    db.transaction.count({ where: { registerSessionId: s.id, status: 'VOID' } }),
  ]);
  const byMethod: Record<string, number> = {};
  let serviceTotal = 0, retailTotal = 0, salesTotal = 0, discountTotal = 0, pointsUsed = 0;
  const customers = new Set<string>();
  for (const t of txs) {
    for (const p of t.payments) if (p.status === 'SUCCEEDED') byMethod[p.method] = (byMethod[p.method] ?? 0) + p.amount;
    const split = splitServiceRetail(t.items, t.total);
    serviceTotal += split.serviceTotal; retailTotal += split.retailTotal; salesTotal += t.total;
    discountTotal += t.discountTotal; pointsUsed += t.pointsUsed;
    if (t.customerId) customers.add(t.customerId);
  }
  const refundsByMethod: Record<string, number> = {};
  for (const r of refunds) refundsByMethod[r.method] = (refundsByMethod[r.method] ?? 0) + r.amount;
  const cashSales = byMethod.CASH ?? 0;
  const cashRefunds = refundsByMethod.CASH ?? 0;
  return {
    openingCash: s.openingCash, cashSales, cashRefunds,
    expectedCash: expectedCash({ openingCash: s.openingCash, cashSales, cashRefunds }),
    byMethod, salesTotal, serviceTotal, retailTotal, txCount: txs.length, customerCount: customers.size,
    discountTotal, pointsUsed, refundTotal: refunds.reduce((a, r) => a + r.amount, 0), refundCount: refunds.length, refundsByMethod,
    voidCount, from: s.openedAt.toISOString(), to: to.toISOString(),
  };
}

export async function closeRegister(actor: PosActor, sessionId: string, actualCash: number, note?: string | null) {
  if (!Number.isInteger(actualCash) || actualCash < 0) throw new AppError('実際の現金額を正しく入力してください');
  const s0 = await prisma.registerSession.findUnique({ where: { id: sessionId }, include: { shop: { select: { organizationId: true } } } });
  if (!s0 || s0.shop.organizationId !== actor.orgId) throw new NotFoundError('レジセッションが見つかりません');
  assertShopAccess(actor, s0.shopId);
  return prisma.$transaction(async (db) => {
    await lockKeys(db, [`register:${s0.shopId}`]);
    const s = await db.registerSession.findUnique({ where: { id: sessionId } });
    if (!s || s.closedAt) throw new AppError('このレジは既に締められています');
    const now = new Date();
    const summary = await registerSummary(db, sessionId, now);
    const difference = actualCash - summary.expectedCash;
    const closed = await db.registerSession.update({
      where: { id: sessionId },
      data: { closedAt: now, closedById: actor.userId ?? 'system', expectedCash: summary.expectedCash, actualCash, difference, note: note ?? s.note, summary: summary as unknown as Prisma.InputJsonValue },
    });
    await audit(auditActor(actor), 'pos.register.close', 'RegisterSession', sessionId, { shopId: s.shopId, expectedCash: summary.expectedCash, actualCash, difference }, db);
    return closed;
  }, TX_OPTS);
}

export async function currentRegister(shopId: string) {
  return prisma.registerSession.findFirst({ where: { shopId, closedAt: null }, orderBy: { openedAt: 'desc' } });
}

// ───────────────────────── daily report ─────────────────────────

export async function dailyReport(actor: PosActor, shopId: string, date: string) {
  assertShopAccess(actor, shopId);
  const shop = await loadShop(prisma, actor.orgId, shopId);
  const from = localToUtc(date, 0, shop.timezone), to = localToUtc(addDays(date, 1), 0, shop.timezone);
  const [txs, refunds, voids, sessions, drafts] = await Promise.all([
    prisma.transaction.findMany({ where: { shopId, paidAt: { gte: from, lt: to }, status: { in: PAID_STATUSES } }, include: { items: true, payments: true }, orderBy: { paidAt: 'asc' } }),
    prisma.refund.findMany({ where: { transaction: { shopId }, createdAt: { gte: from, lt: to } }, include: { transaction: { select: { number: true } } } }),
    prisma.transaction.findMany({ where: { shopId, status: 'VOID', voidedAt: { gte: from, lt: to }, paidAt: { not: null } }, select: { id: true, number: true, total: true } }),
    prisma.registerSession.findMany({ where: { shopId, openedAt: { gte: from, lt: to } }, orderBy: { openedAt: 'asc' } }),
    prisma.transaction.count({ where: { shopId, status: 'DRAFT' } }),
  ]);
  const byMethod: Record<string, number> = {};
  const byStaff = new Map<string, { sales: number; service: number; retail: number; count: number; nominated: number }>();
  let serviceTotal = 0, retailTotal = 0, gross = 0, discountTotal = 0, pointsUsed = 0, pointsEarned = 0, taxTotal = 0;
  const customers = new Set<string>();
  for (const t of txs) {
    for (const p of t.payments) if (p.status === 'SUCCEEDED') byMethod[p.method] = (byMethod[p.method] ?? 0) + p.amount;
    const split = splitServiceRetail(t.items, t.total);
    serviceTotal += split.serviceTotal; retailTotal += split.retailTotal; gross += t.total;
    discountTotal += t.discountTotal; pointsUsed += t.pointsUsed; pointsEarned += t.pointsEarned; taxTotal += t.taxTotal;
    if (t.customerId) customers.add(t.customerId);
    const key = t.staffId ?? '—';
    const cur = byStaff.get(key) ?? { sales: 0, service: 0, retail: 0, count: 0, nominated: 0 };
    cur.sales += t.total; cur.service += split.serviceTotal; cur.retail += split.retailTotal; cur.count += 1;
    if (t.items.some((i) => i.nominated)) cur.nominated += 1;
    byStaff.set(key, cur);
  }
  const staffIds = [...byStaff.keys()].filter((k) => k !== '—');
  const members = staffIds.length ? await prisma.membership.findMany({ where: { organizationId: actor.orgId, userId: { in: staffIds } }, select: { userId: true, displayName: true } }) : [];
  const names = new Map(members.map((m) => [m.userId, m.displayName]));
  const refundTotal = refunds.reduce((a, r) => a + r.amount, 0);
  const refundsByMethod: Record<string, number> = {};
  for (const r of refunds) refundsByMethod[r.method] = (refundsByMethod[r.method] ?? 0) + r.amount;
  return {
    date, shop, gross, refundTotal, net: gross - refundTotal, txCount: txs.length, customerCount: customers.size,
    avgTicket: txs.length ? Math.round(gross / txs.length) : 0, serviceTotal, retailTotal, discountTotal, pointsUsed, pointsEarned, taxTotal,
    byMethod, refundsByMethod,
    byStaff: [...byStaff.entries()].map(([id, v]) => ({ staffId: id, name: names.get(id) ?? '未設定', ...v })).sort((a, b) => b.sales - a.sales),
    refunds: refunds.map((r) => ({ id: r.id, number: r.transaction.number, amount: r.amount, method: r.method, reason: r.reason, createdAt: r.createdAt })),
    voids, sessions, openDrafts: drafts,
  };
}

// ───────────────────────── read models ─────────────────────────

/** Full ticket for the checkout screen / receipt, scoped to the actor. */
export async function getTicket(actor: PosActor, id: string) {
  const t = await prisma.transaction.findFirst({
    where: { id, organizationId: actor.orgId },
    include: {
      items: { orderBy: { id: 'asc' } }, payments: { orderBy: { createdAt: 'asc' } }, refunds: { orderBy: { createdAt: 'asc' } },
      customer: { select: { id: true, lastName: true, firstName: true, lastNameKana: true, firstNameKana: true, visitCount: true } },
      appointment: { select: { id: true, startAt: true, endAt: true, status: true, staffId: true } },
      shop: { select: { id: true, name: true, address: true, phone: true, timezone: true, taxRatePct: true, pointRatePct: true } },
      registerSession: { select: { id: true, openedAt: true, closedAt: true } },
    },
  });
  if (!t) return null;
  assertShopAccess(actor, t.shopId);
  const coupon = t.couponId ? await prisma.coupon.findFirst({ where: { id: t.couponId, organizationId: actor.orgId } }) : null;
  const rule = couponRule(coupon);
  const breakdown = computeTicket({ lines: ticketLines(t.items), coupon: rule, taxRatePct: 0, pointRatePct: 0 });
  const manualDiscount = Math.max(0, t.discountTotal - breakdown.lineDiscounts - breakdown.couponDiscount);
  const couponDiscount = Math.max(0, t.discountTotal - breakdown.lineDiscounts - manualDiscount);
  return { ...t, coupon, lineDiscounts: breakdown.lineDiscounts, couponDiscount, manualDiscount };
}

/** Customer ids that may be attached are live (not merged/deleted) customers of the org. */
export async function searchPosCustomers(orgId: string, q: string, take = 12) {
  const s = q.normalize('NFKC').trim();
  if (!s) return [];
  const { phoneHash } = await import('./pii');
  const ph = /^[\d\-+() ]{6,}$/.test(s) ? phoneHash(s) : null;
  const parts = s.split(/\s+/);
  const nameOr: Prisma.CustomerWhereInput[] = parts.length > 1
    ? [{ AND: [{ lastName: { contains: parts[0] } }, { firstName: { contains: parts[1] } }] }, { AND: [{ lastNameKana: { contains: parts[0] } }, { firstNameKana: { contains: parts[1] } }] }]
    : [{ lastName: { contains: s } }, { firstName: { contains: s } }, { lastNameKana: { contains: s } }, { firstNameKana: { contains: s } }];
  const rows = await prisma.customer.findMany({
    where: { organizationId: orgId, mergedIntoId: null, deletedAt: null, OR: ph ? [{ phoneHash: ph }, ...nameOr] : nameOr },
    select: { id: true, lastName: true, firstName: true, lastNameKana: true, firstNameKana: true, visitCount: true, lastVisitAt: true },
    orderBy: [{ lastVisitAt: { sort: 'desc', nulls: 'last' } }], take,
  });
  const balances = rows.length ? await prisma.pointLedger.groupBy({ by: ['customerId'], where: { customerId: { in: rows.map((r) => r.id) } }, _sum: { delta: true } }) : [];
  const bal = new Map(balances.map((b) => [b.customerId, b._sum.delta ?? 0]));
  return rows.map((r) => ({ ...r, points: bal.get(r.id) ?? 0 }));
}

// ───────────────────────── provider-initiated payments ─────────────────────────

/**
 * Start a provider payment for a DRAFT: Stripe hosted payment link or Square Terminal
 * checkout. The ticket is finalized only when the provider webhook confirms payment.
 */
export async function startProviderPayment(actor: PosActor, id: string, provider: 'STRIPE' | 'SQUARE'): Promise<{ url: string | null; reference: string; sandbox: boolean }> {
  const t = await prisma.transaction.findFirst({ where: { id, organizationId: actor.orgId }, include: { shop: { select: { slug: true, name: true } } } });
  if (!t) throw new NotFoundError('会計が見つかりません');
  assertShopAccess(actor, t.shopId);
  if (t.status !== 'DRAFT') throw new AppError('この会計は既に確定済みです', 'ALREADY_PAID', 409);
  if (t.total <= 0) throw new AppError('請求額が0円のため、オンライン決済は不要です');
  if (provider === 'STRIPE') {
    const s = await createCheckoutSession(actor.orgId, {
      lines: [{ name: `${t.shop.name} お会計 No.${t.number}`, amount: t.total, quantity: 1 }],
      metadata: { transaction_id: t.id, org_id: actor.orgId }, shopId: t.shopId,
      successUrl: `${env.appUrl}/store/${t.shop.slug}/paid`, cancelUrl: `${env.appUrl}/store/${t.shop.slug}/paid?cancelled=1`,
      idempotencyKey: `pos-link:${t.id}:${t.total}`,
    });
    await audit(auditActor(actor), 'pos.payment_link', 'Transaction', t.id, { provider, amount: t.total, reference: s.id });
    return { url: s.url, reference: s.id, sandbox: s.sandbox };
  }
  const r = await createTerminalCheckout(actor.orgId, { amount: t.total, referenceId: squareRef('transaction', t.id), note: `No.${t.number}`, shopId: t.shopId, idempotencyKey: `pos-term:${t.id}:${t.total}` });
  await audit(auditActor(actor), 'pos.payment_link', 'Transaction', t.id, { provider, amount: t.total, reference: r.id });
  return { url: null, reference: r.id, sandbox: r.sandbox };
}

export async function providerModes(orgId: string, shopId: string) {
  const [s, q] = await Promise.all([stripeConfig(orgId, shopId), squareConfig(orgId, shopId)]);
  return { stripe: s.live ? 'live' : 'sandbox', square: q.live ? 'live' : 'sandbox' } as const;
}
