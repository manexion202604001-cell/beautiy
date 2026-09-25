import { describe, expect, it } from 'vitest';
import { prisma } from '@salonos/db';
import { mergeCustomers, recomputeCustomerStats, resolveCustomer } from '@/lib/server/customers';
import { decryptField, piiColumns } from '@/lib/server/pii';
import { makeOrg } from './helpers';

describe('customer identity (DB)', () => {
  it('resolves by identity → phone → email, attaching identities', async () => {
    const { org } = await makeOrg();
    const a = await prisma.$transaction((tx) => resolveCustomer(tx, { orgId: org.id, name: '山田 花子', phone: '090-1111-2222' }));
    expect(a.matchedBy).toBe('created');
    const b = await prisma.$transaction((tx) => resolveCustomer(tx, { orgId: org.id, name: 'ヤマダ', phone: '+81 90 1111 2222', identity: { provider: 'LINE', externalId: 'U1' } }));
    expect(b).toEqual({ customerId: a.customerId, matchedBy: 'phone' });
    const c = await prisma.$transaction((tx) => resolveCustomer(tx, { orgId: org.id, name: '別人', identity: { provider: 'LINE', externalId: 'U1' } }));
    expect(c).toEqual({ customerId: a.customerId, matchedBy: 'identity' });
    const row = await prisma.customer.findUniqueOrThrow({ where: { id: a.customerId } });
    expect(row.phoneEnc).not.toContain('1111');
    expect(decryptField(row.phoneEnc)).toBe('09011112222');
  });

  it('merges customers moving history, identities and tags; follows merge chain', async () => {
    const { org, shop, staff } = await makeOrg();
    const tag = await prisma.tag.create({ data: { organizationId: org.id, name: 'VIP' } });
    const s = await prisma.customer.create({ data: { organizationId: org.id, lastName: '山田', firstName: '花子' } });
    const m = await prisma.customer.create({ data: { organizationId: org.id, lastName: '山田', firstName: '花子', ...piiColumns({ phone: '09033334444' }), notes: 'memo', tags: { create: { tagId: tag.id } } } });
    await prisma.customerIdentity.create({ data: { organizationId: org.id, customerId: m.id, provider: 'LINE', externalId: 'U-merge' } });
    await prisma.transaction.create({ data: { organizationId: org.id, shopId: shop.id, customerId: m.id, status: 'PAID', total: 10000, subtotal: 10000, paidAt: new Date() } });
    await mergeCustomers(org.id, s.id, m.id, staff[0].userId);
    const survivor = await prisma.customer.findUniqueOrThrow({ where: { id: s.id }, include: { tags: true, identities: true } });
    expect(survivor.visitCount).toBe(1);
    expect(survivor.totalSales).toBe(10000);
    expect(survivor.phoneHash).toBeTruthy();
    expect(survivor.tags).toHaveLength(1);
    expect(survivor.identities[0].externalId).toBe('U-merge');
    const merged = await prisma.customer.findUniqueOrThrow({ where: { id: m.id } });
    expect(merged.mergedIntoId).toBe(s.id);
    const r = await prisma.$transaction((tx) => resolveCustomer(tx, { orgId: org.id, name: 'x', phone: '09033334444' }));
    expect(r.customerId).toBe(s.id);
    await expect(mergeCustomers(org.id, s.id, m.id, staff[0].userId)).rejects.toThrow();
  });

  it('recomputes LTV stats excluding refunds', async () => {
    const { org, shop } = await makeOrg();
    const c = await prisma.customer.create({ data: { organizationId: org.id, lastName: 'A', firstName: 'B' } });
    const d = (days: number) => new Date(Date.now() - days * 86400000);
    await prisma.transaction.createMany({ data: [
      { organizationId: org.id, shopId: shop.id, customerId: c.id, status: 'PAID', total: 8000, subtotal: 8000, paidAt: d(90) },
      { organizationId: org.id, shopId: shop.id, customerId: c.id, status: 'PARTIALLY_REFUNDED', total: 12000, refundedTotal: 2000, subtotal: 12000, paidAt: d(30) },
      { organizationId: org.id, shopId: shop.id, customerId: c.id, status: 'VOID', total: 5000, subtotal: 5000, paidAt: d(10) },
    ] });
    const s = await recomputeCustomerStats(c.id);
    expect(s).toMatchObject({ visitCount: 2, ltv: 18000, avgIntervalDays: 60 });
  });
});
