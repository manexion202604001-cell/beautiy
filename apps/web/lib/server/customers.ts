// Customer identity resolution, stats and merge.
import type { Prisma } from '@salonos/db';
import { publicNameMatches, visitStats } from '@salonos/core';
import { prisma, type Tx } from './db';
import { emailHash, phoneHash, piiColumns } from './pii';
import { AppError, NotFoundError } from './errors';

export function splitName(full: string): { lastName: string; firstName: string } {
  const s = full.normalize('NFKC').trim().replace(/\s+/g, ' ');
  const i = s.indexOf(' ');
  return i < 0 ? { lastName: s, firstName: '' } : { lastName: s.slice(0, i), firstName: s.slice(i + 1) };
}

export function fullName(c: { lastName: string; firstName: string }) {
  return `${c.lastName} ${c.firstName}`.trim();
}

export interface ResolveInput {
  orgId: string;
  shopId?: string | null;
  name: string;
  kana?: string | null;
  phone?: string | null;
  email?: string | null;
  identity?: { provider: string; externalId: string; displayName?: string | null } | null;
  /**
   * Unverified public input (web booking, store order): a phone/email blind-index match only
   * counts when the submitted name also matches the stored record (see `publicNameMatches`).
   * Otherwise a NEW customer is created (it surfaces in /customers/duplicates for staff to
   * merge), so a stranger who knows someone's phone number can neither see that customer's
   * stored name nor attach bookings/messages to them. An identity match (e.g. a verified LINE
   * link token) is still authoritative. Staff-entered data and booking-provider sync leave
   * this off and keep the plain phone → email match.
   */
  requireNameMatch?: boolean;
}

export type MatchedBy = 'identity' | 'phone' | 'email' | 'created';

/**
 * Find-or-create a customer from an inbound booking/message. Match order:
 * external identity → phone blind index → email blind index → create.
 * Attaches the external identity to the matched record so later events resolve directly.
 */
export async function resolveCustomer(tx: Tx, input: ResolveInput): Promise<{ customerId: string; matchedBy: MatchedBy }> {
  const live = { organizationId: input.orgId, mergedIntoId: null, deletedAt: null };
  // Serialize concurrent resolutions of the same identity / phone / email (e.g. parallel sync
  // workers or double-submitted forms) so they can't both create a customer and race on the
  // identity upsert. Transaction-scoped: callers should pass a transaction client.
  const lockKeysFor = [
    input.identity ? `cust-ident:${input.orgId}:${input.identity.provider}:${input.identity.externalId}` : null,
    phoneHash(input.phone) ? `cust-phone:${input.orgId}:${phoneHash(input.phone)}` : null,
    emailHash(input.email) ? `cust-email:${input.orgId}:${emailHash(input.email)}` : null,
  ].filter((k): k is string => !!k).sort();
  for (const k of lockKeysFor) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${k}))`;
  if (input.identity) {
    const ident = await tx.customerIdentity.findUnique({
      where: { organizationId_provider_externalId: { organizationId: input.orgId, provider: input.identity.provider, externalId: input.identity.externalId } },
      include: { customer: true },
    });
    if (ident) {
      // follow merge chain
      let c = ident.customer;
      for (let i = 0; i < 5 && c.mergedIntoId; i++) c = (await tx.customer.findUnique({ where: { id: c.mergedIntoId } })) ?? c;
      return { customerId: c.id, matchedBy: 'identity' };
    }
  }
  let customerId: string | null = null;
  let matchedBy: MatchedBy = 'created';
  const pick = async (where: Prisma.CustomerWhereInput) => {
    const rows = await tx.customer.findMany({
      where: { ...live, ...where }, orderBy: { createdAt: 'asc' }, take: 25,
      select: { id: true, lastName: true, firstName: true, lastNameKana: true, firstNameKana: true },
    });
    if (!input.requireNameMatch) return rows[0] ?? null;
    return rows.find((r) => publicNameMatches({ name: input.name, kana: input.kana }, r)) ?? null;
  };
  const ph = phoneHash(input.phone);
  if (ph) {
    const c = await pick({ phoneHash: ph });
    if (c) { customerId = c.id; matchedBy = 'phone'; }
  }
  const em = emailHash(input.email);
  if (!customerId && em) {
    const c = await pick({ emailHash: em });
    if (c) { customerId = c.id; matchedBy = 'email'; }
  }
  if (!customerId) {
    const { lastName, firstName } = splitName(input.name || 'ゲスト');
    const kana = input.kana ? splitName(input.kana) : null;
    const c = await tx.customer.create({
      data: {
        organizationId: input.orgId, primaryShopId: input.shopId ?? null, lastName, firstName,
        lastNameKana: kana?.lastName ?? null, firstNameKana: kana?.firstName ?? null,
        ...piiColumns({ phone: input.phone ?? null, email: input.email ?? null }),
      },
    });
    customerId = c.id;
  }
  if (input.identity) {
    await tx.customerIdentity.upsert({
      where: { organizationId_provider_externalId: { organizationId: input.orgId, provider: input.identity.provider, externalId: input.identity.externalId } },
      create: { organizationId: input.orgId, customerId, provider: input.identity.provider, externalId: input.identity.externalId, displayName: input.identity.displayName ?? null },
      update: {},
    });
  }
  return { customerId, matchedBy };
}

export const VISIT_TX_STATUSES = ['PAID', 'PARTIALLY_REFUNDED'] as const;

/** Recompute denormalized visit/LTV stats from paid transactions and appointment history. */
export async function recomputeCustomerStats(customerId: string, tx: Tx | typeof prisma = prisma) {
  const [txs, noShow, cancel] = await Promise.all([
    tx.transaction.findMany({
      where: { customerId, status: { in: [...VISIT_TX_STATUSES] } },
      select: { paidAt: true, createdAt: true, total: true, refundedTotal: true },
    }),
    tx.appointment.count({ where: { customerId, status: 'NO_SHOW' } }),
    tx.appointment.count({ where: { customerId, status: 'CANCELLED' } }),
  ]);
  const s = visitStats(txs.map((t) => ({ at: t.paidAt ?? t.createdAt, amount: t.total - t.refundedTotal })));
  await tx.customer.update({
    where: { id: customerId },
    data: {
      visitCount: s.visitCount, totalSales: s.ltv,
      firstVisitAt: s.firstVisitAt ? new Date(s.firstVisitAt) : null,
      lastVisitAt: s.lastVisitAt ? new Date(s.lastVisitAt) : null,
      noShowCount: noShow, cancelCount: cancel,
    },
  });
  return s;
}

export async function pointsBalance(customerId: string, tx: Tx | typeof prisma = prisma): Promise<number> {
  const r = await tx.pointLedger.aggregate({ where: { customerId }, _sum: { delta: true } });
  return r._sum.delta ?? 0;
}

/**
 * Merge `mergedId` into `survivorId`. All history moves to the survivor; blank survivor
 * fields are filled from the merged record; the merged record is tombstoned (mergedIntoId).
 * A snapshot is kept in CustomerMerge for audit.
 */
export async function mergeCustomers(orgId: string, survivorId: string, mergedId: string, performedById: string) {
  if (survivorId === mergedId) throw new AppError('同じ顧客は統合できません');
  return prisma.$transaction(async (tx) => {
    const [s, m] = await Promise.all([
      tx.customer.findFirst({ where: { id: survivorId, organizationId: orgId, mergedIntoId: null, deletedAt: null }, include: { tags: true, identities: true } }),
      tx.customer.findFirst({ where: { id: mergedId, organizationId: orgId, mergedIntoId: null, deletedAt: null }, include: { tags: true, identities: true } }),
    ]);
    if (!s || !m) throw new NotFoundError('統合対象の顧客が見つかりません');

    const where = { customerId: mergedId };
    const data = { customerId: survivorId };
    await tx.appointment.updateMany({ where, data });
    await tx.karte.updateMany({ where, data });
    await tx.transaction.updateMany({ where, data });
    await tx.message.updateMany({ where, data });
    await tx.pointLedger.updateMany({ where, data });
    await tx.review.updateMany({ where, data });
    await tx.counselingResponse.updateMany({ where, data });
    await tx.order.updateMany({ where, data });
    await tx.waitlistEntry.updateMany({ where, data });
    await tx.subscription.updateMany({ where, data });

    const survivorIdentKeys = new Set(s.identities.map((i) => `${i.provider}:${i.externalId}`));
    for (const i of m.identities) {
      if (survivorIdentKeys.has(`${i.provider}:${i.externalId}`)) await tx.customerIdentity.delete({ where: { id: i.id } });
      else await tx.customerIdentity.update({ where: { id: i.id }, data: { customerId: survivorId } });
    }
    const survivorTags = new Set(s.tags.map((t) => t.tagId));
    const newTags = m.tags.filter((t) => !survivorTags.has(t.tagId));
    if (newTags.length) await tx.customerTag.createMany({ data: newTags.map((t) => ({ customerId: survivorId, tagId: t.tagId })), skipDuplicates: true });
    await tx.customerTag.deleteMany({ where: { customerId: mergedId } });

    const fill: Prisma.CustomerUpdateInput = {};
    const keys = ['lastNameKana', 'firstNameKana', 'phoneEnc', 'phoneHash', 'emailEnc', 'emailHash', 'addressEnc', 'birthday', 'gender', 'assignedStaffId', 'primaryShopId'] as const;
    for (const k of keys) if (!s[k] && m[k]) (fill as any)[k] = m[k];
    if (m.notes) fill.notes = s.notes ? `${s.notes}\n---\n[統合元] ${m.notes}` : m.notes;
    if (m.favorite) fill.favorite = true;
    fill.lineOptIn = s.lineOptIn && m.lineOptIn;
    fill.emailOptIn = s.emailOptIn && m.emailOptIn;
    await tx.customer.update({ where: { id: survivorId }, data: fill });

    const { tags: _t, identities: _i, ...snapshot } = m;
    await tx.customer.update({ where: { id: mergedId }, data: { mergedIntoId: survivorId, deletedAt: new Date() } });
    const merge = await tx.customerMerge.create({
      data: { organizationId: orgId, survivorId, mergedId, performedById, snapshot: JSON.parse(JSON.stringify({ customer: snapshot, identities: m.identities, tagIds: m.tags.map((t) => t.tagId) })) },
    });
    await recomputeCustomerStats(survivorId, tx);
    return merge;
  });
}
