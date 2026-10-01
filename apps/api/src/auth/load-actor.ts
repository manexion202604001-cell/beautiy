import { withTenant } from '../db/tenant.js';
import type { StaffActor } from './actor.js';

const cache = new Map<string, { actor: StaffActor | null; expires: number }>();
const TTL_MS = 15_000;

/** Load the effective staff actor (role permissions + active shop assignments). Cached briefly. */
export async function loadStaffActor(organizationId: string, staffId: string, userId: string): Promise<StaffActor | null> {
  const cacheKey = `${organizationId}:${staffId}:${userId}`;
  const hit = cache.get(cacheKey);
  if (hit && hit.expires > Date.now()) return hit.actor;

  const actor = await withTenant(organizationId, async (trx) => {
    const staff = await trx
      .selectFrom('staffs')
      .innerJoin('roles', 'roles.id', 'staffs.role_id')
      .innerJoin('users', 'users.id', 'staffs.user_id')
      .innerJoin('organizations', 'organizations.id', 'staffs.organization_id')
      .select([
        'staffs.id',
        'staffs.display_name',
        'staffs.status',
        'staffs.role_id',
        'roles.key as role_key',
        'users.status as user_status',
        'organizations.status as org_status',
      ])
      .where('staffs.id', '=', staffId)
      .where('staffs.user_id', '=', userId)
      .where('staffs.deleted_at', 'is', null)
      .executeTakeFirst();
    if (!staff || staff.status !== 'active' || staff.user_status !== 'active') return null;
    if (!['active', 'trial'].includes(staff.org_status)) return null;

    const [perms, shops] = await Promise.all([
      trx.selectFrom('role_permissions').select('permission_key').where('role_id', '=', staff.role_id).execute(),
      trx
        .selectFrom('staff_shop_assignments')
        .select('shop_id')
        .where('staff_id', '=', staffId)
        .where('ended_on', 'is', null)
        .execute(),
    ]);
    const permissions = new Set(perms.map((p) => p.permission_key));
    return {
      kind: 'staff',
      organizationId,
      userId,
      staffId,
      displayName: staff.display_name,
      roleKey: staff.role_key,
      permissions,
      shopIds: shops.map((s) => s.shop_id),
      allShops: permissions.has('scope.all_shops'),
    } satisfies StaffActor;
  });

  cache.set(cacheKey, { actor, expires: Date.now() + TTL_MS });
  return actor;
}

export function invalidateActorCache(staffId?: string): void {
  if (!staffId) {
    cache.clear();
    return;
  }
  for (const key of cache.keys()) if (key.includes(`:${staffId}:`)) cache.delete(key);
}
