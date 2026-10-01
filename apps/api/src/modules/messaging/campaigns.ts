import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { accessibleShopIds, assertShopAccess, auditUserId, requirePermission, type Ctx } from '../../auth/actor.js';
import { cancelJobs, enqueue, registerJob } from '../../jobs/queue.js';
import { audit, diff } from '../../lib/audit.js';
import { Errors } from '../../lib/errors.js';
import { decodeCursor, paginate } from '../../lib/pagination.js';
import { cancelQueuedMessages, enqueueDelivery, type OutboundPayload } from './api.js';
import { clock } from './clock.js';
import { markSkipped, prepareDelivery } from './delivery.js';
import { MULTICAST_LIMIT } from './providers/line.js';
import type { CreateCampaignInput, UpdateCampaignInput } from './schemas.js';
import { parseSegmentRule, segmentCustomerIds, type SegmentRule } from './segments.js';

/**
 * Campaigns (一括配信, FR-03 セグメント一括配信).
 *   draft → (approve) → schedule → [campaign.run: snapshot segment into messages] → [campaign.dispatch:
 *   consent/quiet-hours/render per message, identical LINE texts multicast in batches of 500]
 *   → completed (campaign.stats).
 * Nothing is ever sent without an explicit schedule action by staff (AI-generated drafts included).
 */
const campaignColumns = [
  'id',
  'shop_id',
  'name',
  'channel',
  'segment_id',
  'segment_rule',
  'template_id',
  'body',
  'scheduled_at',
  'status',
  'stats',
  'approved_by',
  'approved_at',
  'started_at',
  'completed_at',
  'created_by',
  'created_at',
  'updated_at',
] as const;

export interface CampaignStats {
  targets: number;
  queued: number;
  sent: number;
  failed: number;
  skipped: number;
  cancelled: number;
}

const SNAPSHOT_BATCH = 1000;

async function liveStats(ctx: Ctx, campaignId: string, targets?: number): Promise<CampaignStats> {
  const rows = await ctx.trx
    .selectFrom('messages')
    .select(['status', sql<number>`count(*)::int`.as('n')])
    .where('campaign_id', '=', campaignId)
    .groupBy('status')
    .execute();
  const n = (s: string[]) => rows.filter((r) => s.includes(r.status)).reduce((sum, r) => sum + Number(r.n), 0);
  const total = rows.reduce((sum, r) => sum + Number(r.n), 0);
  return { targets: targets ?? total, queued: n(['queued', 'sending']), sent: n(['sent', 'read']), failed: n(['failed']), skipped: n(['skipped']), cancelled: n(['cancelled']) };
}

async function withStats<T extends { id: string; stats: unknown; status: string }>(ctx: Ctx, c: T) {
  const stored = (c.stats ?? {}) as Partial<CampaignStats>;
  if (c.status === 'draft' || c.status === 'scheduled') return { ...c, stats: { targets: stored.targets ?? 0, queued: 0, sent: 0, failed: 0, skipped: 0, cancelled: 0 } };
  return { ...c, stats: await liveStats(ctx, c.id, stored.targets) };
}

function assertCampaignScope(ctx: Ctx, shopId: string | null | undefined) {
  if (shopId) assertShopAccess(ctx.actor, shopId);
  else if (accessibleShopIds(ctx.actor)) throw Errors.forbidden('全店舗向けの配信には全店舗権限が必要です');
}

async function loadCampaign(ctx: Ctx, id: string, forUpdate = false) {
  let q = ctx.trx.selectFrom('campaigns').select(campaignColumns).where('id', '=', id);
  if (forUpdate) q = q.forUpdate();
  const c = await q.executeTakeFirst();
  if (!c) throw Errors.notFound('キャンペーン', id);
  assertShopAccess(ctx.actor, c.shop_id);
  return c;
}

async function resolveRule(ctx: Ctx, segmentId: string | null | undefined, rawRule: unknown): Promise<{ segmentId: string | null; rule: SegmentRule }> {
  if (rawRule !== undefined && rawRule !== null) return { segmentId: segmentId ?? null, rule: parseSegmentRule(rawRule) };
  if (!segmentId) throw Errors.validation('セグメントを指定してください');
  const seg = await ctx.trx.selectFrom('segments').select(['id', 'rule']).where('id', '=', segmentId).executeTakeFirst();
  if (!seg) throw Errors.notFound('セグメント', segmentId);
  return { segmentId: seg.id, rule: parseSegmentRule(seg.rule) };
}

async function assertTemplate(ctx: Ctx, templateId: string | null | undefined) {
  if (!templateId) return;
  const t = await ctx.trx.selectFrom('message_templates').select(['id', 'shop_id', 'status']).where('id', '=', templateId).executeTakeFirst();
  if (!t) throw Errors.notFound('テンプレート', templateId);
  assertShopAccess(ctx.actor, t.shop_id);
}

export async function listCampaigns(ctx: Ctx, input: { status?: string; cursor?: string; limit: number }) {
  requirePermission(ctx.actor, 'campaign.manage');
  let q = ctx.trx.selectFrom('campaigns').select(campaignColumns);
  const shops = accessibleShopIds(ctx.actor);
  if (shops) q = q.where((eb) => eb.or([eb('shop_id', 'is', null), ...(shops.length ? [eb('shop_id', 'in', shops)] : [])]));
  if (input.status) q = q.where('status', '=', input.status);
  const cursor = decodeCursor(input.cursor);
  if (cursor) q = q.where(sql<boolean>`(created_at, id) < (${cursor.v}::timestamptz, ${cursor.id}::uuid)`);
  const rows = await q.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(input.limit + 1).execute();
  const page = paginate(rows, input.limit, (r) => r.created_at);
  return { items: await Promise.all(page.items.map((c) => withStats(ctx, c))), nextCursor: page.nextCursor };
}

export async function getCampaign(ctx: Ctx, id: string) {
  requirePermission(ctx.actor, 'campaign.manage');
  return withStats(ctx, await loadCampaign(ctx, id));
}

export async function createCampaign(ctx: Ctx, input: CreateCampaignInput) {
  requirePermission(ctx.actor, 'campaign.manage');
  assertCampaignScope(ctx, input.shopId);
  const { segmentId, rule } = await resolveRule(ctx, input.segmentId, input.segmentRule);
  await assertTemplate(ctx, input.templateId);
  const row = await ctx.trx
    .insertInto('campaigns')
    .values({
      organization_id: ctx.actor.organizationId,
      shop_id: input.shopId ?? null,
      name: input.name,
      channel: input.channel,
      segment_id: segmentId,
      segment_rule: JSON.stringify(rule),
      template_id: input.templateId ?? null,
      body: input.body ?? null,
      status: 'draft',
      created_by: auditUserId(ctx.actor),
    })
    .returning(campaignColumns)
    .executeTakeFirstOrThrow();
  await audit(ctx, { action: 'campaign.create', resourceType: 'campaign', resourceId: row.id, shopId: row.shop_id, after: { ...input, segmentRule: rule } });
  return withStats(ctx, row);
}

export async function updateCampaign(ctx: Ctx, id: string, input: UpdateCampaignInput) {
  requirePermission(ctx.actor, 'campaign.manage');
  const before = await loadCampaign(ctx, id, true);
  if (before.status !== 'draft') throw Errors.business('CAMPAIGN_NOT_EDITABLE', '下書きのキャンペーンのみ編集できます', { status: before.status });
  if (input.shopId !== undefined) assertCampaignScope(ctx, input.shopId);
  let segmentId: string | null | undefined;
  let rule: SegmentRule | undefined;
  if (input.segmentRule !== undefined || input.segmentId !== undefined) {
    const r = await resolveRule(ctx, input.segmentId === undefined ? before.segment_id : input.segmentId, input.segmentRule);
    segmentId = r.segmentId;
    rule = r.rule;
  }
  if (input.templateId) await assertTemplate(ctx, input.templateId);
  const nextTemplate = input.templateId === undefined ? before.template_id : input.templateId;
  const nextBody = input.body === undefined ? before.body : input.body;
  if (!nextTemplate && !nextBody) throw Errors.validation('本文またはテンプレートを指定してください');
  const row = await ctx.trx
    .updateTable('campaigns')
    .set({
      name: input.name,
      shop_id: input.shopId,
      channel: input.channel,
      segment_id: segmentId,
      segment_rule: rule ? JSON.stringify(rule) : undefined,
      template_id: input.templateId,
      body: input.body,
      // content changed → approval must be given again
      approved_by: null,
      approved_at: null,
    })
    .where('id', '=', id)
    .returning(campaignColumns)
    .executeTakeFirstOrThrow();
  await audit(ctx, { action: 'campaign.update', resourceType: 'campaign', resourceId: id, shopId: row.shop_id, ...diff(before, row) });
  return withStats(ctx, row);
}

export async function deleteCampaign(ctx: Ctx, id: string) {
  requirePermission(ctx.actor, 'campaign.manage');
  const c = await loadCampaign(ctx, id, true);
  if (c.status !== 'draft') throw Errors.business('CAMPAIGN_NOT_EDITABLE', '下書きのキャンペーンのみ削除できます（配信予定はキャンセルしてください）');
  await ctx.trx.deleteFrom('campaigns').where('id', '=', id).execute();
  await audit(ctx, { action: 'campaign.delete', resourceType: 'campaign', resourceId: id, shopId: c.shop_id, before: c });
}

async function approvalRequired(ctx: Ctx): Promise<boolean> {
  const org = await ctx.trx.selectFrom('organizations').select('settings').where('id', '=', ctx.actor.organizationId).executeTakeFirst();
  const s = (org?.settings ?? {}) as { messaging?: { requireCampaignApproval?: boolean } };
  return s.messaging?.requireCampaignApproval === true;
}

/**
 * Approval: when the organization requires it (settings.messaging.requireCampaignApproval), the approver
 * must be a different staff member than the author, or an owner/manager. Otherwise anyone with campaign.manage.
 */
export async function approveCampaign(ctx: Ctx, id: string) {
  requirePermission(ctx.actor, 'campaign.manage');
  if (ctx.actor.kind !== 'staff') throw Errors.forbidden('スタッフのみ承認できます');
  const c = await loadCampaign(ctx, id, true);
  if (c.status !== 'draft') throw Errors.business('CAMPAIGN_NOT_EDITABLE', '下書きのキャンペーンのみ承認できます', { status: c.status });
  if ((await approvalRequired(ctx)) && c.created_by === ctx.actor.staffId && !['owner', 'manager'].includes(ctx.actor.roleKey)) {
    throw Errors.forbidden('作成者本人は承認できません（別のスタッフまたは店長・オーナーの承認が必要です）', 'APPROVAL_SELF_FORBIDDEN');
  }
  const row = await ctx.trx
    .updateTable('campaigns')
    .set({ approved_by: ctx.actor.staffId, approved_at: new Date() })
    .where('id', '=', id)
    .returning(campaignColumns)
    .executeTakeFirstOrThrow();
  await audit(ctx, { action: 'campaign.approve', resourceType: 'campaign', resourceId: id, shopId: c.shop_id });
  return withStats(ctx, row);
}

export async function scheduleCampaign(ctx: Ctx, id: string, input: { scheduledAt?: string }) {
  requirePermission(ctx.actor, 'campaign.manage');
  const c = await loadCampaign(ctx, id, true);
  if (c.status !== 'draft') throw Errors.business('CAMPAIGN_NOT_EDITABLE', '下書きのキャンペーンのみ配信予約できます', { status: c.status });
  const now = clock.now();
  const at = input.scheduledAt ? new Date(input.scheduledAt) : now;
  if (at.getTime() < now.getTime() - 5 * 60_000) throw Errors.validation('配信日時が過去です');
  if (at.getTime() > now.getTime() + 180 * 86_400_000) throw Errors.validation('配信日時は180日以内で指定してください');
  let approvedBy = c.approved_by;
  if (!approvedBy) {
    if (await approvalRequired(ctx)) throw Errors.business('CAMPAIGN_APPROVAL_REQUIRED', '配信前に承認が必要です');
    approvedBy = ctx.actor.kind === 'staff' ? ctx.actor.staffId : null;
  }
  // refresh the rule snapshot from the saved segment at scheduling time
  const { rule } = c.segment_id ? await resolveRule(ctx, c.segment_id, undefined) : { rule: parseSegmentRule(c.segment_rule) };
  const row = await ctx.trx
    .updateTable('campaigns')
    .set({ status: 'scheduled', scheduled_at: at, segment_rule: JSON.stringify(rule), approved_by: approvedBy, approved_at: c.approved_at ?? new Date() })
    .where('id', '=', id)
    .returning(campaignColumns)
    .executeTakeFirstOrThrow();
  await enqueue(ctx, { type: 'campaign.run', payload: { campaignId: id }, runAt: at, dedupeKey: `campaign:${id}:run` });
  await audit(ctx, { action: 'campaign.schedule', resourceType: 'campaign', resourceId: id, shopId: c.shop_id, after: { scheduledAt: at.toISOString() } });
  return withStats(ctx, row);
}

export async function cancelCampaign(ctx: Ctx, id: string) {
  requirePermission(ctx.actor, 'campaign.manage');
  const c = await loadCampaign(ctx, id, true);
  if (!['draft', 'scheduled', 'running'].includes(c.status)) throw Errors.business('CAMPAIGN_NOT_CANCELLABLE', 'このキャンペーンはキャンセルできません', { status: c.status });
  await cancelJobs(ctx.trx, `campaign:${id}:run`);
  const cancelledMessages = await cancelQueuedMessages(ctx, { dedupeKeyPrefix: `campaign:${id}:` });
  const row = await ctx.trx.updateTable('campaigns').set({ status: 'cancelled', completed_at: new Date() }).where('id', '=', id).returning(campaignColumns).executeTakeFirstOrThrow();
  await audit(ctx, { action: 'campaign.cancel', resourceType: 'campaign', resourceId: id, shopId: c.shop_id, metadata: { cancelledMessages } });
  return { ...(await withStats(ctx, row)), cancelledMessages };
}

// ---------------------------------------------------------------- jobs

registerJob<{ campaignId: string }>('campaign.run', async ({ campaignId }, jc) => {
  const camp = await jc.tx(async (ctx) => {
    const c = await ctx.trx.selectFrom('campaigns').select(campaignColumns).where('id', '=', campaignId).forUpdate().executeTakeFirst();
    if (!c || c.status !== 'scheduled') return null;
    await ctx.trx.updateTable('campaigns').set({ status: 'running', started_at: new Date() }).where('id', '=', campaignId).execute();
    return c;
  });
  if (!camp) return;
  const rule = parseSegmentRule(camp.segment_rule);
  let afterId: string | null = null;
  let targets = 0;
  // snapshot the segment into messages in batches (dedupe makes a re-run idempotent)
  for (;;) {
    const batch: { done: boolean; lastId: string | null } = await jc.tx(async (ctx) => {
      const status = await ctx.trx.selectFrom('campaigns').select('status').where('id', '=', campaignId).executeTakeFirst();
      if (status?.status !== 'running') return { done: true, lastId: null };
      const rows = await segmentCustomerIds(ctx, rule, { shopId: camp.shop_id, afterId, limit: SNAPSHOT_BATCH });
      if (rows.length) {
        const payload: OutboundPayload = { templateKey: null, vars: {}, channelPreference: camp.channel as OutboundPayload['channelPreference'] };
        await ctx.trx
          .insertInto('messages')
          .values(
            rows.map((r) => ({
              organization_id: ctx.actor.organizationId,
              shop_id: camp.shop_id ?? r.primary_shop_id,
              customer_id: r.id,
              channel: camp.channel,
              direction: 'outbound',
              category: 'marketing',
              message_type: 'text',
              body: camp.body,
              payload: JSON.stringify(payload),
              template_id: camp.template_id,
              campaign_id: campaignId,
              status: 'queued',
              dedupe_key: `campaign:${campaignId}:${r.id}`,
            })),
          )
          .onConflict((oc) => oc.columns(['organization_id', 'dedupe_key']).where('dedupe_key', 'is not', null).doNothing())
          .execute();
      }
      targets += rows.length;
      return { done: rows.length < SNAPSHOT_BATCH, lastId: rows.at(-1)?.id ?? null };
    });
    if (batch.done) break;
    afterId = batch.lastId;
  }
  await jc.tx(async (ctx) => {
    const total = await ctx.trx.selectFrom('messages').select(sql<number>`count(*)::int`.as('n')).where('campaign_id', '=', campaignId).executeTakeFirstOrThrow();
    await ctx.trx
      .updateTable('campaigns')
      .set({ stats: JSON.stringify({ ...(await liveStats(ctx, campaignId)), targets: Math.max(targets, Number(total.n)) }) })
      .where('id', '=', campaignId)
      .execute();
    await enqueue(ctx, { type: 'campaign.dispatch', payload: { campaignId }, dedupeKey: `campaign-dispatch:${campaignId}` });
  });
});

registerJob<{ campaignId: string }>('campaign.dispatch', async ({ campaignId }, jc) => {
  let afterId: string | null = null;
  for (;;) {
    const res: { done: boolean; lastId: string | null } = await jc.tx(async (ctx) => {
      const camp = await ctx.trx.selectFrom('campaigns').select(['status']).where('id', '=', campaignId).executeTakeFirst();
      if (camp?.status !== 'running') return { done: true, lastId: null };
      let q = ctx.trx.selectFrom('messages').selectAll().where('campaign_id', '=', campaignId).where('status', '=', 'queued');
      if (afterId) q = q.where('id', '>', afterId);
      const msgs = await q.orderBy('id').limit(MULTICAST_LIMIT).forUpdate().skipLocked().execute();
      const now = clock.now();
      const groups = new Map<string, { lineChannelId: string; ids: string[] }>();
      for (const msg of msgs) {
        const prep = await prepareDelivery(ctx, msg, now);
        if (prep.kind === 'skip') {
          await markSkipped(ctx, msg, prep.reason, prep.channel);
        } else if (prep.kind === 'defer') {
          await ctx.trx.updateTable('messages').set({ scheduled_at: prep.until, next_attempt_at: prep.until }).where('id', '=', msg.id).execute();
          await enqueueDelivery(ctx, msg.id, prep.until, `:at:${prep.until.getTime()}`);
        } else if (prep.kind === 'send' && prep.channel === 'line' && prep.line) {
          // identical LINE texts on the same channel are multicast together
          await ctx.trx
            .updateTable('messages')
            .set({ status: 'sending', attempts: msg.attempts + 1, channel: 'line', recipient: prep.recipient, line_channel_id: prep.line.id, body: prep.body, template_id: prep.templateId })
            .where('id', '=', msg.id)
            .execute();
          const key = `${prep.line.id}\u0000${prep.body}`;
          const g = groups.get(key) ?? { lineChannelId: prep.line.id, ids: [] };
          g.ids.push(msg.id);
          groups.set(key, g);
        } else {
          // e-mail / SMS / failures are handled by the regular per-message pipeline
          await enqueueDelivery(ctx, msg.id);
        }
      }
      for (const g of groups.values()) {
        // personalised texts end up alone in their group → a push (retry key = message id) is equivalent
        if (g.ids.length === 1) await enqueueDelivery(ctx, g.ids[0]!);
        else await enqueue(ctx, { type: 'line.multicast', payload: { lineChannelId: g.lineChannelId, messageIds: g.ids, retryKey: randomUUID() } });
      }
      return { done: msgs.length < MULTICAST_LIMIT, lastId: msgs.at(-1)?.id ?? null };
    });
    if (res.done) break;
    afterId = res.lastId;
  }
  await jc.tx((ctx) => enqueue(ctx, { type: 'campaign.stats', payload: { campaignId }, dedupeKey: `campaign-stats:${campaignId}` }));
});

/** Refresh stored stats; mark completed once no message is pending */
registerJob<{ campaignId: string }>('campaign.stats', async ({ campaignId }, jc) => {
  await jc.tx(async (ctx) => {
    const c = await ctx.trx.selectFrom('campaigns').select(['status', 'stats']).where('id', '=', campaignId).forUpdate().executeTakeFirst();
    if (!c || !['running', 'completed'].includes(c.status)) return;
    const stats = await liveStats(ctx, campaignId, (c.stats as Partial<CampaignStats>)?.targets);
    const done = stats.queued === 0;
    await ctx.trx
      .updateTable('campaigns')
      .set({ stats: JSON.stringify(stats), ...(done && c.status === 'running' ? { status: 'completed', completed_at: new Date() } : {}) })
      .where('id', '=', campaignId)
      .execute();
    if (!done) {
      // deferred (quiet hours) or retrying messages: check again later
      await enqueue(ctx, { type: 'campaign.stats', payload: { campaignId }, runAt: new Date(Date.now() + 10 * 60_000), dedupeKey: `campaign-stats-later:${campaignId}` });
    }
  });
});
