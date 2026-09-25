import type { Prisma } from '@salonos/db';
import { prisma, type Tx } from './db';
import { requestMeta, type StaffContext } from './session';

/**
 * Append-only audit trail. Required for every PII read/unlock/export,
 * permission changes, refunds/voids, merges and integration changes.
 */
export async function audit(
  ctx: Pick<StaffContext, 'org' | 'user'> | { orgId: string; userId?: string | null },
  action: string,
  resourceType: string,
  resourceId?: string | null,
  metadata?: Record<string, unknown>,
  tx?: Tx,
) {
  const organizationId = 'org' in ctx ? ctx.org.id : ctx.orgId;
  const userId = 'user' in ctx ? ctx.user.id : ctx.userId ?? null;
  let meta: { ip: string | null; userAgent: string | null } = { ip: null, userAgent: null };
  try { meta = await requestMeta(); } catch { /* outside request scope (jobs/tests) */ }
  await (tx ?? prisma).auditLog.create({
    data: {
      organizationId, userId, action, resourceType, resourceId: resourceId ?? null,
      metadata: (metadata ?? undefined) as Prisma.InputJsonValue | undefined, ip: meta.ip, userAgent: meta.userAgent,
    },
  });
}
