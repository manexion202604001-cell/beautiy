import { createHash } from 'node:crypto';
import type { Ctx } from '../auth/actor.js';
import type { Tx } from '../db/tenant.js';

/**
 * Feature flags (要件 16: 段階リリース).
 * Resolution order: organization override row → global default row (organization_id NULL) → defaultValue.
 * rollout (global rows only): { percentage: 0-100 } enables the flag for a stable hash bucket of organizations.
 * Results are cached per process for 30s; writes through the ops API invalidate the local cache.
 */
export interface FlagRollout {
  percentage?: number;
}

interface CacheEntry {
  value: boolean;
  expiresAt: number;
}

const TTL_MS = 30_000;
const cache = new Map<string, CacheEntry>();

export function clearFeatureFlagCache(organizationId?: string): void {
  if (!organizationId) {
    cache.clear();
    return;
  }
  for (const key of cache.keys()) if (key.startsWith(`${organizationId}:`)) cache.delete(key);
}

/** Stable 0-99 bucket for (organization, flag) — used for percentage rollouts */
export function rolloutBucket(organizationId: string, key: string): number {
  return createHash('sha256').update(`${organizationId}:${key}`).digest().readUInt32BE(0) % 100;
}

export function evaluateFlag(
  organizationId: string,
  key: string,
  rows: { organization_id: string | null; enabled: boolean; rollout: unknown }[],
  defaultValue: boolean,
): boolean {
  const org = rows.find((r) => r.organization_id === organizationId);
  if (org) return org.enabled;
  const global = rows.find((r) => r.organization_id === null);
  if (!global) return defaultValue;
  if (!global.enabled) return false;
  const pct = (global.rollout as FlagRollout | null)?.percentage;
  if (typeof pct === 'number' && pct < 100) return rolloutBucket(organizationId, key) < Math.max(0, pct);
  return true;
}

export async function isFeatureEnabled(
  ctx: Pick<Ctx, 'trx'> & { actor: { organizationId: string } },
  key: string,
  defaultValue = false,
): Promise<boolean> {
  return isFeatureEnabledFor(ctx.trx, ctx.actor.organizationId, key, defaultValue);
}

/** Variant for system code holding a (possibly RLS-bypassing) transaction and an explicit organization */
export async function isFeatureEnabledFor(trx: Tx, organizationId: string, key: string, defaultValue = false): Promise<boolean> {
  const cacheKey = `${organizationId}:${key}`;
  const hit = cache.get(cacheKey);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  const rows = await trx
    .selectFrom('feature_flags')
    .select(['organization_id', 'enabled', 'rollout'])
    .where('key', '=', key)
    .where((eb) => eb.or([eb('organization_id', '=', organizationId), eb('organization_id', 'is', null)]))
    .execute();
  const value = evaluateFlag(organizationId, key, rows, defaultValue);
  cache.set(cacheKey, { value, expiresAt: Date.now() + TTL_MS });
  return value;
}
