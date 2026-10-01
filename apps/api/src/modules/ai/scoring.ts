import { sql } from 'kysely';
import { assertShopAccess, requirePermission, type Ctx } from '../../auth/actor.js';
import { decodeCursor, encodeCursor } from '../../lib/pagination.js';
import { DEFAULT_TZ, localDate } from '../../lib/time.js';
import { visibleCustomerFilter } from '../customers/access.js';
import { displayName } from '../customers/service.js';
import type { AtRiskQuery } from './schemas.js';

/**
 * Churn / next-visit scoring v1 — a transparent heuristic (要件 14), not a trained model.
 *
 *   expected_cycle = customer's avg_cycle_days (≥ 2 visits) | org median cycle | 60 days   (clamped 7..365)
 *   r              = days_since_last_visit / expected_cycle
 *   base           = 1 / (1 + exp(−K · (r − 1.5)))          K = 3  → r = 1.5 ⇒ 0.5
 *   risk           = min(1, base + 0.05 · min(no_show_count, 3))
 *   risk          ×= 0.2 when a future appointment exists
 *   level          = high ≥ 0.7 > medium ≥ 0.4 > low
 *   predicted_next = next appointment date | last_visit + expected_cycle
 *   expected_ltv   = avg_ticket × (365 / expected_cycle) × (1 − risk)
 */
export const MODEL_VERSION = 'heuristic-v1';
export const SCORING = {
  k: 3,
  threshold: 1.5,
  defaultCycleDays: 60,
  minCycleDays: 7,
  maxCycleDays: 365,
  futureDamping: 0.2,
  noShowBump: 0.05,
  noShowCap: 3,
  high: 0.7,
  medium: 0.4,
} as const;

const DAY_MS = 86_400_000;

export interface ScoreInput {
  lastVisitAt: Date;
  avgCycleDays: number | null;
  visitCount: number;
  totalSales: number;
  noShowCount: number;
  nextAppointmentAt: Date | null;
}

export interface ScoreResult {
  churnRisk: number;
  level: 'low' | 'medium' | 'high';
  predictedNextVisit: string;
  expectedLtv12m: number;
  recommendedAction: string;
  features: {
    days_since_last_visit: number;
    avg_cycle_days: number | null;
    expected_cycle_days: number;
    cycle_source: 'customer' | 'org_median' | 'default';
    visit_count: number;
    total_sales: number;
    avg_ticket: number;
    no_show_count: number;
    has_future_appointment: boolean;
    next_appointment_at: string | null;
    cycle_ratio: number;
    overdue_days: number;
  };
}

export function computeScore(input: ScoreInput, ctx: { now: Date; tz: string; orgMedianCycleDays: number | null }): ScoreResult {
  const days = Math.max(0, Math.floor((ctx.now.getTime() - input.lastVisitAt.getTime()) / DAY_MS));
  let cycleSource: ScoreResult['features']['cycle_source'] = 'default';
  let cycle: number = SCORING.defaultCycleDays;
  if (input.visitCount >= 2 && input.avgCycleDays && input.avgCycleDays > 0) {
    cycle = input.avgCycleDays;
    cycleSource = 'customer';
  } else if (ctx.orgMedianCycleDays && ctx.orgMedianCycleDays > 0) {
    cycle = ctx.orgMedianCycleDays;
    cycleSource = 'org_median';
  }
  cycle = Math.min(SCORING.maxCycleDays, Math.max(SCORING.minCycleDays, cycle));
  const r = days / cycle;
  const base = 1 / (1 + Math.exp(-SCORING.k * (r - SCORING.threshold)));
  const hasFuture = !!input.nextAppointmentAt && input.nextAppointmentAt.getTime() > ctx.now.getTime();
  let risk = Math.min(1, base + SCORING.noShowBump * Math.min(input.noShowCount, SCORING.noShowCap));
  if (hasFuture) risk *= SCORING.futureDamping;
  risk = Math.round(risk * 10000) / 10000;
  const level = risk >= SCORING.high ? 'high' : risk >= SCORING.medium ? 'medium' : 'low';
  const avgTicket = input.visitCount > 0 ? Math.round(input.totalSales / input.visitCount) : 0;
  const expectedLtv12m = Math.round(avgTicket * (365 / cycle) * (1 - risk));
  const predictedNextVisit = hasFuture ? localDate(input.nextAppointmentAt!, ctx.tz) : localDate(new Date(input.lastVisitAt.getTime() + Math.round(cycle * DAY_MS)), ctx.tz);
  const overdue = Math.round(days - cycle);
  const cycleLabel = Math.round(cycle);

  let action: string;
  if (hasFuture) action = `次回予約あり(${predictedNextVisit}): 予約前リマインドのみで可`;
  else if (level === 'low' && overdue < 0) action = `来店周期内(周期${cycleLabel}日・前回から${days}日): 対応不要`;
  else if (input.visitCount <= 1 && overdue > 0) action = `初回来店から${days}日経過・再来なし: 2回目来店のフォローメッセージ推奨`;
  else if (overdue > 0) action = `来店周期を${overdue}日超過: フォローメッセージ推奨`;
  else action = `まもなく来店周期(${cycleLabel}日): 次回予約の提案を推奨`;
  if (input.noShowCount >= 2) action += ` / 無断キャンセル歴${input.noShowCount}回: 予約時の事前確認を推奨`;

  return {
    churnRisk: risk,
    level,
    predictedNextVisit,
    expectedLtv12m,
    recommendedAction: action,
    features: {
      days_since_last_visit: days,
      avg_cycle_days: input.avgCycleDays,
      expected_cycle_days: Math.round(cycle * 100) / 100,
      cycle_source: cycleSource,
      visit_count: input.visitCount,
      total_sales: input.totalSales,
      avg_ticket: avgTicket,
      no_show_count: input.noShowCount,
      has_future_appointment: hasFuture,
      next_appointment_at: hasFuture ? input.nextAppointmentAt!.toISOString() : null,
      cycle_ratio: Math.round(r * 1000) / 1000,
      overdue_days: overdue,
    },
  };
}

export async function orgMedianCycle(ctx: Ctx): Promise<number | null> {
  const res = await sql<{ median: number | null }>`
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY avg_cycle_days)::float8 AS median
      FROM customers
     WHERE organization_id = ${ctx.actor.organizationId} AND deleted_at IS NULL AND status = 'active'
       AND visit_count >= 2 AND avg_cycle_days > 0`.execute(ctx.trx);
  const m = res.rows[0]?.median;
  return m === null || m === undefined ? null : Number(m);
}

/** Recompute customer_scores for every active customer with at least one visit (batched, upsert). */
export async function scoreOrganization(ctx: Ctx, now = new Date()): Promise<{ scored: number; orgMedianCycleDays: number | null }> {
  const org = await ctx.trx.selectFrom('organizations').select('timezone').where('id', '=', ctx.actor.organizationId).executeTakeFirst();
  const tz = org?.timezone ?? DEFAULT_TZ;
  const median = await orgMedianCycle(ctx);
  let after = '00000000-0000-0000-0000-000000000000';
  let scored = 0;
  for (;;) {
    const batch = await ctx.trx
      .selectFrom('customers')
      .select([
        'customers.id',
        'customers.last_visit_at',
        'customers.avg_cycle_days',
        'customers.visit_count',
        'customers.total_sales',
        'customers.no_show_count',
        (eb) =>
          eb
            .selectFrom('appointments as a')
            .select(sql<Date | null>`min(a.start_at)`.as('m'))
            .whereRef('a.customer_id', '=', 'customers.id')
            .where('a.start_at', '>', now)
            .where('a.status', 'in', ['tentative', 'confirmed'])
            .where('a.deleted_at', 'is', null)
            .as('next_at'),
      ])
      .where('customers.deleted_at', 'is', null)
      .where('customers.status', '=', 'active')
      .where('customers.last_visit_at', 'is not', null)
      .where('customers.id', '>', after)
      .orderBy('customers.id')
      .limit(500)
      .execute();
    if (!batch.length) break;
    const values = batch.map((c) => {
      const s = computeScore(
        {
          lastVisitAt: c.last_visit_at!,
          avgCycleDays: c.avg_cycle_days,
          visitCount: c.visit_count,
          totalSales: c.total_sales,
          noShowCount: c.no_show_count,
          nextAppointmentAt: c.next_at ?? null,
        },
        { now, tz, orgMedianCycleDays: median },
      );
      return {
        customer_id: c.id,
        organization_id: ctx.actor.organizationId,
        churn_risk: s.churnRisk,
        churn_risk_level: s.level,
        predicted_next_visit: s.predictedNextVisit,
        expected_ltv_12m: s.expectedLtv12m,
        recommended_action: s.recommendedAction,
        features: JSON.stringify(s.features),
        model_version: MODEL_VERSION,
        computed_at: now,
      };
    });
    await ctx.trx
      .insertInto('customer_scores')
      .values(values)
      .onConflict((oc) =>
        oc.column('customer_id').doUpdateSet((eb) => ({
          churn_risk: eb.ref('excluded.churn_risk'),
          churn_risk_level: eb.ref('excluded.churn_risk_level'),
          predicted_next_visit: eb.ref('excluded.predicted_next_visit'),
          expected_ltv_12m: eb.ref('excluded.expected_ltv_12m'),
          recommended_action: eb.ref('excluded.recommended_action'),
          features: eb.ref('excluded.features'),
          model_version: eb.ref('excluded.model_version'),
          computed_at: eb.ref('excluded.computed_at'),
        })),
      )
      .execute();
    scored += batch.length;
    after = batch[batch.length - 1]!.id;
  }
  return { scored, orgMedianCycleDays: median };
}

/** GET /ai/at-risk-customers — highest churn risk first, limited to customers the caller may see */
export async function listAtRiskCustomers(ctx: Ctx, input: AtRiskQuery) {
  requirePermission(ctx.actor, 'customer.read');
  const levels = input.level ? [input.level] : ['high', 'medium'];
  let q = ctx.trx
    .selectFrom('customer_scores as s')
    .innerJoin('customers', 'customers.id', 's.customer_id')
    .select([
      'customers.id',
      'customers.last_name',
      'customers.first_name',
      'customers.last_name_kana',
      'customers.first_name_kana',
      'customers.primary_shop_id',
      'customers.primary_staff_id',
      'customers.last_visit_at',
      'customers.visit_count',
      'customers.marketing_opt_in',
      's.churn_risk',
      's.churn_risk_level',
      's.predicted_next_visit',
      's.expected_ltv_12m',
      's.recommended_action',
      's.features',
      's.model_version',
      's.computed_at',
    ])
    .where('customers.deleted_at', 'is', null)
    .where('customers.status', '=', 'active')
    .where('s.churn_risk_level', 'in', levels);
  const filter = visibleCustomerFilter(ctx);
  if (filter) q = q.where(filter);
  if (input.shopId) {
    assertShopAccess(ctx.actor, input.shopId);
    const shopId = input.shopId;
    q = q.where((eb) =>
      eb.or([
        eb('customers.primary_shop_id', '=', shopId),
        eb.exists(eb.selectFrom('customer_shop_relations as r').select(sql`1`.as('x')).whereRef('r.customer_id', '=', 'customers.id').where('r.shop_id', '=', shopId)),
      ]),
    );
  }
  const cursor = decodeCursor(input.cursor);
  if (cursor) q = q.where(sql`(s.churn_risk, customers.id)`, '<', sql`(${cursor.v}::numeric, ${cursor.id}::uuid)`);
  const rows = await q.orderBy('s.churn_risk', 'desc').orderBy('customers.id', 'desc').limit(input.limit + 1).execute();
  const hasMore = rows.length > input.limit;
  const items = (hasMore ? rows.slice(0, input.limit) : rows).map((r) => ({
    customerId: r.id,
    customerName: displayName(r),
    primaryShopId: r.primary_shop_id,
    primaryStaffId: r.primary_staff_id,
    lastVisitAt: r.last_visit_at,
    visitCount: r.visit_count,
    marketingOptIn: r.marketing_opt_in,
    churnRisk: r.churn_risk,
    level: r.churn_risk_level,
    predictedNextVisit: r.predicted_next_visit,
    expectedLtv12m: r.expected_ltv_12m,
    recommendedAction: r.recommended_action,
    features: r.features,
    modelVersion: r.model_version,
    computedAt: r.computed_at,
  }));
  const last = items[items.length - 1];
  return { items, nextCursor: hasMore && last ? encodeCursor(last.churnRisk, last.customerId) : null };
}
