import { hashPassword } from '@salonos/core/crypto';
import { prisma } from '@salonos/db';
import { createDefaultShopSetup } from '@/lib/server/shops';

let n = 0;
/** Creates an isolated org + shop (open every day 10:00–20:00) + staff for a test. */
export async function makeOrg(opts: { seats?: number; staff?: number } = {}) {
  const tag = `${Date.now().toString(36)}${n++}`;
  const org = await prisma.organization.create({ data: { name: `Test ${tag}`, slug: `t-${tag}` } });
  const shop = await prisma.shop.create({ data: { organizationId: org.id, name: 'Shop', slug: `s-${tag}`, seatCount: opts.seats ?? 2, minNoticeMin: 0 } });
  await prisma.$transaction((tx) => createDefaultShopSetup(tx, org.id, shop.id));
  await prisma.businessHour.updateMany({ where: { shopId: shop.id }, data: { closed: false, openMin: 600, closeMin: 1200 } });
  const staff = [];
  for (let i = 0; i < (opts.staff ?? 2); i++) {
    const user = await prisma.user.create({ data: { email: `u${i}-${tag}@test.local`, name: `Staff ${i}`, passwordHash: hashPassword('password123') } });
    const m = await prisma.membership.create({ data: { organizationId: org.id, userId: user.id, role: i === 0 ? 'OWNER' : 'STYLIST', displayName: `Staff ${i}`, sortOrder: i } });
    await prisma.staffAssignment.create({ data: { membershipId: m.id, shopId: shop.id } });
    staff.push({ userId: user.id, membershipId: m.id });
  }
  const menus = await prisma.menu.findMany({ where: { shopId: shop.id } });
  return { org, shop, staff, menus };
}

/** A future date string (shop-local) N days ahead. */
export function futureDate(days = 3) {
  return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
}
