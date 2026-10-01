import { requirePermission, type Ctx } from '../../auth/actor.js';
import { audit } from '../../lib/audit.js';
import { Errors } from '../../lib/errors.js';
import { clearFeatureFlagCache, evaluateFlag } from '../../lib/feature-flags.js';

/**
 * Feature flag administration (要件 16: 段階リリース). Tenants manage org-level overrides only;
 * global defaults (organization_id NULL, seeded by migration) are read-only here.
 */
type FlagRow = { id: string; organization_id: string | null; key: string; enabled: boolean; rollout: unknown; description: string | null; updated_at: Date };

async function loadRows(ctx: Ctx, key?: string): Promise<FlagRow[]> {
  let q = ctx.trx
    .selectFrom('feature_flags')
    .select(['id', 'organization_id', 'key', 'enabled', 'rollout', 'description', 'updated_at'])
    .where((eb) => eb.or([eb('organization_id', 'is', null), eb('organization_id', '=', ctx.actor.organizationId)]));
  if (key) q = q.where('key', '=', key);
  return q.orderBy('key').execute();
}

function present(ctx: Ctx, key: string, rows: FlagRow[]) {
  const global = rows.find((r) => r.key === key && r.organization_id === null) ?? null;
  const override = rows.find((r) => r.key === key && r.organization_id === ctx.actor.organizationId) ?? null;
  const relevant = rows.filter((r) => r.key === key);
  return {
    key,
    description: global?.description ?? override?.description ?? null,
    enabled: evaluateFlag(ctx.actor.organizationId, key, relevant, false),
    global: global ? { enabled: global.enabled, rollout: global.rollout } : null,
    override: override ? { enabled: override.enabled, rollout: override.rollout, updatedAt: override.updated_at } : null,
  };
}

export async function listFlags(ctx: Ctx) {
  requirePermission(ctx.actor, 'ops.manage');
  const rows = await loadRows(ctx);
  return [...new Set(rows.map((r) => r.key))].map((k) => present(ctx, k, rows));
}

export async function setFlag(ctx: Ctx, key: string, input: { enabled: boolean; rollout?: { percentage?: number } }) {
  requirePermission(ctx.actor, 'ops.manage');
  const rows = await loadRows(ctx, key);
  if (!rows.some((r) => r.organization_id === null)) throw Errors.notFound('機能フラグ', key);
  const existing = rows.find((r) => r.organization_id === ctx.actor.organizationId);
  const before = present(ctx, key, rows);
  if (existing) {
    await ctx.trx
      .updateTable('feature_flags')
      .set({ enabled: input.enabled, rollout: JSON.stringify(input.rollout ?? {}) })
      .where('id', '=', existing.id)
      .execute();
  } else {
    await ctx.trx
      .insertInto('feature_flags')
      .values({ organization_id: ctx.actor.organizationId, key, enabled: input.enabled, rollout: JSON.stringify(input.rollout ?? {}) })
      .execute();
  }
  clearFeatureFlagCache(ctx.actor.organizationId);
  const after = present(ctx, key, await loadRows(ctx, key));
  await audit(ctx, { action: 'feature_flag.update', resourceType: 'feature_flag', resourceId: key, before: { enabled: before.enabled, override: before.override }, after: { enabled: after.enabled, override: after.override } });
  return after;
}

/** Remove the org override (fall back to the global default) */
export async function clearFlag(ctx: Ctx, key: string) {
  requirePermission(ctx.actor, 'ops.manage');
  const rows = await loadRows(ctx, key);
  if (!rows.some((r) => r.organization_id === null)) throw Errors.notFound('機能フラグ', key);
  const before = present(ctx, key, rows);
  await ctx.trx.deleteFrom('feature_flags').where('key', '=', key).where('organization_id', '=', ctx.actor.organizationId).execute();
  clearFeatureFlagCache(ctx.actor.organizationId);
  const after = present(ctx, key, await loadRows(ctx, key));
  await audit(ctx, { action: 'feature_flag.reset', resourceType: 'feature_flag', resourceId: key, before: { enabled: before.enabled, override: before.override }, after: { enabled: after.enabled } });
  return after;
}
