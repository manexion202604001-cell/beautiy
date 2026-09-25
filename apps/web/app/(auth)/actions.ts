'use server';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { hashPassword, sha256, verifyPassword } from '@salonos/core/crypto';
import { prisma } from '@/lib/server/db';
import { createSession, destroySession, getStaffContext } from '@/lib/server/session';
import { audit } from '@/lib/server/audit';
import { runAction, type ActionResult, AppError } from '@/lib/server/errors';
import { slugify, uniqueShopSlug, createDefaultShopSetup } from '@/lib/server/shops';
import { safeNextPath } from '@/lib/safe-redirect';

// Best-effort per-instance login throttle (defence in depth; use a WAF/Redis limiter at scale).
const attempts = new Map<string, { n: number; until: number }>();
function throttle(key: string) {
  const a = attempts.get(key);
  if (a && a.until > Date.now() && a.n >= 8) throw new AppError('ログイン試行回数が多すぎます。数分後に再度お試しください。');
}
function fail(key: string) {
  const a = attempts.get(key);
  const n = a && a.until > Date.now() ? a.n + 1 : 1;
  attempts.set(key, { n, until: Date.now() + 5 * 60000 });
}

const loginSchema = z.object({ email: z.string().trim().toLowerCase().email('メールアドレスを入力してください'), password: z.string().min(1, 'パスワードを入力してください') });

export async function loginAction(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const r = await runAction(async () => {
    const { email, password } = loginSchema.parse(Object.fromEntries(fd));
    throttle(email);
    const user = await prisma.user.findUnique({ where: { email }, include: { memberships: { where: { active: true }, orderBy: { createdAt: 'asc' } } } });
    if (!user || !user.isActive || !verifyPassword(password, user.passwordHash)) {
      fail(email);
      throw new AppError('メールアドレスまたはパスワードが正しくありません');
    }
    const m = user.memberships[0];
    if (!m) throw new AppError('所属する組織がありません');
    await createSession(user.id, m.organizationId);
    await audit({ orgId: m.organizationId, userId: user.id }, 'auth.login', 'User', user.id);
  });
  // Never redirect off-site: `next` comes from the query string.
  if (r.ok) redirect(safeNextPath(fd.get('next')));
  return r;
}

const signupSchema = z.object({
  orgName: z.string().trim().min(1, 'サロン名（組織名）を入力してください').max(80),
  shopName: z.string().trim().min(1, '店舗名を入力してください').max(80),
  name: z.string().trim().min(1, 'お名前を入力してください').max(60),
  email: z.string().trim().toLowerCase().email('メールアドレスの形式が正しくありません'),
  password: z.string().min(8, 'パスワードは8文字以上にしてください').max(200),
  seatCount: z.coerce.number().int().min(1).max(50).default(3),
});

export async function signupAction(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const r = await runAction(async () => {
    const input = signupSchema.parse(Object.fromEntries(fd));
    const exists = await prisma.user.findUnique({ where: { email: input.email } });
    if (exists) throw new AppError('このメールアドレスは既に登録されています。ログインしてください。');
    const { org, shop, user } = await prisma.$transaction(async (tx) => {
      let orgSlug = slugify(input.orgName) || 'salon';
      if (await tx.organization.findUnique({ where: { slug: orgSlug } })) orgSlug = `${orgSlug}-${Date.now().toString(36)}`;
      const org = await tx.organization.create({ data: { name: input.orgName, slug: orgSlug } });
      const shop = await tx.shop.create({ data: { organizationId: org.id, name: input.shopName, slug: await uniqueShopSlug(tx, input.shopName), seatCount: input.seatCount } });
      const user = await tx.user.create({ data: { email: input.email, name: input.name, passwordHash: hashPassword(input.password) } });
      const m = await tx.membership.create({ data: { organizationId: org.id, userId: user.id, role: 'OWNER', canViewPII: true, displayName: input.name } });
      await tx.staffAssignment.create({ data: { membershipId: m.id, shopId: shop.id } });
      await createDefaultShopSetup(tx, org.id, shop.id);
      return { org, shop, user };
    });
    await createSession(user.id, org.id, shop.id);
    await audit({ orgId: org.id, userId: user.id }, 'org.created', 'Organization', org.id, { shopId: shop.id });
  });
  if (r.ok) redirect('/dashboard?welcome=1');
  return r;
}

export async function logoutAction() {
  const ctx = await getStaffContext();
  if (ctx) await audit(ctx, 'auth.logout', 'User', ctx.user.id);
  await destroySession();
  redirect('/login');
}

export async function switchShopAction(shopId: string) {
  const ctx = await getStaffContext();
  if (!ctx || !ctx.shops.some((s) => s.id === shopId)) return;
  await prisma.session.update({ where: { id: ctx.sessionId }, data: { activeShopId: shopId } });
}

const acceptSchema = z.object({
  token: z.string().min(10),
  password: z.string().min(8, 'パスワードは8文字以上にしてください'),
  name: z.string().trim().min(1, 'お名前を入力してください'),
});

export async function acceptInviteAction(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const r = await runAction(async () => {
    const input = acceptSchema.parse(Object.fromEntries(fd));
    const inv = await prisma.invitation.findUnique({ where: { tokenHash: sha256(input.token) } });
    if (!inv || inv.acceptedAt || inv.expiresAt < new Date()) throw new AppError('招待リンクが無効か、有効期限が切れています');
    const { userId } = await prisma.$transaction(async (tx) => {
      let user = await tx.user.findUnique({ where: { email: inv.email } });
      if (user) {
        if (!verifyPassword(input.password, user.passwordHash)) throw new AppError('既存アカウントのパスワードを入力してください');
      } else {
        user = await tx.user.create({ data: { email: inv.email, name: input.name, passwordHash: hashPassword(input.password) } });
      }
      const existing = await tx.membership.findUnique({ where: { organizationId_userId: { organizationId: inv.organizationId, userId: user.id } } });
      const m = existing
        ? await tx.membership.update({ where: { id: existing.id }, data: { active: true, role: inv.role } })
        : await tx.membership.create({ data: { organizationId: inv.organizationId, userId: user.id, role: inv.role, displayName: input.name } });
      for (const shopId of inv.shopIds) {
        await tx.staffAssignment.upsert({ where: { membershipId_shopId: { membershipId: m.id, shopId } }, create: { membershipId: m.id, shopId }, update: {} });
      }
      await tx.invitation.update({ where: { id: inv.id }, data: { acceptedAt: new Date() } });
      return { userId: user.id };
    });
    await createSession(userId, inv.organizationId, inv.shopIds[0] ?? null);
    await audit({ orgId: inv.organizationId, userId }, 'staff.invite_accepted', 'Invitation', inv.id);
  });
  if (r.ok) redirect('/dashboard');
  return r;
}
