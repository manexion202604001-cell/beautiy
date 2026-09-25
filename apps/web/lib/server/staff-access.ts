// Who may manage (edit / deactivate / edit the public profile of) which staff member.
// Kept outside the server-action files so the rule is shared and integration-testable.
import { outranks, type RoleName } from '@salonos/core';
import { prisma } from './db';
import { ForbiddenError, NotFoundError } from './errors';

export interface StaffActor {
  orgId: string;
  role: RoleName;
  membershipId: string;
  /** Shops the actor can access (ctx.shops). */
  shopIds: string[];
}

export const staffActorOf = (ctx: { org: { id: string }; role: RoleName; membership: { id: string }; shops: { id: string }[] }): StaffActor =>
  ({ orgId: ctx.org.id, role: ctx.role, membershipId: ctx.membership.id, shopIds: ctx.shops.map((s) => s.id) });

/** OWNER manages everyone; otherwise only strictly lower roles. */
export function canManageRole(actor: RoleName, target: RoleName) { return actor === 'OWNER' || outranks(actor, target); }

export const isOrgWide = (role: RoleName) => role === 'OWNER' || role === 'DIRECTOR';

/**
 * Load a membership of the actor's org that the actor may manage, or throw.
 * - `allowSelf`: the actor's own membership is always allowed (e.g. own public profile).
 * - Rank: OWNER manages everyone, others only strictly lower roles.
 * - Shops: actors below OWNER/DIRECTOR may only manage staff assigned to at least one
 *   of their own shops (a manager of shop A cannot touch shop B's staff).
 */
export async function manageableMember(actor: StaffActor, membershipId: string, opts: { allowSelf?: boolean; message?: string } = {}) {
  const m = await prisma.membership.findFirst({ where: { id: membershipId, organizationId: actor.orgId }, include: { shops: true } });
  if (!m) throw new NotFoundError('スタッフが見つかりません');
  if (m.id === actor.membershipId && opts.allowSelf) return m;
  const denied = new ForbiddenError(opts.message ?? 'このスタッフを編集する権限がありません');
  if (!canManageRole(actor.role, m.role as RoleName)) throw denied;
  if (!isOrgWide(actor.role) && !m.shops.some((s) => actor.shopIds.includes(s.shopId))) throw denied;
  return m;
}
