import { cache } from 'react';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { randomToken, sha256 } from '@salonos/core/crypto';
import { can as roleCan, PII_DEFAULT_ROLES, type Permission, type RoleName } from '@salonos/core';
import { prisma } from './db';
import { ForbiddenError } from './errors';

export const SESSION_COOKIE = 'salonos_session';
const SESSION_DAYS = 14;

export interface ShopSummary { id: string; name: string; slug: string; timezone: string; seatCount: number; taxRatePct: number; pointRatePct: number; slotIntervalMin: number }

export interface StaffContext {
  sessionId: string;
  user: { id: string; name: string; email: string };
  membership: { id: string; role: RoleName; canViewPII: boolean; displayName: string };
  org: { id: string; name: string; slug: string };
  shop: ShopSummary;
  shops: ShopSummary[];
  role: RoleName;
  can: (p: Permission) => boolean;
  /** PII visible by role or explicit grant (temporary unlock is checked separately). */
  piiByDefault: boolean;
}

export async function createSession(userId: string, organizationId: string, activeShopId?: string | null) {
  const token = randomToken();
  await prisma.session.create({
    data: { tokenHash: sha256(token), userId, organizationId, activeShopId: activeShopId ?? null, expiresAt: new Date(Date.now() + SESSION_DAYS * 86400000) },
  });
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: SESSION_DAYS * 86400,
  });
}

export async function destroySession() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await prisma.session.deleteMany({ where: { tokenHash: sha256(token) } });
  jar.delete(SESSION_COOKIE);
}

const shopSelect = { id: true, name: true, slug: true, timezone: true, seatCount: true, taxRatePct: true, pointRatePct: true, slotIntervalMin: true } as const;

/** Resolve the current staff context from the session cookie (cached per request). */
export const getStaffContext = cache(async (): Promise<StaffContext | null> => {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const session = await prisma.session.findUnique({ where: { tokenHash: sha256(token) }, include: { user: true } });
  if (!session || session.expiresAt < new Date() || !session.user.isActive) return null;
  const membership = await prisma.membership.findUnique({
    where: { organizationId_userId: { organizationId: session.organizationId, userId: session.userId } },
    include: { organization: true, shops: { include: { shop: { select: shopSelect } } } },
  });
  if (!membership || !membership.active) return null;
  const role = membership.role as RoleName;
  let shops: ShopSummary[];
  if (role === 'OWNER' || role === 'DIRECTOR') {
    shops = await prisma.shop.findMany({ where: { organizationId: membership.organizationId, active: true }, select: shopSelect, orderBy: { createdAt: 'asc' } });
  } else {
    shops = membership.shops.map((s) => s.shop).sort((a, b) => a.name.localeCompare(b.name));
  }
  const shop = shops.find((s) => s.id === session.activeShopId) ?? shops[0];
  if (!shop) return null;
  return {
    sessionId: session.id,
    user: { id: session.user.id, name: session.user.name, email: session.user.email },
    membership: { id: membership.id, role, canViewPII: membership.canViewPII, displayName: membership.displayName },
    org: { id: membership.organization.id, name: membership.organization.name, slug: membership.organization.slug },
    shop, shops, role,
    can: (p: Permission) => roleCan(role, p),
    piiByDefault: membership.canViewPII || PII_DEFAULT_ROLES.includes(role),
  };
});

/** For pages/actions: redirect to /login when signed out; throw 403 without permission. */
export async function requireStaff(perm?: Permission): Promise<StaffContext> {
  const ctx = await getStaffContext();
  if (!ctx) redirect('/login');
  if (perm && !ctx.can(perm)) throw new ForbiddenError();
  return ctx;
}

/** Ensure a shop id belongs to the caller's accessible shops. */
export function assertShop(ctx: StaffContext, shopId: string) {
  if (!ctx.shops.some((s) => s.id === shopId)) throw new ForbiddenError('この店舗へのアクセス権がありません');
}

export async function requestMeta() {
  const h = await headers();
  return {
    ip: (h.get('x-forwarded-for') ?? '').split(',')[0].trim() || h.get('x-real-ip') || null,
    userAgent: h.get('user-agent'),
  };
}

/** For server-component pages: renders app/forbidden.tsx instead of throwing. */
export async function requirePage(perm?: Permission): Promise<StaffContext> {
  const ctx = await getStaffContext();
  if (!ctx) redirect('/login');
  if (perm && !ctx.can(perm)) {
    const { forbidden } = await import('next/navigation');
    forbidden();
  }
  return ctx;
}
