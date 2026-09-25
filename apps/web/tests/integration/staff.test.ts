import { describe, expect, it } from 'vitest';
import { hashPassword } from '@salonos/core/crypto';
import type { RoleName } from '@salonos/core';
import { prisma } from '@salonos/db';
import { manageableMember, type StaffActor } from '@/lib/server/staff-access';
import { makeOrg } from './helpers';

let n = 0;
async function member(orgId: string, role: RoleName, shopIds: string[]) {
  const tag = `${Date.now().toString(36)}m${n++}`;
  const user = await prisma.user.create({ data: { email: `${tag}@test.local`, name: tag, passwordHash: hashPassword('password123') } });
  const m = await prisma.membership.create({ data: { organizationId: orgId, userId: user.id, role, displayName: tag } });
  for (const shopId of shopIds) await prisma.staffAssignment.create({ data: { membershipId: m.id, shopId } });
  return m;
}

describe('M4: staff management is limited by rank and shop', () => {
  it('a manager can manage lower-ranked staff of their own shops only; self always', async () => {
    const { org, shop, staff } = await makeOrg();
    const shopB = await prisma.shop.create({ data: { organizationId: org.id, name: 'B店', slug: `b-${Date.now().toString(36)}${n++}` } });
    const manager = await member(org.id, 'MANAGER', [shop.id]);
    const otherManager = await member(org.id, 'MANAGER', [shop.id]);
    const stylistB = await member(org.id, 'STYLIST', [shopB.id]);
    const stylistAB = await member(org.id, 'STYLIST', [shop.id, shopB.id]);
    const director = await member(org.id, 'DIRECTOR', []);
    const stylistA = staff[1].membershipId; // STYLIST in shop A (from makeOrg)
    const owner = staff[0].membershipId;

    const asManager: StaffActor = { orgId: org.id, role: 'MANAGER', membershipId: manager.id, shopIds: [shop.id] };
    expect((await manageableMember(asManager, stylistA)).id).toBe(stylistA);
    expect((await manageableMember(asManager, stylistAB.id)).id).toBe(stylistAB.id); // shares shop A
    await expect(manageableMember(asManager, stylistB.id)).rejects.toThrow(/権限/); // other shop only
    await expect(manageableMember(asManager, owner)).rejects.toThrow(/権限/); // higher rank
    await expect(manageableMember(asManager, otherManager.id)).rejects.toThrow(/権限/); // same rank
    await expect(manageableMember(asManager, manager.id)).rejects.toThrow(/権限/); // self only when allowed
    expect((await manageableMember(asManager, manager.id, { allowSelf: true })).id).toBe(manager.id); // own profile

    // org-wide roles are not limited by shop assignment (still by rank)
    const asDirector: StaffActor = { orgId: org.id, role: 'DIRECTOR', membershipId: director.id, shopIds: [shop.id, shopB.id] };
    expect((await manageableMember(asDirector, stylistB.id)).id).toBe(stylistB.id);
    await expect(manageableMember(asDirector, owner)).rejects.toThrow(/権限/);
    const asOwner: StaffActor = { orgId: org.id, role: 'OWNER', membershipId: owner, shopIds: [shop.id, shopB.id] };
    expect((await manageableMember(asOwner, director.id)).id).toBe(director.id);

    // other tenant
    const other = await makeOrg();
    await expect(manageableMember({ ...asOwner, orgId: other.org.id }, stylistB.id)).rejects.toThrow(/見つかりません/);
  });
});
