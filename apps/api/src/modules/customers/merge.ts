import { sql } from 'kysely';
import { auditUserId, requirePermission, type Ctx } from '../../auth/actor.js';
import { audit } from '../../lib/audit.js';
import { Errors } from '../../lib/errors.js';
import { emit } from '../../lib/events.js';
import { assertCustomerAccess } from './access.js';
import { recomputeCustomerStats } from './stats.js';

/**
 * Customer merge (要件 4.1): relink every customer-owned record from source to the canonical target,
 * keep a full log (moved row ids + snapshots) and allow undo while no later merge depends on it.
 */
const RELINK_TABLES = [
  'appointments',
  'kartes',
  'karte_assets',
  'form_responses',
  'transactions',
  'point_ledger',
  'messages',
  'reviews',
  'review_requests',
  'orders',
  'customer_identities',
  'customer_memos',
  'coupon_redemptions',
  'access_tokens',
  'referral_links',
  'referral_events',
  'automation_runs',
] as const;

/** Profile fields copied from source when empty on target */
const FILL_FIELDS = [
  'phone',
  'phone_normalized',
  'email',
  'birthday',
  'gender',
  'postal_code',
  'address',
  'occupation',
  'acquisition_source',
  'customer_number',
  'primary_staff_id',
  'primary_shop_id',
] as const;

type Relinked = {
  tables: Record<string, string[]>;
  tagsMovedFromSource: string[];
  tagsAddedToTarget: string[];
  relationsMoved: string[];
  relationsEnded: string[];
  channelPrefs: { source: unknown[]; target: unknown[] };
  filledFields: string[];
};

async function pointBalance(ctx: Ctx, customerId: string) {
  const r = await ctx.trx
    .selectFrom('point_ledger')
    .select(sql<number>`coalesce(sum(delta), 0)::int`.as('balance'))
    .where('customer_id', '=', customerId)
    .executeTakeFirstOrThrow();
  return r.balance;
}

export async function mergeCustomers(ctx: Ctx, targetId: string, sourceId: string, opts: { reason?: string; matchRule?: string } = {}) {
  requirePermission(ctx.actor, 'customer.merge');
  if (targetId === sourceId) throw Errors.validation('同じ顧客は統合できません');
  await assertCustomerAccess(ctx, targetId);
  await assertCustomerAccess(ctx, sourceId);

  // lock both rows in a stable order to avoid deadlocks between concurrent merges
  const [first, second] = [targetId, sourceId].sort();
  await ctx.trx.selectFrom('customers').select('id').where('id', 'in', [first!, second!]).orderBy('id').forUpdate().execute();

  const target = await ctx.trx.selectFrom('customers').selectAll().where('id', '=', targetId).executeTakeFirstOrThrow();
  const source = await ctx.trx.selectFrom('customers').selectAll().where('id', '=', sourceId).executeTakeFirstOrThrow();

  const relinked: Relinked = {
    tables: {},
    tagsMovedFromSource: [],
    tagsAddedToTarget: [],
    relationsMoved: [],
    relationsEnded: [],
    channelPrefs: { source: [], target: [] },
    filledFields: [],
  };

  for (const table of RELINK_TABLES) {
    const res = await sql<{ id: string }>`UPDATE ${sql.table(table)} SET customer_id = ${targetId} WHERE customer_id = ${sourceId} RETURNING id`.execute(ctx.trx);
    if (res.rows.length) relinked.tables[table] = res.rows.map((r) => r.id);
  }

  // tags: union
  const sourceTags = await ctx.trx.selectFrom('customer_tags').select('tag_id').where('customer_id', '=', sourceId).execute();
  const targetTags = new Set((await ctx.trx.selectFrom('customer_tags').select('tag_id').where('customer_id', '=', targetId).execute()).map((t) => t.tag_id));
  relinked.tagsMovedFromSource = sourceTags.map((t) => t.tag_id);
  relinked.tagsAddedToTarget = relinked.tagsMovedFromSource.filter((t) => !targetTags.has(t));
  if (relinked.tagsAddedToTarget.length) {
    await ctx.trx
      .insertInto('customer_tags')
      .values(relinked.tagsAddedToTarget.map((tagId) => ({ customer_id: targetId, tag_id: tagId, organization_id: ctx.actor.organizationId })))
      .execute();
  }
  await ctx.trx.deleteFrom('customer_tags').where('customer_id', '=', sourceId).execute();

  // shop relations: move non-conflicting active ones, end the rest
  const srcRelations = await ctx.trx.selectFrom('customer_shop_relations').selectAll().where('customer_id', '=', sourceId).where('ended_at', 'is', null).execute();
  const tgtRelations = await ctx.trx.selectFrom('customer_shop_relations').selectAll().where('customer_id', '=', targetId).where('ended_at', 'is', null).execute();
  for (const r of srcRelations) {
    const conflict = tgtRelations.some((t) => t.shop_id === r.shop_id && t.relation_type === r.relation_type && (t.staff_id ?? '') === (r.staff_id ?? ''));
    if (conflict) {
      await ctx.trx.updateTable('customer_shop_relations').set({ ended_at: new Date(), end_reason: 'merged' }).where('id', '=', r.id).execute();
      relinked.relationsEnded.push(r.id);
    } else {
      await ctx.trx.updateTable('customer_shop_relations').set({ customer_id: targetId }).where('id', '=', r.id).execute();
      relinked.relationsMoved.push(r.id);
    }
  }

  // channel preferences: opt-out wins (never re-enable messaging a person refused)
  const srcPrefs = await ctx.trx.selectFrom('customer_channel_preferences').selectAll().where('customer_id', '=', sourceId).execute();
  const tgtPrefs = await ctx.trx.selectFrom('customer_channel_preferences').selectAll().where('customer_id', '=', targetId).execute();
  relinked.channelPrefs = { source: srcPrefs, target: tgtPrefs };
  for (const p of srcPrefs) {
    const t = tgtPrefs.find((x) => x.channel === p.channel);
    await ctx.trx
      .insertInto('customer_channel_preferences')
      .values({
        customer_id: targetId,
        organization_id: ctx.actor.organizationId,
        channel: p.channel,
        marketing_allowed: t ? t.marketing_allowed && p.marketing_allowed : p.marketing_allowed,
        transactional_allowed: t ? t.transactional_allowed && p.transactional_allowed : p.transactional_allowed,
        source: 'merge',
      })
      .onConflict((oc) =>
        oc.columns(['customer_id', 'channel']).doUpdateSet({
          marketing_allowed: sql<boolean>`customer_channel_preferences.marketing_allowed AND excluded.marketing_allowed`,
          transactional_allowed: sql<boolean>`customer_channel_preferences.transactional_allowed AND excluded.transactional_allowed`,
          source: 'merge',
        }),
      )
      .execute();
  }
  await ctx.trx.deleteFrom('customer_channel_preferences').where('customer_id', '=', sourceId).execute();
  await ctx.trx.deleteFrom('customer_scores').where('customer_id', '=', sourceId).execute();

  // fill empty profile fields on target
  const fill: Record<string, unknown> = {};
  for (const f of FILL_FIELDS) {
    if ((target[f] === null || target[f] === '') && source[f] !== null && source[f] !== '') {
      fill[f] = source[f];
      relinked.filledFields.push(f);
    }
  }
  if (!target.marketing_opt_in || !source.marketing_opt_in) fill.marketing_opt_in = false;
  // free the unique customer_number on source before moving it
  if (fill.customer_number) await ctx.trx.updateTable('customers').set({ customer_number: null }).where('id', '=', sourceId).execute();
  await ctx.trx
    .updateTable('customers')
    .set({ ...fill, point_balance: await pointBalance(ctx, targetId), updated_by: auditUserId(ctx.actor) })
    .where('id', '=', targetId)
    .execute();
  await ctx.trx
    .updateTable('customers')
    .set({ status: 'merged', merged_into_id: targetId, point_balance: 0, updated_by: auditUserId(ctx.actor) })
    .where('id', '=', sourceId)
    .execute();

  await recomputeCustomerStats(ctx, targetId);

  const log = await ctx.trx
    .insertInto('customer_merge_logs')
    .values({
      organization_id: ctx.actor.organizationId,
      source_customer_id: sourceId,
      target_customer_id: targetId,
      reason: opts.reason ?? null,
      match_rule: opts.matchRule ?? 'manual',
      relinked: JSON.stringify(relinked),
      source_snapshot: JSON.stringify(source),
      target_snapshot: JSON.stringify(target),
      merged_by: auditUserId(ctx.actor),
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  await audit(ctx, {
    action: 'customer.merge',
    resourceType: 'customer',
    resourceId: targetId,
    before: { source: { id: sourceId }, target: { id: targetId } },
    after: { mergeLogId: log.id, moved: Object.fromEntries(Object.entries(relinked.tables).map(([k, v]) => [k, v.length])) },
    metadata: { reason: opts.reason, matchRule: opts.matchRule ?? 'manual' },
  });
  await emit(ctx, { type: 'customer.merged', aggregateType: 'customer', aggregateId: targetId, payload: { sourceId, targetId, mergeLogId: log.id } });
  return { mergeLogId: log.id, targetId, sourceId, moved: Object.fromEntries(Object.entries(relinked.tables).map(([k, v]) => [k, v.length])) };
}

export async function undoMerge(ctx: Ctx, mergeLogId: string) {
  requirePermission(ctx.actor, 'customer.merge');
  const log = await ctx.trx.selectFrom('customer_merge_logs').selectAll().where('id', '=', mergeLogId).forUpdate().executeTakeFirst();
  if (!log) throw Errors.notFound('統合履歴', mergeLogId);
  if (log.undone_at) throw Errors.business('MERGE_ALREADY_UNDONE', 'この統合は既に取り消されています');
  const later = await ctx.trx
    .selectFrom('customer_merge_logs')
    .select('id')
    .where('id', '!=', log.id)
    .where('merged_at', '>=', log.merged_at)
    .where('undone_at', 'is', null)
    .where((eb) =>
      eb.or([
        eb('source_customer_id', 'in', [log.source_customer_id, log.target_customer_id]),
        eb('target_customer_id', 'in', [log.source_customer_id, log.target_customer_id]),
      ]),
    )
    .executeTakeFirst();
  if (later) throw Errors.business('MERGE_UNDO_BLOCKED', 'この統合の後に関連する統合が行われているため取り消せません。後の統合から取り消してください');

  const relinked = log.relinked as unknown as Relinked;
  const sourceId = log.source_customer_id;
  const targetId = log.target_customer_id;
  const targetSnapshot = log.target_snapshot as Record<string, unknown>;
  const sourceSnapshot = log.source_snapshot as Record<string, unknown>;

  for (const [table, ids] of Object.entries(relinked.tables)) {
    if (!(RELINK_TABLES as readonly string[]).includes(table) || !ids.length) continue;
    await sql`UPDATE ${sql.table(table)} SET customer_id = ${sourceId} WHERE id = ANY(${ids}::uuid[]) AND customer_id = ${targetId}`.execute(ctx.trx);
  }
  if (relinked.tagsAddedToTarget.length) {
    await ctx.trx.deleteFrom('customer_tags').where('customer_id', '=', targetId).where('tag_id', 'in', relinked.tagsAddedToTarget).execute();
  }
  if (relinked.tagsMovedFromSource.length) {
    await ctx.trx
      .insertInto('customer_tags')
      .values(relinked.tagsMovedFromSource.map((tagId) => ({ customer_id: sourceId, tag_id: tagId, organization_id: ctx.actor.organizationId })))
      .onConflict((oc) => oc.doNothing())
      .execute();
  }
  if (relinked.relationsMoved.length) {
    await ctx.trx.updateTable('customer_shop_relations').set({ customer_id: sourceId }).where('id', 'in', relinked.relationsMoved).execute();
  }
  if (relinked.relationsEnded.length) {
    await ctx.trx.updateTable('customer_shop_relations').set({ ended_at: null, end_reason: null }).where('id', 'in', relinked.relationsEnded).execute();
  }
  // restore channel preferences snapshots
  await ctx.trx.deleteFrom('customer_channel_preferences').where('customer_id', 'in', [sourceId, targetId]).execute();
  const prefs = [...relinked.channelPrefs.source, ...relinked.channelPrefs.target] as {
    customer_id: string;
    channel: string;
    marketing_allowed: boolean;
    transactional_allowed: boolean;
    source: string | null;
  }[];
  if (prefs.length) {
    await ctx.trx
      .insertInto('customer_channel_preferences')
      .values(prefs.map((p) => ({ customer_id: p.customer_id, organization_id: ctx.actor.organizationId, channel: p.channel, marketing_allowed: p.marketing_allowed, transactional_allowed: p.transactional_allowed, source: p.source })))
      .execute();
  }
  const restoreTarget: Record<string, unknown> = { marketing_opt_in: targetSnapshot.marketing_opt_in };
  for (const f of relinked.filledFields) restoreTarget[f] = targetSnapshot[f] ?? null;
  await ctx.trx.updateTable('customers').set(restoreTarget).where('id', '=', targetId).execute();
  await ctx.trx
    .updateTable('customers')
    .set({ status: 'active', merged_into_id: null, customer_number: (sourceSnapshot.customer_number as string | null) ?? null })
    .where('id', '=', sourceId)
    .execute();
  for (const id of [sourceId, targetId]) {
    await ctx.trx.updateTable('customers').set({ point_balance: await pointBalance(ctx, id) }).where('id', '=', id).execute();
    await recomputeCustomerStats(ctx, id);
  }
  await ctx.trx
    .updateTable('customer_merge_logs')
    .set({ undone_at: new Date(), undone_by: auditUserId(ctx.actor) })
    .where('id', '=', mergeLogId)
    .execute();
  await audit(ctx, { action: 'customer.merge_undo', resourceType: 'customer', resourceId: targetId, metadata: { mergeLogId, sourceId } });
  await emit(ctx, { type: 'customer.merge_undone', aggregateType: 'customer', aggregateId: targetId, payload: { sourceId, targetId, mergeLogId } });
  return { mergeLogId, sourceId, targetId };
}

export async function listMergeLogs(ctx: Ctx, customerId: string) {
  requirePermission(ctx.actor, 'customer.read');
  return ctx.trx
    .selectFrom('customer_merge_logs')
    .select(['id', 'source_customer_id', 'target_customer_id', 'reason', 'match_rule', 'merged_by', 'merged_at', 'undone_at', 'undone_by'])
    .where((eb) => eb.or([eb('source_customer_id', '=', customerId), eb('target_customer_id', '=', customerId)]))
    .orderBy('merged_at', 'desc')
    .execute();
}
