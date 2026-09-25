'use server';
import { PII_DEFAULT_ROLES, type RoleName } from '@salonos/core';
import { prisma } from '@/lib/server/db';
import { requireStaff } from '@/lib/server/session';
import { audit } from '@/lib/server/audit';
import { AppError, runAction, type ActionResult } from '@/lib/server/errors';

export async function setPiiAccessAction(fd: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await requireStaff('settings.permissions');
    const m = await prisma.membership.findFirst({ where: { id: String(fd.get('id') ?? ''), organizationId: ctx.org.id } });
    if (!m) throw new AppError('スタッフが見つかりません');
    if (PII_DEFAULT_ROLES.includes(m.role as RoleName)) throw new AppError('この役割は常に個人情報を閲覧できます。制限するには役割を変更してください。');
    const allow = fd.get('allow') === '1';
    if (m.canViewPII === allow) return { ok: true };
    await prisma.membership.update({ where: { id: m.id }, data: { canViewPII: allow } });
    await audit(ctx, 'permission.pii_changed', 'Membership', m.id, { userId: m.userId, canViewPII: allow });
    return { ok: true, message: allow ? '閲覧を許可しました' : '閲覧許可を取り消しました' };
  });
}

export async function revokeUnlockAction(fd: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await requireStaff('settings.permissions');
    const u = await prisma.piiUnlock.findFirst({ where: { id: String(fd.get('id') ?? ''), organizationId: ctx.org.id } });
    if (!u) throw new AppError('一時解除が見つかりません（既に失効した可能性があります）');
    await prisma.piiUnlock.delete({ where: { id: u.id } });
    await audit(ctx, 'permission.pii_unlock_revoked', 'User', u.userId, { unlockId: u.id, reason: u.reason, expiresAt: u.expiresAt.toISOString() });
  });
}
