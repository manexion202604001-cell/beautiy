import { sql, type Expression, type ExpressionBuilder, type SqlBool } from 'kysely';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { auditUserId, requirePermission, type Ctx } from '../../auth/actor.js';
import type { DB } from '../../db/types.js';
import { audit, diff } from '../../lib/audit.js';
import { Errors } from '../../lib/errors.js';
import { decodeCursor, paginate } from '../../lib/pagination.js';
import { uuid } from '../../lib/schemas.js';
import { visibleCustomerFilter } from '../customers/access.js';
import { displayName } from '../customers/service.js';
import { clock } from './clock.js';
import { orgTimezone } from './templates.js';

/**
 * Segment rule DSL (要件 13.1). JSON rules are validated with zod and compiled into Kysely
 * expressions — every user-supplied value is bound as a parameter (no SQL string interpolation).
 *
 *   { "all": [ { "type": "last_visit_days_gt", "days": 45 }, { "type": "no_future_appointment" } ] }
 *   { "any": [ { "type": "birthday_month" }, { "type": "tag", "tagIds": ["…"] } ] }
 *   { "not": { "type": "marketing_opt_in" } }
 */
const days = z.number().int().min(0).max(36500);
const ids = z.array(uuid).min(1).max(200);

export const segmentConditionSchema = z.discriminatedUnion('type', [
  /** 最終来店からN日超 (来店履歴なしは含まない) */
  z.object({ type: z.literal('last_visit_days_gt'), days }).strict(),
  /** 最終来店からN日以内 */
  z.object({ type: z.literal('last_visit_days_lte'), days }).strict(),
  /** 次回予約なし */
  z.object({ type: z.literal('no_future_appointment') }).strict(),
  /** 次回予約あり */
  z.object({ type: z.literal('has_future_appointment') }).strict(),
  /**
   * 初回来店のみで再来店なし。windowElapsed=true(既定): 初回来店からN日以上経過して未再来 (13.1 例)、
   * false: 初回来店からN日以内でまだ再来店なし (フォロー対象)
   */
  z.object({ type: z.literal('first_visit_within_days_without_return'), days, windowElapsed: z.boolean().optional() }).strict(),
  /** 累計売上(LTV)上位N% (percent_rank) */
  z.object({ type: z.literal('ltv_top_percent'), percent: z.number().min(0.1).max(100) }).strict(),
  /** 特定メニュー利用者 (完了予約 or 会計明細) */
  z.object({ type: z.literal('used_menu'), menuIds: ids, withinDays: days.optional() }).strict(),
  /** 誕生月 (既定: 今月) */
  z.object({ type: z.literal('birthday_month'), month: z.union([z.literal('current'), z.literal('next'), z.number().int().min(1).max(12)]).optional() }).strict(),
  /** 担当スタッフ */
  z.object({ type: z.literal('primary_staff'), staffIds: ids }).strict(),
  /** 店舗 (主店舗または来店/担当関係) */
  z.object({ type: z.literal('shop'), shopIds: ids }).strict(),
  /** タグ */
  z.object({ type: z.literal('tag'), tagIds: ids, match: z.enum(['any', 'all']).optional() }).strict(),
  /** 来店回数 */
  z.object({ type: z.literal('visit_count'), gte: z.number().int().min(0).optional(), lte: z.number().int().min(0).optional() }).strict(),
  /** 口コミ未投稿 (withinDays: 直近N日に投稿なし) */
  z.object({ type: z.literal('no_review'), withinDays: days.optional() }).strict(),
  /** 配信許可 (既定 true) */
  z.object({ type: z.literal('marketing_opt_in'), value: z.boolean().optional() }).strict(),
]);
export type SegmentCondition = z.infer<typeof segmentConditionSchema>;
export type SegmentRule = SegmentCondition | { all: SegmentRule[] } | { any: SegmentRule[] } | { not: SegmentRule };

export const segmentRuleSchema: z.ZodType<SegmentRule> = z.lazy(() =>
  z.union([
    segmentConditionSchema,
    z.object({ all: z.array(segmentRuleSchema).min(1).max(50) }).strict(),
    z.object({ any: z.array(segmentRuleSchema).min(1).max(50) }).strict(),
    z.object({ not: segmentRuleSchema }).strict(),
  ]),
);

const MAX_DEPTH = 6;
const MAX_NODES = 100;

/** Validate a rule (throws ZodError → 400, or validation AppError for shape limits) */
export function parseSegmentRule(raw: unknown): SegmentRule {
  const rule = segmentRuleSchema.parse(raw);
  let nodes = 0;
  const walk = (r: SegmentRule, depth: number) => {
    nodes++;
    if (depth > MAX_DEPTH) throw Errors.validation(`セグメント条件の入れ子は${MAX_DEPTH}階層までです`);
    if (nodes > MAX_NODES) throw Errors.validation(`セグメント条件は${MAX_NODES}個までです`);
    if ('all' in r) r.all.forEach((c) => walk(c, depth + 1));
    else if ('any' in r) r.any.forEach((c) => walk(c, depth + 1));
    else if ('not' in r) walk(r.not, depth + 1);
    else if (r.type === 'visit_count' && r.gte === undefined && r.lte === undefined) throw Errors.validation('visit_count には gte または lte を指定してください');
  };
  walk(rule, 1);
  return rule;
}

export interface CompileContext {
  organizationId: string;
  now: Date;
  tz: string;
}

const ACTIVE_FUTURE = ['tentative', 'confirmed'] as const;

function cutoff(c: CompileContext, d: number): Date {
  return new Date(c.now.getTime() - d * 86_400_000);
}

function monthFor(c: CompileContext, m: 'current' | 'next' | number | undefined): number {
  const local = DateTime.fromJSDate(c.now, { zone: c.tz });
  if (m === undefined || m === 'current') return local.month;
  if (m === 'next') return local.plus({ months: 1 }).month;
  return m;
}

type CEB = ExpressionBuilder<DB, 'customers'>;

function futureAppointment(eb: CEB, c: CompileContext) {
  return eb.exists(
    eb
      .selectFrom('appointments as fa')
      .select(sql`1`.as('x'))
      .whereRef('fa.customer_id', '=', 'customers.id')
      .where('fa.start_at', '>', c.now)
      .where('fa.status', 'in', [...ACTIVE_FUTURE])
      .where('fa.deleted_at', 'is', null),
  );
}

function compileCondition(eb: CEB, cond: SegmentCondition, c: CompileContext): Expression<SqlBool> {
  switch (cond.type) {
    case 'last_visit_days_gt':
      return eb('customers.last_visit_at', '<', cutoff(c, cond.days));
    case 'last_visit_days_lte':
      return eb('customers.last_visit_at', '>=', cutoff(c, cond.days));
    case 'no_future_appointment':
      return eb.not(futureAppointment(eb, c));
    case 'has_future_appointment':
      return futureAppointment(eb, c);
    case 'first_visit_within_days_without_return':
      return eb.and([
        eb('customers.visit_count', '=', 1),
        eb('customers.first_visit_at', 'is not', null),
        cond.windowElapsed === false ? eb('customers.first_visit_at', '>=', cutoff(c, cond.days)) : eb('customers.first_visit_at', '<', cutoff(c, cond.days)),
      ]);
    case 'ltv_top_percent':
      return eb(
        'customers.id',
        'in',
        sql<string>`(SELECT r.id FROM (
            SELECT c2.id, percent_rank() OVER (ORDER BY c2.total_sales DESC) AS pr
            FROM customers c2
            WHERE c2.organization_id = ${c.organizationId} AND c2.deleted_at IS NULL AND c2.status = 'active' AND c2.total_sales > 0
          ) r WHERE r.pr <= ${cond.percent / 100})`,
      );
    case 'used_menu': {
      const since = cond.withinDays !== undefined ? cutoff(c, cond.withinDays) : null;
      return eb.or([
        eb.exists(
          eb
            .selectFrom('appointment_services as us')
            .innerJoin('appointments as ua', 'ua.id', 'us.appointment_id')
            .select(sql`1`.as('x'))
            .whereRef('ua.customer_id', '=', 'customers.id')
            .where('ua.status', '=', 'completed')
            .where('ua.deleted_at', 'is', null)
            .where('us.menu_id', 'in', cond.menuIds)
            .$if(!!since, (q) => q.where('ua.start_at', '>=', since!)),
        ),
        eb.exists(
          eb
            .selectFrom('transaction_items as ti')
            .innerJoin('transactions as tt', 'tt.id', 'ti.transaction_id')
            .select(sql`1`.as('x'))
            .whereRef('tt.customer_id', '=', 'customers.id')
            .where('tt.status', 'in', ['completed', 'partially_refunded'])
            .where('ti.menu_id', 'in', cond.menuIds)
            .$if(!!since, (q) => q.where('tt.completed_at', '>=', since!)),
        ),
      ]);
    }
    case 'birthday_month':
      return eb(sql<number>`extract(month from customers.birthday)`, '=', monthFor(c, cond.month));
    case 'primary_staff':
      return eb.or([
        eb('customers.primary_staff_id', 'in', cond.staffIds),
        eb.exists(
          eb
            .selectFrom('customer_shop_relations as ps')
            .select(sql`1`.as('x'))
            .whereRef('ps.customer_id', '=', 'customers.id')
            .where('ps.relation_type', '=', 'primary_staff')
            .where('ps.ended_at', 'is', null)
            .where('ps.staff_id', 'in', cond.staffIds),
        ),
      ]);
    case 'shop':
      return shopCondition(eb, cond.shopIds);
    case 'tag': {
      if (cond.match === 'all') {
        const unique = [...new Set(cond.tagIds)];
        return eb(
          eb
            .selectFrom('customer_tags as ct')
            .select(sql<number>`count(DISTINCT ct.tag_id)::int`.as('n'))
            .whereRef('ct.customer_id', '=', 'customers.id')
            .where('ct.tag_id', 'in', unique),
          '=',
          unique.length,
        );
      }
      return eb.exists(eb.selectFrom('customer_tags as ct').select(sql`1`.as('x')).whereRef('ct.customer_id', '=', 'customers.id').where('ct.tag_id', 'in', cond.tagIds));
    }
    case 'visit_count': {
      const parts: Expression<SqlBool>[] = [];
      if (cond.gte !== undefined) parts.push(eb('customers.visit_count', '>=', cond.gte));
      if (cond.lte !== undefined) parts.push(eb('customers.visit_count', '<=', cond.lte));
      return eb.and(parts);
    }
    case 'no_review': {
      const since = cond.withinDays !== undefined ? cutoff(c, cond.withinDays) : null;
      return eb.not(
        eb.exists(
          eb
            .selectFrom('reviews as rv')
            .select(sql`1`.as('x'))
            .whereRef('rv.customer_id', '=', 'customers.id')
            .$if(!!since, (q) => q.where('rv.posted_at', '>=', since!)),
        ),
      );
    }
    case 'marketing_opt_in':
      return eb('customers.marketing_opt_in', '=', cond.value ?? true);
  }
}

export function shopCondition(eb: CEB, shopIds: readonly string[]): Expression<SqlBool> {
  const list = shopIds.length ? [...shopIds] : ['00000000-0000-0000-0000-000000000000'];
  return eb.or([
    eb('customers.primary_shop_id', 'in', list),
    eb.exists(
      eb
        .selectFrom('customer_shop_relations as sr')
        .select(sql`1`.as('x'))
        .whereRef('sr.customer_id', '=', 'customers.id')
        .where('sr.shop_id', 'in', list)
        .where('sr.ended_at', 'is', null),
    ),
  ]);
}

export function compileRule(eb: CEB, rule: SegmentRule, c: CompileContext): Expression<SqlBool> {
  if ('all' in rule) return eb.and(rule.all.map((r) => compileRule(eb, r, c)));
  if ('any' in rule) return eb.or(rule.any.map((r) => compileRule(eb, r, c)));
  if ('not' in rule) return eb.not(compileRule(eb, rule.not, c));
  return compileCondition(eb, rule, c);
}

export async function compileContext(ctx: Ctx): Promise<CompileContext> {
  return { organizationId: ctx.actor.organizationId, now: clock.now(), tz: await orgTimezone(ctx) };
}

/** Base query: active customers matching the rule (optionally limited to a shop / staff visibility) */
export function segmentQuery(ctx: Ctx, rule: SegmentRule, c: CompileContext, opts: { shopId?: string | null; applyVisibility?: boolean } = {}) {
  let q = ctx.trx
    .selectFrom('customers')
    .where('customers.deleted_at', 'is', null)
    .where('customers.status', '=', 'active')
    .where((eb) => compileRule(eb, rule, c));
  if (opts.shopId) q = q.where((eb) => shopCondition(eb, [opts.shopId!]));
  if (opts.applyVisibility) {
    const filter = visibleCustomerFilter(ctx);
    if (filter) q = q.where(filter);
  }
  return q;
}

/** Keyset batch of matching customer ids (campaign snapshot) */
export async function segmentCustomerIds(ctx: Ctx, rule: SegmentRule, opts: { shopId?: string | null; afterId?: string | null; limit: number }) {
  const c = await compileContext(ctx);
  let q = segmentQuery(ctx, rule, c, { shopId: opts.shopId }).select(['customers.id', 'customers.primary_shop_id']);
  if (opts.afterId) q = q.where('customers.id', '>', opts.afterId);
  return q.orderBy('customers.id').limit(opts.limit).execute();
}

export async function previewSegment(ctx: Ctx, input: { rule: unknown; shopId?: string; sampleSize?: number }) {
  requirePermission(ctx.actor, 'campaign.manage');
  const rule = parseSegmentRule(input.rule);
  const c = await compileContext(ctx);
  const base = segmentQuery(ctx, rule, c, { shopId: input.shopId ?? null, applyVisibility: true });
  const { count } = await base.select((eb) => eb.fn.countAll<number>().as('count')).executeTakeFirstOrThrow();
  const sample = (input.sampleSize ?? 20) > 0
    ? await base
        .select([
          'customers.id',
          'customers.last_name',
          'customers.first_name',
          'customers.last_name_kana',
          'customers.first_name_kana',
          'customers.last_visit_at',
          'customers.visit_count',
          'customers.total_sales',
          'customers.marketing_opt_in',
        ])
        .orderBy(sql`coalesce(customers.last_visit_at, 'epoch'::timestamptz)`, 'desc')
        .orderBy('customers.id')
        .limit(input.sampleSize ?? 20)
        .execute()
    : [];
  return { count: Number(count), sample: sample.map((s) => ({ ...s, display_name: displayName(s) })) };
}

// ---------------------------------------------------------------- CRUD

const segmentColumns = ['id', 'name', 'description', 'rule', 'created_by', 'created_at', 'updated_at'] as const;

export async function listSegments(ctx: Ctx, input: { cursor?: string; limit: number }) {
  requirePermission(ctx.actor, 'campaign.manage');
  let q = ctx.trx.selectFrom('segments').select(segmentColumns);
  const cursor = decodeCursor(input.cursor);
  if (cursor) q = q.where(sql<boolean>`(created_at, id) < (${cursor.v}::timestamptz, ${cursor.id}::uuid)`);
  const rows = await q.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(input.limit + 1).execute();
  return paginate(rows, input.limit, (r) => r.created_at);
}

export async function getSegment(ctx: Ctx, id: string) {
  requirePermission(ctx.actor, 'campaign.manage');
  const row = await ctx.trx.selectFrom('segments').select(segmentColumns).where('id', '=', id).executeTakeFirst();
  if (!row) throw Errors.notFound('セグメント', id);
  return row;
}

export async function createSegment(ctx: Ctx, input: { name: string; description?: string | null; rule: unknown }) {
  requirePermission(ctx.actor, 'campaign.manage');
  const rule = parseSegmentRule(input.rule);
  const row = await ctx.trx
    .insertInto('segments')
    .values({ organization_id: ctx.actor.organizationId, name: input.name, description: input.description ?? null, rule: JSON.stringify(rule), created_by: auditUserId(ctx.actor) })
    .returning(segmentColumns)
    .executeTakeFirstOrThrow();
  await audit(ctx, { action: 'segment.create', resourceType: 'segment', resourceId: row.id, after: { name: input.name, rule } });
  return row;
}

export async function updateSegment(ctx: Ctx, id: string, input: { name?: string; description?: string | null; rule?: unknown }) {
  const before = await getSegment(ctx, id);
  const rule = input.rule !== undefined ? parseSegmentRule(input.rule) : undefined;
  const row = await ctx.trx
    .updateTable('segments')
    .set({ name: input.name, description: input.description, rule: rule ? JSON.stringify(rule) : undefined })
    .where('id', '=', id)
    .returning(segmentColumns)
    .executeTakeFirstOrThrow();
  await audit(ctx, { action: 'segment.update', resourceType: 'segment', resourceId: id, ...diff(before, row) });
  return row;
}

export async function deleteSegment(ctx: Ctx, id: string) {
  await getSegment(ctx, id);
  const active = await ctx.trx.selectFrom('campaigns').select('id').where('segment_id', '=', id).where('status', 'in', ['scheduled', 'running']).executeTakeFirst();
  if (active) throw Errors.business('SEGMENT_IN_USE', '配信予定のキャンペーンで使用中のため削除できません');
  // campaigns keep their own rule snapshot
  await ctx.trx.updateTable('campaigns').set({ segment_id: null }).where('segment_id', '=', id).execute();
  await ctx.trx.deleteFrom('segments').where('id', '=', id).execute();
  await audit(ctx, { action: 'segment.delete', resourceType: 'segment', resourceId: id });
}
