// Public profile loaders (no PII: reviews expose only the display name the customer chose).
import { cache } from 'react';
import { prisma } from '@/lib/server/db';
import { reviewStats } from '@/lib/server/reviews';

export const loadShopProfile = cache(async (slug: string) => {
  if (!slug || slug.length > 80) return null;
  const shop = await prisma.shop.findUnique({
    where: { slug },
    include: {
      organization: { select: { name: true } },
      businessHours: { orderBy: { weekday: 'asc' } },
      menus: { where: { active: true, publicBookable: true }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] },
      staff: { include: { membership: true } },
    },
  });
  if (!shop || !shop.active) return null;
  const staff = shop.staff.map((s) => s.membership).filter((m) => m.active && m.bookable).sort((a, b) => a.sortOrder - b.sortOrder || a.displayName.localeCompare(b.displayName));
  const where = { shopId: shop.id, published: true };
  const [stats, reviews, holidays] = await Promise.all([
    reviewStats(where),
    prisma.review.findMany({ where, orderBy: { createdAt: 'desc' }, take: 10 }),
    prisma.shopHoliday.findMany({ where: { shopId: shop.id, date: { gte: new Date().toISOString().slice(0, 10) } }, orderBy: { date: 'asc' }, take: 5 }),
  ]);
  const staffName = new Map(staff.map((m) => [m.userId, m.displayName]));
  return { shop, staff, stats, reviews, holidays, staffName };
});

export const loadStaffProfile = cache(async (slug: string, membershipId: string) => {
  const data = await loadShopProfile(slug);
  if (!data || !membershipId || membershipId.length > 64) return null;
  const member = data.staff.find((m) => m.id === membershipId);
  if (!member) return null;
  const where = { shopId: data.shop.id, staffId: member.userId, published: true };
  const [stats, reviews] = await Promise.all([reviewStats(where), prisma.review.findMany({ where, orderBy: { createdAt: 'desc' }, take: 10 })]);
  return { ...data, member, memberStats: stats, memberReviews: reviews };
});

export function specialtiesOf(s: string | null | undefined): string[] {
  return (s ?? '').split(/[、,，\/／\n]/).map((x) => x.trim()).filter(Boolean).slice(0, 12);
}
