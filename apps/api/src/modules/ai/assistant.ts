import { sql, type ExpressionBuilder } from 'kysely';
import { assertShopAccess, auditUserId, requirePermission, type Ctx } from '../../auth/actor.js';
import type { DB } from '../../db/types.js';
import { audit } from '../../lib/audit.js';
import { Errors } from '../../lib/errors.js';
import { decodeCursor, encodeCursor } from '../../lib/pagination.js';
import { DEFAULT_TZ, localDate } from '../../lib/time.js';
import { assertCustomerAccess, canSeeAllCustomers, visibleCustomerFilter } from '../customers/access.js';
import { displayName } from '../customers/service.js';
import { generate } from './providers/index.js';
import type { AiResult, AiTask, KarteSummaryInput, MessageDraftInput, ReviewReplyInput } from './providers/types.js';
import type { ListSuggestionsQuery, MessageDraftBody, NextActionsQuery } from './schemas.js';

/**
 * Generative assistant (要件 14). Every output is stored as an ai_suggestions row with status
 * 'proposed' and must be accepted by a human; accepting only returns the text to the UI —
 * this module NEVER queues or sends messages (要件 19.1: AIによる自動外部送信はMVP外).
 */
const DAY_MS = 86_400_000;
const VISIT_STATUSES = ['completed', 'partially_refunded'] as const;

// ---------------------------------------------------------------- PII minimization

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /(?<![\d+])(?:\+81[-\s]?|0)\d{1,4}[-\s(]?\d{1,4}[-\s)]?\d{3,4}(?!\d)/g;
const POSTAL_RE = /(?:〒\s?)?(?<![\d-])\d{3}-\d{4}(?![\d-])/g;

/** Remove e-mail addresses, phone numbers and postal codes from free text before it leaves the system */
export function scrubPii(text: string | null | undefined): string | null {
  if (!text) return null;
  return text.replace(EMAIL_RE, '[メール]').replace(PHONE_RE, '[電話番号]').replace(POSTAL_RE, '[郵便番号]');
}

function firstNameOf(c: { first_name: string }): string {
  return c.first_name.trim() || 'お客様';
}

async function shopName(ctx: Ctx, preferred: (string | null | undefined)[]): Promise<string> {
  const candidates = [...preferred, ...(ctx.actor.kind === 'staff' ? ctx.actor.shopIds : [])].filter((x): x is string => !!x);
  if (!candidates.length) return '';
  const rows = await ctx.trx.selectFrom('shops').select(['id', 'name']).where('id', 'in', candidates).execute();
  for (const id of candidates) {
    const row = rows.find((r) => r.id === id);
    if (row) return row.name;
  }
  return '';
}

async function orgTz(ctx: Ctx): Promise<string> {
  const org = await ctx.trx.selectFrom('organizations').select('timezone').where('id', '=', ctx.actor.organizationId).executeTakeFirst();
  return org?.timezone ?? DEFAULT_TZ;
}

async function recentVisits(ctx: Ctx, customerId: string, limit: number, tz: string) {
  const rows = await ctx.trx
    .selectFrom('transactions as t')
    .leftJoin('transaction_items as ti', (j) => j.onRef('ti.transaction_id', '=', 't.id').on('ti.item_type', '=', 'service'))
    .select(['t.id', 't.completed_at', 'ti.name'])
    .where('t.customer_id', '=', customerId)
    .where('t.status', 'in', [...VISIT_STATUSES])
    .where('t.completed_at', 'is not', null)
    .orderBy('t.completed_at', 'desc')
    .orderBy('ti.sort_order')
    .limit(limit * 5)
    .execute();
  const visits: { id: string; date: string; menus: string[] }[] = [];
  for (const r of rows) {
    let v = visits.find((x) => x.id === r.id);
    if (!v) {
      if (visits.length >= limit) break;
      v = { id: r.id, date: localDate(r.completed_at!, tz), menus: [] };
      visits.push(v);
    }
    if (r.name && !v.menus.includes(r.name)) v.menus.push(r.name);
  }
  return visits.map(({ id: _id, ...v }) => v);
}

// ---------------------------------------------------------------- suggestions

type SuggestionRow = {
  id: string;
  kind: string;
  subject_type: string;
  subject_id: string | null;
  status: string;
  provider: string;
  model: string | null;
  input: unknown;
  output: unknown;
  decided_by: string | null;
  decided_at: Date | null;
  created_by: string | null;
  created_at: Date;
};

export function presentSuggestion(r: SuggestionRow) {
  const output = (r.output ?? {}) as { text?: string; editedText?: string };
  return {
    id: r.id,
    kind: r.kind,
    subjectType: r.subject_type,
    subjectId: r.subject_id,
    status: r.status,
    provider: r.provider,
    model: r.model,
    text: output.editedText ?? output.text ?? null,
    output: r.output,
    input: r.input,
    decidedBy: r.decided_by,
    decidedAt: r.decided_at,
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}

async function storeSuggestion(
  ctx: Ctx,
  kind: 'message_draft' | 'review_reply' | 'karte_summary',
  subject: { type: 'customer' | 'review'; id: string },
  task: AiTask,
  result: AiResult,
  extraOutput: Record<string, unknown> = {},
) {
  const row = await ctx.trx
    .insertInto('ai_suggestions')
    .values({
      organization_id: ctx.actor.organizationId,
      kind,
      subject_type: subject.type,
      subject_id: subject.id,
      input: JSON.stringify(task.input),
      output: JSON.stringify({ text: result.text, ...extraOutput, ...(result.fallbackReason ? { fallbackReason: result.fallbackReason } : {}) }),
      provider: result.provider,
      model: result.model,
      status: 'proposed',
      created_by: auditUserId(ctx.actor),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await audit(ctx, {
    action: 'ai.suggestion.create',
    resourceType: 'ai_suggestion',
    resourceId: row.id,
    metadata: { kind, subjectType: subject.type, subjectId: subject.id, provider: result.provider, model: result.model, fallback: !!result.fallbackReason },
  });
  return presentSuggestion(row);
}

/** POST /ai/message-draft — LINE/メール用メッセージ下書き (送信はしない) */
export async function messageDraft(ctx: Ctx, input: MessageDraftBody) {
  requirePermission(ctx.actor, 'ai.use');
  await assertCustomerAccess(ctx, input.customerId);
  const c = await ctx.trx
    .selectFrom('customers')
    .select(['id', 'first_name', 'visit_count', 'last_visit_at', 'primary_shop_id'])
    .where('id', '=', input.customerId)
    .executeTakeFirstOrThrow();
  const tz = await orgTz(ctx);
  const visits = await recentVisits(ctx, c.id, 3, tz);
  const draft: MessageDraftInput = {
    purpose: input.purpose,
    tone: input.tone ?? 'polite',
    customer: {
      firstName: firstNameOf(c),
      visitCount: c.visit_count,
      daysSinceLastVisit: c.last_visit_at ? Math.floor((Date.now() - c.last_visit_at.getTime()) / DAY_MS) : null,
      lastVisitDate: c.last_visit_at ? localDate(c.last_visit_at, tz) : null,
      recentMenus: [...new Set(visits.flatMap((v) => v.menus))].slice(0, 3),
    },
    shopName: await shopName(ctx, [ctx.meta.currentShopId, c.primary_shop_id]),
    staffName: ctx.actor.kind === 'staff' ? ctx.actor.displayName : '',
  };
  const task: AiTask = { kind: 'message_draft', input: draft };
  const result = await generate(task);
  return storeSuggestion(ctx, 'message_draft', { type: 'customer', id: c.id }, task, result, { purpose: draft.purpose, tone: draft.tone });
}

/** POST /ai/review-reply-draft — 口コミ返信の下書き (投稿はreviewsモジュールで人が行う) */
export async function reviewReplyDraft(ctx: Ctx, reviewId: string) {
  requirePermission(ctx.actor, 'ai.use', 'review.manage');
  const review = await ctx.trx
    .selectFrom('reviews')
    .leftJoin('staffs', 'staffs.id', 'reviews.staff_id')
    .select(['reviews.id', 'reviews.shop_id', 'reviews.rating', 'reviews.title', 'reviews.body', 'staffs.display_name as staff_name'])
    .where('reviews.id', '=', reviewId)
    .executeTakeFirst();
  if (!review) throw Errors.notFound('口コミ', reviewId);
  assertShopAccess(ctx.actor, review.shop_id);
  const input: ReviewReplyInput = {
    rating: review.rating,
    title: scrubPii(review.title),
    body: scrubPii(review.body),
    shopName: await shopName(ctx, [review.shop_id]),
    staffName: review.staff_name ?? null,
  };
  const task: AiTask = { kind: 'review_reply', input };
  const result = await generate(task);
  return storeSuggestion(ctx, 'review_reply', { type: 'review', id: review.id }, task, result, { rating: review.rating });
}

/** POST /ai/karte-summary — スタッフ向けカルテ・来店履歴の要約 */
export async function karteSummary(ctx: Ctx, customerId: string) {
  requirePermission(ctx.actor, 'ai.use', 'karte.read');
  await assertCustomerAccess(ctx, customerId);
  const c = await ctx.trx
    .selectFrom('customers')
    .select(['id', 'first_name', 'visit_count', 'last_visit_at', 'avg_cycle_days'])
    .where('id', '=', customerId)
    .executeTakeFirstOrThrow();
  const tz = await orgTz(ctx);
  const kartes = await ctx.trx
    .selectFrom('kartes')
    .leftJoin('staffs', 'staffs.id', 'kartes.staff_id')
    .select(['kartes.visit_date', 'kartes.note', 'kartes.chemicals', 'kartes.homecare', 'staffs.display_name as staff_name'])
    .where('kartes.customer_id', '=', customerId)
    .where('kartes.deleted_at', 'is', null)
    .orderBy('kartes.visit_date', 'desc')
    .orderBy('kartes.created_at', 'desc')
    .limit(5)
    .execute();
  const input: KarteSummaryInput = {
    customer: {
      firstName: firstNameOf(c),
      visitCount: c.visit_count,
      lastVisitDate: c.last_visit_at ? localDate(c.last_visit_at, tz) : null,
      avgCycleDays: c.avg_cycle_days,
    },
    kartes: kartes.map((k) => ({
      visitDate: k.visit_date,
      staffName: k.staff_name ?? null,
      note: scrubPii(k.note),
      chemicals: (Array.isArray(k.chemicals) ? (k.chemicals as { name?: string; brand?: string; ratio?: string }[]) : [])
        .map((ch) => scrubPii([ch.brand, ch.name, ch.ratio].filter(Boolean).join(' ')) ?? '')
        .filter(Boolean),
      homecare: scrubPii(((k.homecare ?? {}) as { advice?: string }).advice ?? null),
    })),
    recentVisits: await recentVisits(ctx, c.id, 5, tz),
  };
  const task: AiTask = { kind: 'karte_summary', input };
  const result = await generate(task);
  return storeSuggestion(ctx, 'karte_summary', { type: 'customer', id: c.id }, task, result);
}

async function assertSubjectAccess(ctx: Ctx, subjectType: string, subjectId: string | null) {
  if (!subjectId) return;
  if (subjectType === 'customer') {
    await assertCustomerAccess(ctx, subjectId, { allowMerged: true });
  } else if (subjectType === 'review') {
    const review = await ctx.trx.selectFrom('reviews').select('shop_id').where('id', '=', subjectId).executeTakeFirst();
    if (!review) throw Errors.notFound('口コミ', subjectId);
    assertShopAccess(ctx.actor, review.shop_id);
  }
}

async function loadSuggestion(ctx: Ctx, id: string) {
  const row = await ctx.trx.selectFrom('ai_suggestions').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
  if (!row) throw Errors.notFound('AI提案', id);
  try {
    await assertSubjectAccess(ctx, row.subject_type, row.subject_id);
  } catch (err) {
    // do not leak the existence of suggestions about subjects the caller cannot see
    if ((err as { status?: number }).status === 403 || (err as { status?: number }).status === 404) throw Errors.notFound('AI提案', id);
    throw err;
  }
  return row;
}

/**
 * POST /ai/suggestions/:id/accept|reject — human decision. Accepting returns the (optionally edited)
 * text for the staff member to paste/send through the normal messaging/review screens.
 */
export async function decideSuggestion(ctx: Ctx, id: string, decision: 'accepted' | 'rejected', opts: { editedText?: string; reason?: string } = {}) {
  requirePermission(ctx.actor, 'ai.use');
  const row = await loadSuggestion(ctx, id);
  if (row.status !== 'proposed') {
    throw Errors.conflict('SUGGESTION_ALREADY_DECIDED', 'このAI提案は既に承認または却下されています', { status: row.status });
  }
  const output = { ...((row.output ?? {}) as Record<string, unknown>) };
  if (decision === 'accepted' && opts.editedText) output.editedText = opts.editedText;
  if (decision === 'rejected' && opts.reason) output.rejectReason = opts.reason;
  const updated = await ctx.trx
    .updateTable('ai_suggestions')
    .set({ status: decision, decided_by: auditUserId(ctx.actor), decided_at: new Date(), output: JSON.stringify(output) })
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirstOrThrow();
  await audit(ctx, {
    action: decision === 'accepted' ? 'ai.suggestion.accept' : 'ai.suggestion.reject',
    resourceType: 'ai_suggestion',
    resourceId: id,
    before: { status: row.status },
    after: { status: decision, edited: !!opts.editedText },
  });
  const suggestion = presentSuggestion(updated);
  return {
    suggestion,
    text: decision === 'accepted' ? suggestion.text : null,
    /** never 'sent': delivery is always performed by a person through the regular screens */
    delivery: 'manual' as const,
    note: decision === 'accepted' ? '本文をコピーして、メッセージ/口コミ返信画面から担当者が確認のうえ送信してください。AIから自動送信されることはありません。' : null,
  };
}

/** GET /ai/suggestions — by subject; without a subject only the caller's own (unless they see all customers) */
export async function listSuggestions(ctx: Ctx, input: ListSuggestionsQuery) {
  requirePermission(ctx.actor, 'ai.use');
  let q = ctx.trx.selectFrom('ai_suggestions').selectAll();
  if (input.subjectId) {
    if (!input.subjectType) throw Errors.validation('subjectIdを指定する場合はsubjectTypeも指定してください');
    await assertSubjectAccess(ctx, input.subjectType, input.subjectId);
    q = q.where('subject_type', '=', input.subjectType).where('subject_id', '=', input.subjectId);
  } else {
    if (input.subjectType) q = q.where('subject_type', '=', input.subjectType);
    if (!canSeeAllCustomers(ctx)) q = q.where('created_by', '=', auditUserId(ctx.actor) ?? '00000000-0000-0000-0000-000000000000');
  }
  if (input.kind) q = q.where('kind', '=', input.kind);
  if (input.status) q = q.where('status', '=', input.status);
  const cursor = decodeCursor(input.cursor);
  if (cursor) q = q.where(sql`(created_at, id)`, '<', sql`(${cursor.v}::timestamptz, ${cursor.id}::uuid)`);
  const rows = await q.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(input.limit + 1).execute();
  const hasMore = rows.length > input.limit;
  const items = (hasMore ? rows.slice(0, input.limit) : rows).map(presentSuggestion);
  const last = items[items.length - 1];
  return { items, nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null };
}

// ---------------------------------------------------------------- next best actions

export const SECOND_VISIT_WINDOW = { minDays: 21, maxDays: 60 } as const;

/**
 * GET /ai/next-actions — 本日の推奨CRMアクション (read-only):
 *  1. churn_risk:   score level high and no future appointment → 休眠フォロー
 *  2. birthday:     birthday in the current month (marketing opt-in) → 誕生日メッセージ
 *  3. second_visit: exactly 1 visit, first visit 21–60 days ago, no future appointment → 2回目来店フォロー
 */
export async function nextActions(ctx: Ctx, input: NextActionsQuery) {
  requirePermission(ctx.actor, 'ai.use', 'customer.read');
  if (input.shopId) assertShopAccess(ctx.actor, input.shopId);
  const tz = await orgTz(ctx);
  const now = new Date();
  const today = localDate(now, tz);
  const month = Number(today.slice(5, 7));
  const visible = visibleCustomerFilter(ctx);
  const shopId = input.shopId;

  const noFuture = (eb: ExpressionBuilder<DB, 'customers'>) =>
    eb.not(
      eb.exists(
        eb
          .selectFrom('appointments as a')
          .select(sql`1`.as('x'))
          .whereRef('a.customer_id', '=', 'customers.id')
          .where('a.start_at', '>', now)
          .where('a.status', 'in', ['tentative', 'confirmed'])
          .where('a.deleted_at', 'is', null),
      ),
    );
  const inShop = (eb: ExpressionBuilder<DB, 'customers'>) =>
    eb.or([
      eb('customers.primary_shop_id', '=', shopId!),
      eb.exists(eb.selectFrom('customer_shop_relations as r').select(sql`1`.as('x')).whereRef('r.customer_id', '=', 'customers.id').where('r.shop_id', '=', shopId!)),
    ]);
  const base = () => {
    let q = ctx.trx
      .selectFrom('customers')
      .select(['customers.id', 'customers.last_name', 'customers.first_name', 'customers.last_name_kana', 'customers.first_name_kana', 'customers.last_visit_at', 'customers.first_visit_at', 'customers.birthday'])
      .where('customers.deleted_at', 'is', null)
      .where('customers.status', '=', 'active');
    if (visible) q = q.where(visible);
    if (shopId) q = q.where(inShop);
    return q;
  };

  const risky = await base()
    .innerJoin('customer_scores as s', 's.customer_id', 'customers.id')
    .select(['s.churn_risk', 's.recommended_action'])
    .where('s.churn_risk_level', '=', 'high')
    .where(noFuture)
    .orderBy('s.churn_risk', 'desc')
    .orderBy('customers.id')
    .limit(input.limit)
    .execute();
  const birthdays = await base()
    .where('customers.marketing_opt_in', '=', true)
    .where(sql`extract(month from customers.birthday)`, '=', month)
    .orderBy(sql`extract(day from customers.birthday)`)
    .orderBy('customers.id')
    .limit(input.limit)
    .execute();
  const secondVisit = await base()
    .where('customers.visit_count', '=', 1)
    .where('customers.first_visit_at', '<=', new Date(now.getTime() - SECOND_VISIT_WINDOW.minDays * DAY_MS))
    .where('customers.first_visit_at', '>=', new Date(now.getTime() - SECOND_VISIT_WINDOW.maxDays * DAY_MS))
    .where(noFuture)
    .orderBy('customers.first_visit_at')
    .orderBy('customers.id')
    .limit(input.limit)
    .execute();

  const all = [
    ...risky.map((c) => ({
      type: 'churn_risk' as const,
      priority: 1,
      customerId: c.id,
      customerName: displayName(c),
      reason: c.recommended_action ?? '失客リスク高・次回予約なし',
      suggestedPurpose: 'dormant' as const,
      score: c.churn_risk,
      lastVisitAt: c.last_visit_at,
    })),
    ...secondVisit.map((c) => ({
      type: 'second_visit' as const,
      priority: 2,
      customerId: c.id,
      customerName: displayName(c),
      reason: `初回来店から${Math.floor((now.getTime() - c.first_visit_at!.getTime()) / DAY_MS)}日・次回予約なし: 2回目来店のフォロー推奨`,
      suggestedPurpose: 'followup' as const,
      score: null,
      lastVisitAt: c.last_visit_at,
    })),
    ...birthdays.map((c) => ({
      type: 'birthday' as const,
      priority: 3,
      customerId: c.id,
      customerName: displayName(c),
      reason: `今月お誕生日(${Number(c.birthday!.slice(5, 7))}月${Number(c.birthday!.slice(8, 10))}日): お祝いメッセージ推奨`,
      suggestedPurpose: 'birthday' as const,
      score: null,
      lastVisitAt: c.last_visit_at,
    })),
  ];
  // one action per customer: keep the highest-priority reason, list the others as secondary
  const byCustomer = new Map<string, (typeof all)[number] & { otherReasons: string[] }>();
  for (const a of all) {
    const existing = byCustomer.get(a.customerId);
    if (existing) existing.otherReasons.push(a.type);
    else byCustomer.set(a.customerId, { ...a, otherReasons: [] });
  }
  const items = [...byCustomer.values()];
  return {
    date: today,
    shopId: shopId ?? null,
    counts: { churnRisk: risky.length, secondVisit: secondVisit.length, birthday: birthdays.length },
    items,
    note: '提案のみです。メッセージ送信は担当者が内容を確認したうえで行ってください。',
  };
}
