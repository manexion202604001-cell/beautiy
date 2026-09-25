'use server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireStaff } from '@/lib/server/session';
import { runAction, AppError, ForbiddenError, type ActionResult } from '@/lib/server/errors';
import { piiAccess, requestPiiUnlockOtp, verifyPiiUnlockOtp } from '@/lib/server/pii';
import { audit } from '@/lib/server/audit';
import { mergeCustomers } from '@/lib/server/customers';
import { env } from '@/lib/server/env';
import { sendCustomerMessage } from '@/lib/server/notify';
import {
  actorOf, addTag, adjustPoints, createCustomer, importCustomers, normalizeBirthday, removeTag, setFavorite,
  softDeleteCustomer, unlinkIdentity, updateCustomer, IMPORT_FIELDS, MAX_IMPORT_ROWS, type ImportReport, type ImportRow,
} from '@/lib/server/crm';
import { issueCounselingLink } from '@/lib/server/karte';

const opt = (max: number) => z.string().trim().max(max).optional().transform((v) => v || null);
const bool = z.preprocess((v) => v === 'on' || v === 'true' || v === '1', z.boolean());

const customerSchema = z.object({
  lastName: z.string().trim().min(1, '姓を入力してください').max(50),
  firstName: z.string().trim().max(50).default(''),
  lastNameKana: opt(50).refine((v) => !v || /^[\p{Script=Katakana}\p{Script=Hiragana}ー・\s　]+$/u.test(v), 'フリガナはカタカナで入力してください'),
  firstNameKana: opt(50).refine((v) => !v || /^[\p{Script=Katakana}\p{Script=Hiragana}ー・\s　]+$/u.test(v), 'フリガナはカタカナで入力してください'),
  phone: opt(30), email: opt(200), address: opt(300),
  birthday: opt(20).transform((v, ctx) => {
    if (!v) return null;
    const n = normalizeBirthday(v);
    if (!n) { ctx.addIssue({ code: 'custom', message: '誕生日の形式が正しくありません' }); return z.NEVER; }
    return n;
  }),
  gender: z.enum(['', '女性', '男性', 'その他', '回答しない']).optional().transform((v) => v || null),
  notes: opt(5000),
  assignedStaffId: opt(40), primaryShopId: opt(40),
  lineOptIn: bool, emailOptIn: bool, favorite: bool,
});

export async function saveCustomerAction(_: ActionResult<{ id: string }> | null, fd: FormData): Promise<ActionResult<{ id: string }>> {
  let createdId: string | null = null;
  const id = String(fd.get('id') ?? '') || null;
  const r = await runAction<{ id: string }>(async () => {
    const ctx = await requireStaff('customer.write');
    const input = customerSchema.parse(Object.fromEntries(fd));
    if (id) {
      // Blank = clear only when the editor was shown decrypted values AND still has PII access.
      const contactEditable = fd.get('contactEditable') === '1' && (await piiAccess(ctx)).canView;
      await updateCustomer(actorOf(ctx), id, input, { contactEditable });
      revalidatePath(`/customers/${id}`);
      return { ok: true, message: '顧客情報を保存しました', data: { id } };
    }
    const c = await createCustomer(actorOf(ctx), { ...input, primaryShopId: input.primaryShopId ?? ctx.shop.id }, { allowDuplicate: fd.get('allowDuplicate') === 'on' });
    createdId = c.id;
  });
  if (r.ok && createdId) redirect(`/customers/${createdId}?created=1`);
  if (r.ok && id) redirect(`/customers/${id}?saved=1`);
  return r;
}

export async function toggleFavoriteAction(fd: FormData) {
  return runAction(async () => {
    const ctx = await requireStaff('customer.write');
    const id = String(fd.get('id'));
    await setFavorite(actorOf(ctx), id, fd.get('favorite') === '1');
    revalidatePath(`/customers/${id}`);
  });
}

export async function deleteCustomerAction(fd: FormData) {
  const r = await runAction(async () => {
    const ctx = await requireStaff('customer.merge');
    await softDeleteCustomer(actorOf(ctx), String(fd.get('id')), String(fd.get('reason') ?? '').slice(0, 200) || '手動削除');
  });
  if (r.ok) redirect('/customers?deleted=1');
  return r;
}

export async function addTagAction(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await requireStaff('customer.write');
    const id = String(fd.get('customerId'));
    const tagId = String(fd.get('tagId') ?? '');
    await addTag(actorOf(ctx), id, tagId && tagId !== '__new' ? { tagId } : { name: String(fd.get('name') ?? ''), color: String(fd.get('color') ?? '') });
    revalidatePath(`/customers/${id}`);
  });
}

export async function removeTagAction(fd: FormData) {
  return runAction(async () => {
    const ctx = await requireStaff('customer.write');
    const id = String(fd.get('customerId'));
    await removeTag(actorOf(ctx), id, String(fd.get('tagId')));
    revalidatePath(`/customers/${id}`);
  });
}

export async function unlinkIdentityAction(fd: FormData) {
  return runAction(async () => {
    const ctx = await requireStaff('customer.write');
    const id = String(fd.get('customerId'));
    await unlinkIdentity(actorOf(ctx), id, String(fd.get('identityId')));
    revalidatePath(`/customers/${id}`);
  });
}

const pointsSchema = z.object({
  customerId: z.string().min(1),
  direction: z.enum(['add', 'sub']),
  amount: z.coerce.number({ invalid_type_error: 'ポイント数を入力してください' }).int('整数で入力してください').min(1, '1以上で入力してください').max(1_000_000),
  reason: z.string().trim().min(1, '理由を入力してください').max(100),
});

export async function adjustPointsAction(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await requireStaff('settings.shop');
    const d = pointsSchema.parse(Object.fromEntries(fd));
    const r = await adjustPoints(actorOf(ctx), d.customerId, d.direction === 'add' ? d.amount : -d.amount, d.reason);
    revalidatePath(`/customers/${d.customerId}`);
    return { ok: true, message: `ポイントを調整しました（残高 ${r.balance.toLocaleString('ja-JP')}pt）` };
  });
}

// ── PII temporary unlock (OTP) ──

export async function requestOtpAction(): Promise<ActionResult<{ devCode?: string }>> {
  return runAction(async () => {
    const ctx = await requireStaff('customer.read');
    const r = await requestPiiUnlockOtp(ctx);
    return { ok: true, message: '確認コードを送信しました', data: r };
  });
}

export async function verifyOtpAction(_: ActionResult<{ expiresAt: string }> | null, fd: FormData): Promise<ActionResult<{ expiresAt: string }>> {
  return runAction(async () => {
    const ctx = await requireStaff('customer.read');
    const d = z.object({
      code: z.string().trim().regex(/^\d{6}$/, '6桁の確認コードを入力してください'),
      reason: z.string().trim().min(2, '閲覧理由を入力してください').max(200),
    }).parse(Object.fromEntries(fd));
    const expiresAt = await verifyPiiUnlockOtp(ctx, d.code, d.reason);
    revalidatePath('/customers', 'layout');
    return { ok: true, message: '個人情報のロックを一時解除しました', data: { expiresAt: expiresAt.toISOString() } };
  });
}

// ── Merge ──

export async function mergeCustomersAction(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  let survivor = '';
  const r = await runAction(async () => {
    const ctx = await requireStaff('customer.merge');
    const f = z.object({
      survivorId: z.string().min(1, '残す顧客を選択してください'),
      pair: z.string().regex(/^[^|]+\|[^|]+$/),
      confirm: z.literal('on', { errorMap: () => ({ message: '統合内容の確認にチェックしてください' }) }),
    }).parse(Object.fromEntries(fd));
    const pair = f.pair.split('|');
    if (!pair.includes(f.survivorId)) throw new AppError('残す顧客の指定が不正です');
    const d = { survivorId: f.survivorId, mergedId: pair.find((x) => x !== f.survivorId) ?? '' };
    if (!d.mergedId) throw new AppError('同じ顧客は統合できません');
    const m = await mergeCustomers(ctx.org.id, d.survivorId, d.mergedId, ctx.user.id);
    await audit(ctx, 'customer.merge', 'Customer', d.survivorId, { mergedId: d.mergedId, mergeId: m.id });
    survivor = d.survivorId;
  });
  if (r.ok) redirect(`/customers/${survivor}?merged=1`);
  return r;
}

// ── Import ──

const importSchema = z.object({
  rows: z.array(z.record(z.enum(Object.keys(IMPORT_FIELDS) as [keyof typeof IMPORT_FIELDS, ...(keyof typeof IMPORT_FIELDS)[]]), z.string().max(5000))).min(1, '取り込む行がありません').max(MAX_IMPORT_ROWS, `一度に取り込めるのは${MAX_IMPORT_ROWS}行までです`),
  mode: z.enum(['skip', 'update']),
  dryRun: z.boolean(),
});

export async function importCustomersAction(input: { rows: ImportRow[]; mode: 'skip' | 'update'; dryRun: boolean }): Promise<ActionResult<ImportReport>> {
  return runAction(async () => {
    const ctx = await requireStaff('customer.import');
    const d = importSchema.parse(input);
    const report = await importCustomers({ ...actorOf(ctx), shopId: ctx.shop.id }, d.rows as ImportRow[], { mode: d.mode, dryRun: d.dryRun });
    if (!d.dryRun) revalidatePath('/customers');
    return { ok: true, data: report };
  });
}

// ── Counseling link ──

export async function issueCounselingAction(_: ActionResult<{ url: string; status?: string }> | null, fd: FormData): Promise<ActionResult<{ url: string; status?: string }>> {
  return runAction(async () => {
    const ctx = await requireStaff('karte.write');
    const d = z.object({ formId: z.string().min(1, 'フォームを選択してください'), customerId: z.string().min(1), appointmentId: z.string().optional(), send: bool }).parse(Object.fromEntries(fd));
    const r = await issueCounselingLink(actorOf(ctx), { formId: d.formId, customerId: d.customerId, appointmentId: d.appointmentId || null });
    const url = `${env.appUrl}/c/${r.token}`;
    let status: string | undefined;
    if (d.send) {
      if (!ctx.can('message.send')) throw new ForbiddenError('メッセージ送信の権限がありません');
      const msg = await sendCustomerMessage({
        orgId: ctx.org.id, shopId: ctx.shop.id, customerId: d.customerId, createdById: ctx.user.id, subject: `【${ctx.shop.name}】カウンセリングシートのご記入のお願い`,
        body: `${ctx.shop.name}です。ご来店前にカウンセリングシートのご記入をお願いいたします。\n${url}`,
      });
      status = msg.status;
    }
    revalidatePath(`/customers/${d.customerId}`);
    return {
      ok: true, data: { url, status },
      message: status === 'SKIPPED' ? 'リンクを発行しました（送信可能な連絡先がないため送信されませんでした）' : status === 'FAILED' ? 'リンクを発行しましたが送信に失敗しました' : status ? 'リンクを発行して送信しました' : 'リンクを発行しました',
    };
  });
}
