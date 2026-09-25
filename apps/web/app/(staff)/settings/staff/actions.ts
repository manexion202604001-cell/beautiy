'use server';
import { z } from 'zod';
import { ROLES, ROLE_LABEL, type RoleName } from '@salonos/core';
import { randomToken, sha256 } from '@salonos/core/crypto';
import { prisma } from '@/lib/server/db';
import { env } from '@/lib/server/env';
import { requireStaff, type StaffContext } from '@/lib/server/session';
import { audit } from '@/lib/server/audit';
import { canManageRole, manageableMember, staffActorOf } from '@/lib/server/staff-access';
import { AppError, ForbiddenError, runAction, type ActionResult } from '@/lib/server/errors';
import { bool } from '../_components/guard';
import type { Reveal } from '../_components/client';

const INVITE_DAYS = 7;

// Same rank rule as managing a member: OWNER any role, otherwise only strictly lower roles.
const canAssign = canManageRole;

async function assertNotLastOwner(orgId: string, membershipId: string) {
  const others = await prisma.membership.count({ where: { organizationId: orgId, role: 'OWNER', active: true, id: { not: membershipId }, user: { isActive: true } } });
  if (others === 0) throw new AppError('オーナーが1人もいなくなるため変更できません。先に別のスタッフをオーナーにしてください。');
}

/** Only shops the actor can see are changed; hidden assignments are preserved. */
async function resolveShopIds(ctx: StaffContext, requested: string[]) {
  const orgShops = await prisma.shop.findMany({ where: { organizationId: ctx.org.id }, select: { id: true } });
  const orgIds = new Set(orgShops.map((s) => s.id));
  const visible = new Set(ctx.role === 'OWNER' || ctx.role === 'DIRECTOR' ? orgIds : ctx.shops.map((s) => s.id));
  for (const id of requested) if (!visible.has(id)) throw new ForbiddenError('この店舗へのアクセス権がありません');
  return { visible, requested: [...new Set(requested)] };
}

const roleEnum = z.enum(ROLES);

const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().email('メールアドレスの形式が正しくありません'),
  name: z.string().trim().min(1, '氏名を入力してください').max(60),
  role: roleEnum,
});

export async function inviteStaffAction(_: ActionResult<Reveal> | null, fd: FormData): Promise<ActionResult<Reveal>> {
  return runAction<Reveal>(async () => {
    const ctx = await requireStaff('settings.staff');
    const input = inviteSchema.parse(Object.fromEntries(fd));
    if (!canAssign(ctx.role, input.role)) throw new ForbiddenError(`「${ROLE_LABEL[input.role]}」を付与する権限がありません`);
    const { requested } = await resolveShopIds(ctx, fd.getAll('shopIds').map(String));
    if (!requested.length && input.role !== 'OWNER' && input.role !== 'DIRECTOR') return { ok: false, error: '担当店舗を1つ以上選択してください' };
    const existing = await prisma.membership.findFirst({ where: { organizationId: ctx.org.id, active: true, user: { email: input.email } } });
    if (existing) return { ok: false, error: 'このメールアドレスのスタッフは既に登録されています' };
    const token = randomToken(24);
    const inv = await prisma.$transaction(async (tx) => {
      // replace older pending invitations for the same address
      await tx.invitation.deleteMany({ where: { organizationId: ctx.org.id, email: input.email, acceptedAt: null } });
      return tx.invitation.create({
        data: { organizationId: ctx.org.id, email: input.email, name: input.name, role: input.role, shopIds: requested, tokenHash: sha256(token), expiresAt: new Date(Date.now() + INVITE_DAYS * 86400000), createdById: ctx.user.id },
      });
    });
    await audit(ctx, 'staff.invited', 'Invitation', inv.id, { email: input.email, role: input.role, shopIds: requested });
    return { ok: true, data: { reveal: `${env.appUrl}/invite/${token}`, revealLabel: `${input.name} さんへの招待リンクを発行しました（有効期限 ${INVITE_DAYS}日）`, revealNote: 'このリンクを本人に安全な方法（LINE・メール等）で送ってください。リンクは再表示できません。紛失した場合は「再発行」してください。' } };
  });
}

export async function reissueInviteAction(_: ActionResult<Reveal> | null, fd: FormData): Promise<ActionResult<Reveal>> {
  return runAction<Reveal>(async () => {
    const ctx = await requireStaff('settings.staff');
    const inv = await prisma.invitation.findFirst({ where: { id: String(fd.get('id') ?? ''), organizationId: ctx.org.id, acceptedAt: null } });
    if (!inv) throw new AppError('招待が見つかりません');
    if (!canAssign(ctx.role, inv.role as RoleName)) throw new ForbiddenError();
    const token = randomToken(24);
    await prisma.invitation.update({ where: { id: inv.id }, data: { tokenHash: sha256(token), expiresAt: new Date(Date.now() + INVITE_DAYS * 86400000) } });
    await audit(ctx, 'staff.invite_reissued', 'Invitation', inv.id, { email: inv.email });
    return { ok: true, data: { reveal: `${env.appUrl}/invite/${token}`, revealLabel: '招待リンクを再発行しました（以前のリンクは無効になりました）' } };
  });
}

export async function cancelInviteAction(fd: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await requireStaff('settings.staff');
    const inv = await prisma.invitation.findFirst({ where: { id: String(fd.get('id') ?? ''), organizationId: ctx.org.id, acceptedAt: null } });
    if (!inv) throw new AppError('招待が見つかりません');
    await prisma.invitation.delete({ where: { id: inv.id } });
    await audit(ctx, 'staff.invite_cancelled', 'Invitation', inv.id, { email: inv.email });
  });
}

const updateSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().trim().min(1, '表示名を入力してください').max(40),
  role: roleEnum,
  nominationFee: z.coerce.number().int().min(0, '0以上').max(100000),
  sortOrder: z.coerce.number().int().min(-1000).max(1000),
});

export async function updateMemberAction(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await requireStaff('settings.staff');
    const input = updateSchema.parse(Object.fromEntries(fd));
    // Rank + shop scope (non-OWNER/DIRECTOR: target must share a shop with the actor); self allowed.
    const m = await manageableMember(staffActorOf(ctx), input.id, { allowSelf: true });
    const self = m.id === ctx.membership.id;
    const roleChanged = input.role !== m.role;
    if (roleChanged) {
      if (self) throw new AppError('自分自身の役割は変更できません');
      if (!canAssign(ctx.role, input.role)) throw new ForbiddenError(`「${ROLE_LABEL[input.role]}」を付与する権限がありません`);
      if (m.role === 'OWNER') await assertNotLastOwner(ctx.org.id, m.id);
    }
    const { visible, requested } = await resolveShopIds(ctx, fd.getAll('shopIds').map(String));
    const keepHidden = m.shops.filter((s) => !visible.has(s.shopId)).map((s) => s.shopId);
    const nextShops = [...new Set([...keepHidden, ...requested])];
    if (!nextShops.length && input.role !== 'OWNER' && input.role !== 'DIRECTOR') return { ok: false, error: '担当店舗を1つ以上選択してください' };
    const before = m.shops.map((s) => s.shopId).sort();
    await prisma.$transaction(async (tx) => {
      await tx.membership.update({ where: { id: m.id }, data: { displayName: input.displayName, role: input.role, bookable: bool(fd, 'bookable'), nominationFee: input.nominationFee, sortOrder: input.sortOrder } });
      await tx.staffAssignment.deleteMany({ where: { membershipId: m.id, shopId: { notIn: nextShops } } });
      for (const shopId of nextShops) await tx.staffAssignment.upsert({ where: { membershipId_shopId: { membershipId: m.id, shopId } }, create: { membershipId: m.id, shopId }, update: {} });
    });
    if (roleChanged) await audit(ctx, 'permission.role_changed', 'Membership', m.id, { from: m.role, to: input.role, userId: m.userId });
    if (JSON.stringify(before) !== JSON.stringify(nextShops.slice().sort())) await audit(ctx, 'staff.shops_changed', 'Membership', m.id, { from: before, to: nextShops });
    await audit(ctx, 'staff.updated', 'Membership', m.id, { bookable: bool(fd, 'bookable'), nominationFee: input.nominationFee, sortOrder: input.sortOrder });
    return { ok: true, message: '保存しました' };
  });
}

export async function setMemberActiveAction(fd: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await requireStaff('settings.staff');
    const id = String(fd.get('id') ?? '');
    const active = fd.get('active') === '1';
    if (id === ctx.membership.id) throw new AppError('自分自身は無効化できません');
    const m = await manageableMember(staffActorOf(ctx), id, { message: 'このスタッフを変更する権限がありません' });
    if (!active && m.role === 'OWNER') await assertNotLastOwner(ctx.org.id, m.id);
    await prisma.$transaction(async (tx) => {
      await tx.membership.update({ where: { id }, data: { active } });
      // end every session of the user in this organization immediately
      if (!active) await tx.session.deleteMany({ where: { userId: m.userId, organizationId: ctx.org.id } });
    });
    await audit(ctx, active ? 'staff.reactivated' : 'staff.deactivated', 'Membership', id, { userId: m.userId });
  });
}
