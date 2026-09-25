'use server';
import { z } from 'zod';
import { requireStaff } from '@/lib/server/session';
import { prisma } from '@/lib/server/db';
import { AppError, ForbiddenError, runAction, type ActionResult } from '@/lib/server/errors';
import {
  actorOf, checkout, closeRegister, openRegister, refundTransaction, saveDraft, searchPosCustomers, startProviderPayment, voidTransaction,
} from '@/lib/server/pos';
import { draftSchema, PAYMENT_METHODS, tenderSchema, type DraftInput, type TenderInput } from '@/lib/pos-shared';
import type { TicketTotals } from '@salonos/core';

const ticketRef = z.object({
  transactionId: z.string().min(1).nullish(),
  shopId: z.string().min(1),
  appointmentId: z.string().min(1).nullish(),
});

export interface SavePayload { transactionId?: string | null; shopId: string; appointmentId?: string | null; draft: DraftInput }

export async function saveDraftAction(payload: SavePayload): Promise<ActionResult<{ id: string; totals: TicketTotals }>> {
  return runAction(async () => {
    const ctx = await requireStaff('pos.checkout');
    const ref = ticketRef.parse(payload);
    const draft = draftSchema.parse(payload.draft);
    const r = await saveDraft(actorOf(ctx), { ...ref, draft });
    return { ok: true, message: '下書きを保存しました', data: r };
  });
}

export async function checkoutAction(payload: SavePayload & { tenders: TenderInput[]; expectedTotal: number }): Promise<ActionResult<{ id: string; change: number }>> {
  return runAction(async () => {
    const ctx = await requireStaff('pos.checkout');
    const ref = ticketRef.parse(payload);
    const draft = draftSchema.parse(payload.draft);
    const tenders = z.array(tenderSchema).max(10, '支払いは10件までです').parse(payload.tenders);
    const expectedTotal = z.number().int().min(0).parse(payload.expectedTotal);
    const actor = actorOf(ctx);
    const saved = await saveDraft(actor, { ...ref, draft });
    const r = await checkout(actor, saved.id, { tenders, expectedTotal });
    return { ok: true, message: '会計が完了しました', data: { id: r.id, change: r.change } };
  });
}

export async function searchCustomersAction(q: string) {
  const ctx = await requireStaff('pos.checkout');
  if (!ctx.can('customer.read')) return [];
  const rows = await searchPosCustomers(ctx.org.id, String(q ?? '').slice(0, 60));
  return rows.map((r) => ({
    id: r.id, name: `${r.lastName} ${r.firstName}`.trim(), kana: [r.lastNameKana, r.firstNameKana].filter(Boolean).join(' '),
    visitCount: r.visitCount, points: r.points, lastVisitAt: r.lastVisitAt?.toISOString() ?? null,
  }));
}

export async function startProviderPaymentAction(payload: SavePayload & { provider: 'STRIPE' | 'SQUARE' }): Promise<ActionResult<{ id: string; url: string | null; reference: string; sandbox: boolean }>> {
  return runAction(async () => {
    const ctx = await requireStaff('pos.checkout');
    const ref = ticketRef.parse(payload);
    const provider = z.enum(['STRIPE', 'SQUARE']).parse(payload.provider);
    const actor = actorOf(ctx);
    const saved = await saveDraft(actor, { ...ref, draft: draftSchema.parse(payload.draft) });
    const r = await startProviderPayment(actor, saved.id, provider);
    return { ok: true, message: provider === 'STRIPE' ? '決済リンクを発行しました' : '端末に金額を送信しました', data: { id: saved.id, ...r } };
  });
}

const refundSchema = z.object({
  transactionId: z.string().min(1),
  amount: z.coerce.number({ invalid_type_error: '返金額を入力してください' }).int('整数で入力してください').min(1, '返金額を入力してください'),
  method: z.enum(PAYMENT_METHODS),
  reason: z.string().trim().min(1, '返金理由を入力してください').max(300),
});

export async function refundAction(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await requireStaff('pos.refund');
    const input = refundSchema.parse(Object.fromEntries(fd));
    const restock: { itemId: string; quantity: number }[] = [];
    for (const [k, v] of fd.entries()) {
      if (!k.startsWith('restock_')) continue;
      const q = Number(v);
      if (!Number.isInteger(q) || q < 0) throw new AppError('返品数量が正しくありません');
      if (q > 0) restock.push({ itemId: k.slice(8), quantity: q });
    }
    const r = await refundTransaction(actorOf(ctx), input.transactionId, { amount: input.amount, method: input.method, reason: input.reason, restock });
    return { ok: true, message: `¥${input.amount.toLocaleString()} を返金しました${r.pointsReversed ? `（${r.pointsReversed}pt 取消）` : ''}` };
  });
}

export async function voidAction(fd: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await requireStaff('pos.checkout');
    const id = z.string().min(1).parse(fd.get('transactionId'));
    const t = await prisma.transaction.findFirst({ where: { id, organizationId: ctx.org.id }, select: { status: true } });
    if (!t) throw new AppError('会計が見つかりません');
    // Discarding a draft is part of normal checkout; voiding a paid ticket needs refund rights.
    if (t.status !== 'DRAFT' && !ctx.can('pos.refund')) throw new ForbiddenError();
    const reason = String(fd.get('reason') ?? '').trim().slice(0, 300) || null;
    await voidTransaction(actorOf(ctx), id, reason);
    return { ok: true, message: t.status === 'DRAFT' ? '下書きを破棄しました' : '会計を取り消しました' };
  });
}

export async function openRegisterAction(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await requireStaff('pos.register');
    const input = z.object({
      shopId: z.string().min(1),
      openingCash: z.coerce.number({ invalid_type_error: '金額を入力してください' }).int().min(0, '0以上で入力してください').max(10_000_000),
      note: z.string().trim().max(300).optional(),
    }).parse(Object.fromEntries(fd));
    await openRegister(actorOf(ctx), input.shopId, input.openingCash, input.note || null);
    return { ok: true, message: 'レジを開けました' };
  });
}

export async function closeRegisterAction(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await requireStaff('pos.register');
    const input = z.object({
      sessionId: z.string().min(1),
      actualCash: z.coerce.number({ invalid_type_error: '実際の現金額を入力してください' }).int().min(0, '0以上で入力してください').max(100_000_000),
      note: z.string().trim().max(500).optional(),
    }).parse(Object.fromEntries(fd));
    const s = await closeRegister(actorOf(ctx), input.sessionId, input.actualCash, input.note || null);
    const d = s.difference ?? 0;
    return { ok: true, message: `レジを締めました（差額 ${d > 0 ? '+' : ''}¥${d.toLocaleString()}）` };
  });
}

export async function voidFormAction(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return voidAction(fd);
}
