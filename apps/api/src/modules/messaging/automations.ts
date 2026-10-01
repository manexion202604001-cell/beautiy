import { sql, type Expression, type ExpressionBuilder, type SqlBool } from 'kysely';
import type { DB } from '../../db/types.js';
import { DateTime } from 'luxon';
import { accessibleShopIds, assertShopAccess, auditUserId, requirePermission, type Ctx } from '../../auth/actor.js';
import { withSystem } from '../../db/tenant.js';
import { enqueue, registerJob } from '../../jobs/queue.js';
import { dailyAt, registerPeriodic } from '../../jobs/scheduler.js';
import { audit, diff } from '../../lib/audit.js';
import { Errors } from '../../lib/errors.js';
import { displayName } from '../customers/service.js';
import { queueMessage } from './api.js';
import { clock } from './clock.js';
import { automationConfigSchema, type AutomationConfig, type CreateAutomationInput, type TriggerType, type UpdateAutomationInput } from './schemas.js';
import { compileContext, compileRule, parseSegmentRule, shopCondition } from './segments.js';

/**
 * Automations (来店周期・休眠期間に応じた自動配信, FR-03).
 * A daily periodic task (10:00 JST) fans out one 'automation.run' job per active automation. Each run
 * evaluates candidates and records automation_runs(dedupe_key) BEFORE queueing, so the same visit cycle
 * never triggers twice:  <automationId>:<customerId>:<last visit date | first visit date | birthday year>
 */
const automationColumns = ['id', 'shop_id', 'name', 'trigger_type', 'config', 'channel', 'template_id', 'is_active', 'last_run_at', 'created_by', 'created_at', 'updated_at'] as const;

const DEFAULT_TEMPLATE_KEY: Record<TriggerType, string> = {
  days_since_last_visit: 'dormant_followup',
  no_return_after_first_visit: 'first_visit_followup',
  visit_cycle_due: 'dormant_followup',
  after_visit: 'followup_after_visit',
  birthday_month: 'birthday',
};

const DEFAULT_DAYS: Partial<Record<TriggerType, number>> = { days_since_last_visit: 45, no_return_after_first_visit: 60, after_visit: 3 };
/** after_visit only targets visits within this window after the N days (no blast of old history) */
const AFTER_VISIT_WINDOW_DAYS = 7;
const RUN_LIMIT = 5000;

type AutomationRow = {
  id: string;
  shop_id: string | null;
  name: string;
  trigger_type: string;
  config: unknown;
  channel: string;
  template_id: string | null;
  is_active: boolean;
};

function parseConfig(raw: unknown): AutomationConfig {
  return automationConfigSchema.parse(raw ?? {});
}

function validateConfig(trigger: TriggerType, cfg: AutomationConfig) {
  if (cfg.segmentRule !== undefined) parseSegmentRule(cfg.segmentRule);
  if (trigger === 'visit_cycle_due' && cfg.days !== undefined) throw Errors.validation('visit_cycle_due では days ではなく offsetDays を指定してください');
}

/** Candidate query: customers + dedupe key for this automation */
async function candidateQuery(ctx: Ctx, a: AutomationRow) {
  const trigger = a.trigger_type as TriggerType;
  const cfg = parseConfig(a.config);
  const c = await compileContext(ctx);
  const now = c.now;
  const tz = c.tz;
  const days = cfg.days ?? DEFAULT_DAYS[trigger] ?? 0;
  const cut = new Date(now.getTime() - days * 86_400_000);
  const localDateOf = (col: 'customers.last_visit_at' | 'customers.first_visit_at') => sql<string>`to_char(${sql.ref(col)} AT TIME ZONE ${tz}, 'YYYY-MM-DD')`;

  let dedupeExpr;
  switch (trigger) {
    case 'no_return_after_first_visit':
      dedupeExpr = localDateOf('customers.first_visit_at');
      break;
    case 'birthday_month':
      dedupeExpr = sql<string>`${String(DateTime.fromJSDate(now, { zone: tz }).year)}`;
      break;
    default:
      dedupeExpr = localDateOf('customers.last_visit_at');
  }
  const dedupeKey = sql<string>`${a.id + ':'} || customers.id::text || ':' || ${dedupeExpr}`;

  let q = ctx.trx
    .selectFrom('customers')
    .where('customers.deleted_at', 'is', null)
    .where('customers.status', '=', 'active')
    .where('customers.marketing_opt_in', '=', true);

  const noFuture = (eb: ExpressionBuilder<DB, 'customers'>) =>
    eb.not(
      eb.exists(
        eb
          .selectFrom('appointments as fa')
          .select(sql`1`.as('x'))
          .whereRef('fa.customer_id', '=', 'customers.id')
          .where('fa.start_at', '>', now)
          .where('fa.status', 'in', ['tentative', 'confirmed'])
          .where('fa.deleted_at', 'is', null),
      ),
    );

  switch (trigger) {
    case 'days_since_last_visit':
      q = q.where('customers.last_visit_at', '<', cut);
      if (cfg.requireNoFutureAppointment !== false) q = q.where(noFuture);
      break;
    case 'no_return_after_first_visit':
      q = q.where('customers.visit_count', '=', 1).where('customers.first_visit_at', '<', cut);
      if (cfg.requireNoFutureAppointment !== false) q = q.where(noFuture);
      break;
    case 'visit_cycle_due':
      q = q
        .where('customers.visit_count', '>=', cfg.minVisits ?? 2)
        .where('customers.avg_cycle_days', 'is not', null)
        .where('customers.last_visit_at', 'is not', null)
        .where(sql<boolean>`customers.last_visit_at + ((customers.avg_cycle_days + ${cfg.offsetDays ?? 0}) * interval '1 day') <= ${now}`);
      if (cfg.requireNoFutureAppointment !== false) q = q.where(noFuture);
      break;
    case 'after_visit':
      q = q.where('customers.last_visit_at', '<=', cut).where('customers.last_visit_at', '>', new Date(cut.getTime() - AFTER_VISIT_WINDOW_DAYS * 86_400_000));
      if (cfg.requireNoFutureAppointment === true) q = q.where(noFuture);
      break;
    case 'birthday_month':
      q = q.where(sql<number>`extract(month from customers.birthday)`, '=', DateTime.fromJSDate(now, { zone: tz }).month);
      break;
  }
  if (a.shop_id) q = q.where((eb) => shopCondition(eb, [a.shop_id!]));
  if (cfg.segmentRule !== undefined) {
    const rule = parseSegmentRule(cfg.segmentRule);
    q = q.where((eb) => compileRule(eb, rule, c) as Expression<SqlBool>);
  }
  const fresh = q.where((eb) =>
    eb.not(eb.exists(eb.selectFrom('automation_runs as ar').select(sql`1`.as('x')).where('ar.automation_id', '=', a.id).where('ar.dedupe_key', '=', dedupeKey))),
  );
  return { query: fresh, all: q, dedupeKey, cfg, tz, now };
}

function sendAt(cfg: AutomationConfig, now: Date, tz: string): Date | undefined {
  if (cfg.sendHour === undefined) return undefined;
  const at = DateTime.fromJSDate(now, { zone: tz }).set({ hour: cfg.sendHour, minute: 0, second: 0, millisecond: 0 });
  return at.toJSDate() > now ? at.toJSDate() : undefined;
}

/** Evaluate an automation and queue messages for new candidates. Returns the number queued. */
export async function runAutomation(ctx: Ctx, automationId: string): Promise<{ queued: number }> {
  const a = await ctx.trx.selectFrom('automations').select(automationColumns).where('id', '=', automationId).executeTakeFirst();
  if (!a || !a.is_active) return { queued: 0 };
  const { query, dedupeKey, cfg, tz, now } = await candidateQuery(ctx, a);
  const candidates = await query.select(['customers.id', 'customers.primary_shop_id', dedupeKey.as('dedupe_key')]).orderBy('customers.id').limit(RUN_LIMIT).execute();
  const trigger = a.trigger_type as TriggerType;
  const scheduledAt = sendAt(cfg, now, tz);
  let queued = 0;
  for (const cand of candidates) {
    const run = await ctx.trx
      .insertInto('automation_runs')
      .values({ organization_id: ctx.actor.organizationId, automation_id: a.id, customer_id: cand.id, dedupe_key: cand.dedupe_key })
      .onConflict((oc) => oc.columns(['automation_id', 'dedupe_key']).doNothing())
      .returning('id')
      .executeTakeFirst();
    if (!run) continue;
    const res = await queueMessage(ctx, {
      customerId: cand.id,
      shopId: a.shop_id ?? cand.primary_shop_id,
      category: 'marketing',
      channel: a.channel as 'line' | 'email' | 'sms',
      templateId: a.template_id ?? undefined,
      templateKey: a.template_id ? undefined : (cfg.templateKey ?? DEFAULT_TEMPLATE_KEY[trigger]),
      automationId: a.id,
      scheduledAt,
      dedupeKey: `automation:${cand.dedupe_key}`,
    });
    if (res.messageId) {
      await ctx.trx.updateTable('automation_runs').set({ message_id: res.messageId }).where('id', '=', run.id).execute();
      queued++;
    }
  }
  await ctx.trx.updateTable('automations').set({ last_run_at: new Date() }).where('id', '=', a.id).execute();
  return { queued };
}

registerJob<{ automationId: string }>('automation.run', async ({ automationId }, jc) => {
  await jc.tx((ctx) => runAutomation(ctx, automationId));
});

/** Global daily fan-out: one job per active automation (organization-scoped) */
registerJob('automation.fanout', async () => {
  const today = DateTime.fromJSDate(clock.now(), { zone: 'Asia/Tokyo' }).toISODate();
  await withSystem(async (trx) => {
    const rows = await trx
      .selectFrom('automations')
      .innerJoin('organizations', 'organizations.id', 'automations.organization_id')
      .select(['automations.id', 'automations.organization_id'])
      .where('automations.is_active', '=', true)
      .where('organizations.status', 'in', ['active', 'trial'])
      .execute();
    for (const r of rows) {
      await enqueue(trx, { type: 'automation.run', organizationId: r.organization_id, payload: { automationId: r.id }, dedupeKey: `automation:${r.id}:${today}` });
    }
  });
});

registerPeriodic({ name: 'messaging.automations.daily', jobType: 'automation.fanout', bucket: dailyAt(10) });

// ---------------------------------------------------------------- CRUD

function assertScope(ctx: Ctx, shopId: string | null | undefined) {
  if (shopId) assertShopAccess(ctx.actor, shopId);
  else if (accessibleShopIds(ctx.actor)) throw Errors.forbidden('全店舗向けの自動配信には全店舗権限が必要です');
}

async function loadAutomation(ctx: Ctx, id: string) {
  const a = await ctx.trx.selectFrom('automations').select(automationColumns).where('id', '=', id).executeTakeFirst();
  if (!a) throw Errors.notFound('自動配信', id);
  assertShopAccess(ctx.actor, a.shop_id);
  return a;
}

async function assertTemplate(ctx: Ctx, templateId: string | null | undefined) {
  if (!templateId) return;
  const t = await ctx.trx.selectFrom('message_templates').select(['id', 'shop_id']).where('id', '=', templateId).executeTakeFirst();
  if (!t) throw Errors.notFound('テンプレート', templateId);
  assertShopAccess(ctx.actor, t.shop_id);
}

export async function listAutomations(ctx: Ctx) {
  requirePermission(ctx.actor, 'campaign.manage');
  let q = ctx.trx.selectFrom('automations').select(automationColumns);
  const shops = accessibleShopIds(ctx.actor);
  if (shops) q = q.where((eb) => eb.or([eb('shop_id', 'is', null), ...(shops.length ? [eb('shop_id', 'in', shops)] : [])]));
  return q.orderBy('created_at', 'desc').execute();
}

export async function getAutomation(ctx: Ctx, id: string) {
  requirePermission(ctx.actor, 'campaign.manage');
  const a = await loadAutomation(ctx, id);
  const stats = await ctx.trx
    .selectFrom('automation_runs')
    .leftJoin('messages', 'messages.id', 'automation_runs.message_id')
    .select([sql<number>`count(*)::int`.as('runs'), sql<number>`count(*) FILTER (WHERE messages.status = 'sent')::int`.as('sent')])
    .where('automation_runs.automation_id', '=', id)
    .executeTakeFirstOrThrow();
  return { ...a, stats: { runs: Number(stats.runs), sent: Number(stats.sent) } };
}

export async function createAutomation(ctx: Ctx, input: CreateAutomationInput) {
  requirePermission(ctx.actor, 'campaign.manage');
  assertScope(ctx, input.shopId);
  validateConfig(input.triggerType, input.config);
  await assertTemplate(ctx, input.templateId);
  const row = await ctx.trx
    .insertInto('automations')
    .values({
      organization_id: ctx.actor.organizationId,
      shop_id: input.shopId ?? null,
      name: input.name,
      trigger_type: input.triggerType,
      config: JSON.stringify(input.config),
      channel: input.channel,
      template_id: input.templateId ?? null,
      is_active: input.isActive,
      created_by: auditUserId(ctx.actor),
    })
    .returning(automationColumns)
    .executeTakeFirstOrThrow();
  await audit(ctx, { action: 'automation.create', resourceType: 'automation', resourceId: row.id, shopId: row.shop_id, after: input });
  return row;
}

export async function updateAutomation(ctx: Ctx, id: string, input: UpdateAutomationInput) {
  requirePermission(ctx.actor, 'campaign.manage');
  const before = await loadAutomation(ctx, id);
  if (input.shopId !== undefined) assertScope(ctx, input.shopId);
  if (input.config) validateConfig(before.trigger_type as TriggerType, input.config);
  if (input.templateId) await assertTemplate(ctx, input.templateId);
  const row = await ctx.trx
    .updateTable('automations')
    .set({
      name: input.name,
      shop_id: input.shopId,
      config: input.config ? JSON.stringify(input.config) : undefined,
      channel: input.channel,
      template_id: input.templateId,
      is_active: input.isActive,
    })
    .where('id', '=', id)
    .returning(automationColumns)
    .executeTakeFirstOrThrow();
  await audit(ctx, { action: 'automation.update', resourceType: 'automation', resourceId: id, shopId: row.shop_id, ...diff(before, row) });
  return row;
}

export async function deleteAutomation(ctx: Ctx, id: string) {
  requirePermission(ctx.actor, 'campaign.manage');
  const a = await loadAutomation(ctx, id);
  const hasRuns = await ctx.trx.selectFrom('automation_runs').select('id').where('automation_id', '=', id).limit(1).executeTakeFirst();
  if (hasRuns) {
    // keep the dedupe history; just deactivate
    await ctx.trx.updateTable('automations').set({ is_active: false }).where('id', '=', id).execute();
  } else {
    await ctx.trx.deleteFrom('automations').where('id', '=', id).execute();
  }
  await audit(ctx, { action: 'automation.delete', resourceType: 'automation', resourceId: id, shopId: a.shop_id, metadata: { deactivatedOnly: !!hasRuns } });
  return { ok: true as const, deactivatedOnly: !!hasRuns };
}

/** Dry run: how many customers would be messaged now (excluding those already messaged for this cycle) */
export async function dryRunAutomation(ctx: Ctx, id: string) {
  requirePermission(ctx.actor, 'campaign.manage');
  const a = await loadAutomation(ctx, id);
  const { query, all } = await candidateQuery(ctx, a);
  const [{ n: candidates }, { n: matching }] = await Promise.all([
    query.select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow(),
    all.select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow(),
  ]);
  const sample = await query
    .select(['customers.id', 'customers.last_name', 'customers.first_name', 'customers.last_name_kana', 'customers.first_name_kana', 'customers.last_visit_at', 'customers.visit_count'])
    .orderBy('customers.id')
    .limit(20)
    .execute();
  return {
    candidates: Number(candidates),
    alreadySent: Number(matching) - Number(candidates),
    sample: sample.map((s) => ({ ...s, display_name: displayName(s) })),
  };
}
