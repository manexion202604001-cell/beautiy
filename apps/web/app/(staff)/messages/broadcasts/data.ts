// Shared loaders for broadcast pages (server-only).
import { toLocalParts, minutesToHHMM } from '@salonos/core';
import { prisma } from '@/lib/server/db';
import type { StaffContext } from '@/lib/server/session';

export async function builderOptions(ctx: StaffContext) {
  const [tags, staff, templates] = await Promise.all([
    prisma.tag.findMany({ where: { organizationId: ctx.org.id }, orderBy: { name: 'asc' }, select: { id: true, name: true, color: true } }),
    prisma.membership.findMany({ where: { organizationId: ctx.org.id, active: true }, orderBy: [{ sortOrder: 'asc' }, { displayName: 'asc' }], select: { userId: true, displayName: true } }),
    prisma.messageTemplate.findMany({ where: { organizationId: ctx.org.id }, orderBy: [{ category: 'asc' }, { name: 'asc' }], select: { id: true, name: true, category: true, body: true } }),
  ]);
  return { tags, staff, templates, shops: ctx.shops.map((s) => ({ id: s.id, name: s.name })), shopName: ctx.shop.name, minLocal: toLocalInput(new Date(), ctx.shop.timezone) };
}

export function toLocalInput(d: Date, tz: string) {
  const p = toLocalParts(d, tz);
  return `${p.date}T${minutesToHHMM(p.minutes)}`;
}

export async function segmentMaps(orgId: string, ctx: StaffContext) {
  const [tags, staff] = await Promise.all([
    prisma.tag.findMany({ where: { organizationId: orgId }, select: { id: true, name: true } }),
    prisma.membership.findMany({ where: { organizationId: orgId }, select: { userId: true, displayName: true } }),
  ]);
  return {
    tags: new Map(tags.map((t) => [t.id, t.name])),
    staff: new Map(staff.map((s) => [s.userId, s.displayName])),
    shops: new Map(ctx.shops.map((s) => [s.id, s.name])),
  };
}
