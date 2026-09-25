'use server';
import { z } from 'zod';
import { localToUtc, renderTemplate, type Segment } from '@salonos/core';
import { prisma } from '@/lib/server/db';
import { requireStaff } from '@/lib/server/session';
import { audit } from '@/lib/server/audit';
import { AppError, NotFoundError, runAction, type ActionResult } from '@/lib/server/errors';
import { resolveChannel, sendCustomerMessage } from '@/lib/server/notify';
import {
  assertSegmentScope, customerVars, executeBroadcast, normalizeSegment, retryMessage, segmentRecipients, startBroadcast,
} from '@/lib/server/messaging';
import { runAutomations } from '@/lib/server/automation';
import { TEMPLATE_CATEGORIES } from './labels';

const id = z.string().min(1).max(64);

async function ownCustomer(orgId: string, customerId: string) {
  const c = await prisma.customer.findFirst({ where: { id: customerId, organizationId: orgId, deletedAt: null } });
  if (!c) throw new NotFoundError('顧客が見つかりません');
  return c;
}

// ───────────────────────── Inbox ─────────────────────────

const sendSchema = z.object({
  customerId: id,
  body: z.string().trim().min(1, 'メッセージを入力してください').max(5000, '5000文字以内で入力してください'),
  channel: z.enum(['AUTO', 'LINE', 'EMAIL']).default('AUTO'),
  templateId: z.string().max(64).optional().or(z.literal('')),
});

export async function sendMessageAction(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await requireStaff('message.send');
    const input = sendSchema.parse(Object.fromEntries(fd));
    await ownCustomer(ctx.org.id, input.customerId);
    const preferred = input.channel === 'AUTO' ? undefined : input.channel;
    const r = await resolveChannel(ctx.org.id, input.customerId, preferred);
    if (!r?.channel) throw new AppError(preferred ? `このお客様は${preferred === 'LINE' ? 'LINE' : 'メール'}の配信を停止しているか、連絡先が未登録です` : '配信停止中、または送信可能な連絡先がありません');
    let templateId: string | undefined;
    if (input.templateId) {
      const t = await prisma.messageTemplate.findFirst({ where: { id: input.templateId, organizationId: ctx.org.id } });
      templateId = t?.id;
    }
    const m = await sendCustomerMessage({
      orgId: ctx.org.id, shopId: ctx.shop.id, customerId: input.customerId, body: input.body, channel: r.channel,
      templateId, createdById: ctx.user.id, subject: `【${ctx.shop.name}】メッセージ`,
    });
    if (m.status === 'FAILED') return { ok: false, error: `送信に失敗しました：${m.error ?? '不明なエラー'}（配信ログから再送できます）` };
    return { ok: true, message: m.error === 'sandbox' ? '送信しました（サンドボックス）' : '送信しました' };
  });
}

export async function retryMessageAction(fd: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await requireStaff('message.send');
    const m = await retryMessage(ctx.org.id, id.parse(fd.get('messageId')));
    if (m.status === 'FAILED') return { ok: false, error: `再送に失敗しました：${m.error ?? ''}` };
    if (m.status === 'SKIPPED') return { ok: false, error: '配信停止中または連絡先がないため送信しませんでした' };
    return { ok: true, message: '再送しました' };
  });
}

export async function retryAllFailedAction(_fd: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await requireStaff('message.broadcast');
    const failed = await prisma.message.findMany({
      where: { organizationId: ctx.org.id, direction: 'OUTBOUND', status: 'FAILED', createdAt: { gte: new Date(Date.now() - 7 * 86400000) } },
      select: { id: true }, orderBy: { createdAt: 'asc' }, take: 100,
    });
    let ok = 0, ng = 0;
    for (const f of failed) {
      try { const r = await retryMessage(ctx.org.id, f.id); if (r.status === 'SENT' || r.status === 'DELIVERED') ok++; else ng++; } catch { ng++; }
    }
    await audit(ctx, 'message.retry_all', 'Message', null, { ok, ng });
    return { ok: true, message: `再送 ${ok}件成功 / ${ng}件未送信` };
  });
}

export async function setConsentAction(fd: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await requireStaff('message.send');
    if (!ctx.can('customer.write')) throw new AppError('顧客情報の編集権限がありません');
    const input = z.object({ customerId: id, channel: z.enum(['LINE', 'EMAIL']), optIn: z.enum(['true', 'false']) }).parse(Object.fromEntries(fd));
    await ownCustomer(ctx.org.id, input.customerId);
    const optIn = input.optIn === 'true';
    await prisma.customer.update({ where: { id: input.customerId }, data: input.channel === 'LINE' ? { lineOptIn: optIn } : { emailOptIn: optIn } });
    await audit(ctx, 'customer.consent.update', 'Customer', input.customerId, { channel: input.channel, optIn });
    return { ok: true, message: optIn ? '配信を再開しました' : '配信を停止しました' };
  });
}

// ───────────────────────── Templates ─────────────────────────

const templateSchema = z.object({
  id: z.string().max(64).optional().or(z.literal('')),
  name: z.string().trim().min(1, 'テンプレート名を入力してください').max(60, '60文字以内で入力してください'),
  category: z.string().refine((c) => c in TEMPLATE_CATEGORIES, 'カテゴリを選択してください'),
  body: z.string().trim().min(1, '本文を入力してください').max(5000, '5000文字以内で入力してください'),
});

export async function saveTemplateAction(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await requireStaff('message.broadcast');
    const input = templateSchema.parse(Object.fromEntries(fd));
    if (input.id) {
      const r = await prisma.messageTemplate.updateMany({ where: { id: input.id, organizationId: ctx.org.id }, data: { name: input.name, category: input.category, body: input.body } });
      if (!r.count) throw new NotFoundError('テンプレートが見つかりません');
      return { ok: true, message: 'テンプレートを更新しました' };
    }
    await prisma.messageTemplate.create({ data: { organizationId: ctx.org.id, name: input.name, category: input.category, body: input.body } });
    return { ok: true, message: 'テンプレートを作成しました' };
  });
}

export async function deleteTemplateAction(fd: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await requireStaff('message.broadcast');
    const r = await prisma.messageTemplate.deleteMany({ where: { id: id.parse(fd.get('id')), organizationId: ctx.org.id } });
    if (!r.count) throw new NotFoundError('テンプレートが見つかりません');
    await audit(ctx, 'message.template.delete', 'MessageTemplate', String(fd.get('id')));
    return { ok: true, message: '削除しました' };
  });
}

// ───────────────────────── Broadcasts ─────────────────────────

function segmentFromForm(fd: FormData): Segment {
  return normalizeSegment({
    tagIds: fd.getAll('tagIds').map(String).filter(Boolean),
    lastVisitDaysMin: fd.get('lastVisitDaysMin'), lastVisitDaysMax: fd.get('lastVisitDaysMax'),
    minVisits: fd.get('minVisits'), staffId: fd.get('staffId'), favorite: fd.get('favorite'), shopId: fd.get('segShopId'),
  });
}

/** Live recipient count for the builder (evaluated server-side). */
export async function countRecipientsAction(raw: unknown, channel: string): Promise<{ ok: true; recipients: number; matched: number; optedOut: number; noContact: number } | { ok: false; error: string }> {
  try {
    const ctx = await requireStaff('message.broadcast');
    const ch = z.enum(['LINE', 'EMAIL']).parse(channel);
    const seg = normalizeSegment(raw);
    await assertSegmentScope(ctx.org.id, seg);
    const r = await segmentRecipients(ctx.org.id, seg, ch);
    return { ok: true, recipients: r.ids.length, matched: r.matched, optedOut: r.optedOut, noContact: r.noContact };
  } catch (e: any) {
    return { ok: false, error: e instanceof AppError ? e.message : '対象者数を計算できませんでした' };
  }
}

/** Render a body for one sample recipient (preview in the builder). */
export async function previewForCustomerAction(body: string, customerId: string): Promise<string> {
  const ctx = await requireStaff('message.send');
  await ownCustomer(ctx.org.id, customerId);
  return renderTemplate(body.slice(0, 5000), await customerVars(ctx.org.id, customerId, ctx.shop.id));
}

const broadcastSchema = z.object({
  id: z.string().max(64).optional().or(z.literal('')),
  name: z.string().trim().min(1, '配信名を入力してください').max(80, '80文字以内で入力してください'),
  body: z.string().trim().min(1, '本文を入力してください').max(5000, '5000文字以内で入力してください'),
  channel: z.enum(['LINE', 'EMAIL']),
  intent: z.enum(['draft', 'schedule', 'send']),
  scheduledAt: z.string().optional(),
});

export async function saveBroadcastAction(_: ActionResult<{ id: string }> | null, fd: FormData): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => {
    const ctx = await requireStaff('message.broadcast');
    const input = broadcastSchema.parse(Object.fromEntries(fd));
    const segment = segmentFromForm(fd);
    await assertSegmentScope(ctx.org.id, segment);
    let scheduledAt: Date | null = null;
    if (input.intent === 'schedule') {
      const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(input.scheduledAt ?? '');
      if (!m) return { ok: false, error: '配信日時を入力してください', fieldErrors: { scheduledAt: '配信日時を入力してください' } };
      scheduledAt = localToUtc(m[1], +m[2] * 60 + +m[3], ctx.shop.timezone);
      if (scheduledAt.getTime() < Date.now() + 60_000) return { ok: false, error: '配信日時は現在より後に設定してください' };
    }
    const data = {
      name: input.name, body: input.body, channel: input.channel, segment: segment as object,
      shopId: segment.shopId ?? ctx.shop.id,
      status: input.intent === 'schedule' ? 'SCHEDULED' : 'DRAFT', scheduledAt,
    };
    let bid: string;
    if (input.id) {
      const r = await prisma.broadcast.updateMany({ where: { id: input.id, organizationId: ctx.org.id, status: { in: ['DRAFT', 'SCHEDULED'] } }, data });
      if (!r.count) throw new AppError('送信済み・送信中の配信は編集できません');
      bid = input.id;
    } else {
      bid = (await prisma.broadcast.create({ data: { ...data, organizationId: ctx.org.id, createdById: ctx.user.id } })).id;
    }
    if (input.intent === 'send') {
      const preview = await segmentRecipients(ctx.org.id, segment, input.channel);
      if (!preview.ids.length) return { ok: false, error: '配信対象者が0人です。条件を見直してください。', data: { id: bid } };
      await audit(ctx, 'message.broadcast.send', 'Broadcast', bid, { recipients: preview.ids.length, channel: input.channel });
      const r = await startBroadcast(ctx.org.id, bid);
      if (!r) throw new AppError('この配信は既に送信処理中です');
      return { ok: true, message: `配信しました：送信 ${r.sent}件 / 失敗 ${r.failed}件 / 対象外 ${r.skipped}件`, data: { id: bid } };
    }
    if (input.intent === 'schedule') await audit(ctx, 'message.broadcast.schedule', 'Broadcast', bid, { scheduledAt: scheduledAt?.toISOString() });
    return { ok: true, message: input.intent === 'schedule' ? '配信を予約しました' : '下書きを保存しました', data: { id: bid } };
  });
}

export async function unscheduleBroadcastAction(fd: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await requireStaff('message.broadcast');
    const r = await prisma.broadcast.updateMany({ where: { id: id.parse(fd.get('id')), organizationId: ctx.org.id, status: 'SCHEDULED' }, data: { status: 'DRAFT', scheduledAt: null } });
    if (!r.count) throw new AppError('予約中の配信ではありません');
    return { ok: true, message: '配信予約を取り消しました' };
  });
}

export async function deleteBroadcastAction(fd: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await requireStaff('message.broadcast');
    const r = await prisma.broadcast.deleteMany({ where: { id: id.parse(fd.get('id')), organizationId: ctx.org.id, status: { in: ['DRAFT', 'SCHEDULED'] } } });
    if (!r.count) throw new AppError('送信済みの配信は削除できません');
    await audit(ctx, 'message.broadcast.delete', 'Broadcast', String(fd.get('id')));
    return { ok: true, message: '削除しました' };
  });
}

export async function duplicateBroadcastAction(fd: FormData): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => {
    const ctx = await requireStaff('message.broadcast');
    const b = await prisma.broadcast.findFirst({ where: { id: id.parse(fd.get('id')), organizationId: ctx.org.id } });
    if (!b) throw new NotFoundError('配信が見つかりません');
    const copy = await prisma.broadcast.create({ data: { organizationId: ctx.org.id, shopId: b.shopId, name: `${b.name}（コピー）`.slice(0, 80), body: b.body, channel: b.channel, segment: b.segment as object, status: 'DRAFT', createdById: ctx.user.id } });
    return { ok: true, message: '複製しました', data: { id: copy.id } };
  });
}

export async function resumeBroadcastAction(fd: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await requireStaff('message.broadcast');
    const r = await executeBroadcast(ctx.org.id, id.parse(fd.get('id')));
    await audit(ctx, 'message.broadcast.resume', 'Broadcast', String(fd.get('id')), { ...r });
    return { ok: true, message: `再開しました：送信 ${r.sent}件 / 失敗 ${r.failed}件` };
  });
}

// ───────────────────────── Automation ─────────────────────────

const ruleSchema = z.object({
  id: z.string().max(64).optional().or(z.literal('')),
  name: z.string().trim().min(1, 'ルール名を入力してください').max(60),
  trigger: z.enum(['REMINDER_BEFORE', 'VISIT_CYCLE', 'AFTER_VISIT_REVIEW', 'BIRTHDAY', 'DORMANT']),
  offsetValue: z.coerce.number().int('整数で入力してください').min(0, '0以上で入力してください').max(3650, '大きすぎます'),
  body: z.string().trim().min(1, '本文を入力してください').max(5000),
  channel: z.enum(['LINE', 'EMAIL']),
  shopId: z.string().max(64).optional().or(z.literal('')),
  active: z.string().optional(),
});

export async function saveRuleAction(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await requireStaff('message.automation');
    const input = ruleSchema.parse(Object.fromEntries(fd));
    if (input.shopId && !ctx.shops.some((s) => s.id === input.shopId)) throw new AppError('店舗の指定が正しくありません');
    if ((input.trigger === 'REMINDER_BEFORE' || input.trigger === 'AFTER_VISIT_REVIEW') && (input.offsetValue < 1 || input.offsetValue > 168)) {
      return { ok: false, error: '時間は1〜168の範囲で入力してください', fieldErrors: { offsetValue: '1〜168時間' } };
    }
    if ((input.trigger === 'VISIT_CYCLE' || input.trigger === 'DORMANT') && input.offsetValue < 1) {
      return { ok: false, error: '日数は1以上で入力してください', fieldErrors: { offsetValue: '1日以上' } };
    }
    const data = {
      name: input.name, trigger: input.trigger, offsetValue: input.trigger === 'BIRTHDAY' ? 0 : input.offsetValue, body: input.body,
      channel: input.channel, shopId: input.shopId || null, active: input.active === 'on' || input.active === 'true',
    };
    if (input.id) {
      const r = await prisma.automationRule.updateMany({ where: { id: input.id, organizationId: ctx.org.id }, data });
      if (!r.count) throw new NotFoundError('ルールが見つかりません');
      await audit(ctx, 'message.automation.update', 'AutomationRule', input.id, { trigger: data.trigger, active: data.active });
      return { ok: true, message: 'ルールを更新しました' };
    }
    const rule = await prisma.automationRule.create({ data: { ...data, organizationId: ctx.org.id } });
    await audit(ctx, 'message.automation.create', 'AutomationRule', rule.id, { trigger: data.trigger });
    return { ok: true, message: 'ルールを作成しました' };
  });
}

export async function toggleRuleAction(fd: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await requireStaff('message.automation');
    const ruleId = id.parse(fd.get('id'));
    const active = fd.get('active') === 'true';
    const r = await prisma.automationRule.updateMany({ where: { id: ruleId, organizationId: ctx.org.id }, data: { active } });
    if (!r.count) throw new NotFoundError('ルールが見つかりません');
    await audit(ctx, active ? 'message.automation.enable' : 'message.automation.disable', 'AutomationRule', ruleId);
    return { ok: true };
  });
}

export async function deleteRuleAction(fd: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await requireStaff('message.automation');
    const ruleId = id.parse(fd.get('id'));
    const r = await prisma.automationRule.deleteMany({ where: { id: ruleId, organizationId: ctx.org.id } });
    if (!r.count) throw new NotFoundError('ルールが見つかりません');
    await audit(ctx, 'message.automation.delete', 'AutomationRule', ruleId);
    return { ok: true, message: '削除しました' };
  });
}

export async function runAutomationsNowAction(fd: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await requireStaff('message.automation');
    const ruleId = fd.get('ruleId') ? id.parse(fd.get('ruleId')) : undefined;
    if (ruleId && !(await prisma.automationRule.findFirst({ where: { id: ruleId, organizationId: ctx.org.id } }))) throw new NotFoundError('ルールが見つかりません');
    const s = await runAutomations(new Date(), ctx.org.id, { ruleId });
    await audit(ctx, 'message.automation.run', 'AutomationRule', ruleId ?? null, { dispatched: s.dispatched, sent: s.sent, failed: s.failed });
    const errs = s.rules.filter((r) => r.error);
    if (errs.length) return { ok: false, error: `一部のルールでエラー：${errs.map((e) => `${e.name}（${e.error}）`).join('、')}` };
    return { ok: true, message: `実行しました：${s.rules.length}ルール / 新規送信 ${s.sent}件・対象外 ${s.skipped}件・失敗 ${s.failed}件` };
  });
}

export async function searchCustomersAction(q: string): Promise<{ id: string; name: string; kana: string; line: boolean }[]> {
  const ctx = await requireStaff('message.send');
  const s = String(q ?? '').normalize('NFKC').trim().slice(0, 40);
  if (!s) return [];
  const parts = s.split(/\s+/);
  const rows = await prisma.customer.findMany({
    where: {
      organizationId: ctx.org.id, deletedAt: null, mergedIntoId: null,
      AND: parts.map((p) => ({ OR: [{ lastName: { contains: p } }, { firstName: { contains: p } }, { lastNameKana: { contains: p } }, { firstNameKana: { contains: p } }] })),
    },
    include: { identities: { where: { provider: 'LINE' }, select: { id: true }, take: 1 } },
    orderBy: [{ lastVisitAt: { sort: 'desc', nulls: 'last' } }], take: 10,
  });
  return rows.map((c) => ({ id: c.id, name: `${c.lastName} ${c.firstName}`.trim(), kana: `${c.lastNameKana ?? ''} ${c.firstNameKana ?? ''}`.trim(), line: c.identities.length > 0 }));
}
