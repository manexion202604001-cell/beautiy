// Customer CRM services: search, stats, timeline, tags, identities, points,
// duplicate detection, CSV import/export. Server actions stay thin and call these.
import type { Prisma } from '@salonos/db';
import {
  findDuplicates, lifecycle, normalizeEmail, normalizeKana, normalizePhone, toCsv, visitStats,
  type DuplicatePair, type Lifecycle,
} from '@salonos/core';
import { prisma } from './db';
import { audit } from './audit';
import { decryptField, emailHash, maskedContact, phoneHash, piiAccess, piiColumns } from './pii';
import { fullName, pointsBalance, VISIT_TX_STATUSES } from './customers';
import { AppError, ForbiddenError, NotFoundError } from './errors';
import type { StaffContext } from './session';

export interface Actor { orgId: string; userId: string }
export const actorOf = (ctx: StaffContext): Actor => ({ orgId: ctx.org.id, userId: ctx.user.id });

export const liveWhere = (orgId: string) => ({ organizationId: orgId, mergedIntoId: null, deletedAt: null });

// ───────────────────────── Normalization helpers ─────────────────────────

export function toKatakana(s: string): string { return normalizeKana(s); }
export function toHiragana(s: string): string {
  return s.normalize('NFKC').replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60)).replace(/\s/g, '');
}
/** Store kana as full-width katakana without spaces (null when blank). */
export function storeKana(s: string | null | undefined): string | null {
  const k = normalizeKana(s ?? '');
  return k || null;
}

/** Accepts YYYY-MM-DD, YYYY/M/D, YYYY.M.D, YYYYMMDD, YYYY年M月D日. Returns null when invalid. */
export function normalizeBirthday(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.normalize('NFKC').trim();
  let m = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/.exec(s);
  if (!m) m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  if (y < 1900 || dt.getTime() > Date.now()) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Average visit interval from denormalized stats. */
export function avgIntervalDays(c: { visitCount: number; firstVisitAt: Date | null; lastVisitAt: Date | null }): number | null {
  if (c.visitCount < 2 || !c.firstVisitAt || !c.lastVisitAt) return null;
  return Math.round(((c.lastVisitAt.getTime() - c.firstVisitAt.getTime()) / 86400000 / (c.visitCount - 1)) * 10) / 10;
}

export function customerLifecycle(c: { visitCount: number; firstVisitAt: Date | null; lastVisitAt: Date | null }, now = Date.now()): Lifecycle {
  return lifecycle({ visitCount: c.visitCount, lastVisitAt: c.lastVisitAt ? c.lastVisitAt.getTime() : null, avgIntervalDays: avgIntervalDays(c) }, now);
}

export const LIFECYCLE_TONE: Record<Lifecycle, 'blue' | 'green' | 'amber' | 'red' | 'violet' | 'gray'> = {
  NEW: 'green', ACTIVE: 'blue', DUE: 'amber', OVERDUE: 'red', DORMANT: 'gray', PROSPECT: 'violet',
};

// ───────────────────────── Search ─────────────────────────

export const SORTS = ['lastVisit', 'ltv', 'visits', 'name', 'created'] as const;
export type CustomerSort = (typeof SORTS)[number];
export const LIFECYCLES = ['NEW', 'ACTIVE', 'DUE', 'OVERDUE', 'DORMANT', 'PROSPECT'] as const;

export interface CustomerQuery {
  q?: string | null;
  tagId?: string | null;
  staffId?: string | null;
  shopId?: string | null;
  lifecycle?: Lifecycle | null;
  favorite?: boolean;
  sort?: CustomerSort;
  page?: number;
  perPage?: number;
}

export type SearchMode = 'none' | 'name' | 'phone' | 'email';

/** Build the Prisma where clause (without lifecycle, which is computed). */
export function customerWhere(orgId: string, q: CustomerQuery): { where: Prisma.CustomerWhereInput; mode: SearchMode } {
  const and: Prisma.CustomerWhereInput[] = [];
  let mode: SearchMode = 'none';
  const text = (q.q ?? '').normalize('NFKC').trim();
  if (text) {
    const email = text.includes('@') ? normalizeEmail(text) : null;
    const phoneLike = /^[\d\s()+\-－ー]+$/.test(text);
    const phone = phoneLike ? normalizePhone(text) : null;
    if (email) { mode = 'email'; and.push({ emailHash: emailHash(email) }); }
    else if (phone) { mode = 'phone'; and.push({ phoneHash: phoneHash(phone) }); }
    else if (phoneLike) { mode = 'phone'; and.push({ id: '__no_match__' }); }
    else {
      mode = 'name';
      const tokens = text.split(/\s+/).filter(Boolean).slice(0, 4);
      for (const t of tokens) {
        const kata = toKatakana(t), hira = toHiragana(t);
        const or: Prisma.CustomerWhereInput[] = [
          { lastName: { contains: t, mode: 'insensitive' } },
          { firstName: { contains: t, mode: 'insensitive' } },
        ];
        for (const k of new Set([kata, hira, t])) {
          if (!k) continue;
          or.push({ lastNameKana: { contains: k } }, { firstNameKana: { contains: k } });
        }
        // "山田花子" / "ヤマダハナコ" without a space: try last|first splits.
        if (tokens.length === 1 && t.length >= 2 && t.length <= 12) {
          for (let i = 1; i < t.length; i++) {
            or.push({ lastName: t.slice(0, i), firstName: { startsWith: t.slice(i) } });
            if (kata) or.push({ lastNameKana: kata.slice(0, i), firstNameKana: { startsWith: kata.slice(i) } });
          }
        }
        and.push({ OR: or });
      }
    }
  }
  if (q.tagId) and.push({ tags: { some: { tagId: q.tagId } } });
  if (q.staffId) and.push({ assignedStaffId: q.staffId === 'none' ? null : q.staffId });
  if (q.shopId) and.push({ primaryShopId: q.shopId });
  if (q.favorite) and.push({ favorite: true });
  return { where: { ...liveWhere(orgId), AND: and }, mode };
}

function orderBy(sort: CustomerSort | undefined): Prisma.CustomerOrderByWithRelationInput[] {
  switch (sort) {
    case 'ltv': return [{ totalSales: 'desc' }, { id: 'asc' }];
    case 'visits': return [{ visitCount: 'desc' }, { id: 'asc' }];
    case 'name': return [{ lastNameKana: { sort: 'asc', nulls: 'last' } }, { firstNameKana: { sort: 'asc', nulls: 'last' } }, { lastName: 'asc' }, { id: 'asc' }];
    case 'created': return [{ createdAt: 'desc' }, { id: 'asc' }];
    default: return [{ lastVisitAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }, { id: 'asc' }];
  }
}

export interface CustomerRow {
  id: string; name: string; kana: string; phone: string; favorite: boolean;
  lastVisitAt: Date | null; visitCount: number; totalSales: number; avgIntervalDays: number | null;
  assignedStaffId: string | null; assignedStaffName: string | null;
  tags: { id: string; name: string; color: string }[]; lifecycle: Lifecycle;
}

export async function searchCustomers(orgId: string, q: CustomerQuery, now = Date.now()) {
  const perPage = Math.min(Math.max(q.perPage ?? 30, 1), 200);
  const page = Math.max(q.page ?? 1, 1);
  const { where, mode } = customerWhere(orgId, q);
  let finalWhere = where;
  if (q.lifecycle) {
    // Lifecycle depends on each customer's own visit cycle → compute over minimal columns.
    const all = await prisma.customer.findMany({ where, select: { id: true, visitCount: true, firstVisitAt: true, lastVisitAt: true } });
    const ids = all.filter((c) => customerLifecycle(c, now) === q.lifecycle).map((c) => c.id);
    finalWhere = { AND: [where, { id: { in: ids } }] };
  }
  const [total, rows] = await Promise.all([
    prisma.customer.count({ where: finalWhere }),
    prisma.customer.findMany({
      where: finalWhere, orderBy: orderBy(q.sort), skip: (page - 1) * perPage, take: perPage,
      select: {
        id: true, lastName: true, firstName: true, lastNameKana: true, firstNameKana: true, phoneEnc: true, emailEnc: true,
        favorite: true, lastVisitAt: true, firstVisitAt: true, visitCount: true, totalSales: true, assignedStaffId: true,
        tags: { select: { tag: { select: { id: true, name: true, color: true } } } },
      },
    }),
  ]);
  const staffIds = [...new Set(rows.map((r) => r.assignedStaffId).filter(Boolean) as string[])];
  const staff = staffIds.length ? await prisma.membership.findMany({ where: { organizationId: orgId, userId: { in: staffIds } }, select: { userId: true, displayName: true } }) : [];
  const staffName = new Map(staff.map((s) => [s.userId, s.displayName]));
  const items: CustomerRow[] = rows.map((r) => ({
    id: r.id, name: fullName(r), kana: `${r.lastNameKana ?? ''} ${r.firstNameKana ?? ''}`.trim(),
    phone: maskedContact(r).phone, favorite: r.favorite, lastVisitAt: r.lastVisitAt, visitCount: r.visitCount, totalSales: r.totalSales,
    avgIntervalDays: avgIntervalDays(r), assignedStaffId: r.assignedStaffId, assignedStaffName: r.assignedStaffId ? staffName.get(r.assignedStaffId) ?? null : null,
    tags: r.tags.map((t) => t.tag), lifecycle: customerLifecycle(r, now),
  }));
  return { items, total, page, perPage, pages: Math.max(1, Math.ceil(total / perPage)), mode };
}

// ───────────────────────── Create / update ─────────────────────────

export interface CustomerInput {
  lastName: string; firstName: string; lastNameKana?: string | null; firstNameKana?: string | null;
  phone?: string | null; email?: string | null; address?: string | null;
  birthday?: string | null; gender?: string | null; notes?: string | null;
  assignedStaffId?: string | null; primaryShopId?: string | null;
  lineOptIn: boolean; emailOptIn: boolean; favorite: boolean;
}

async function validateRefs(orgId: string, input: Pick<CustomerInput, 'assignedStaffId' | 'primaryShopId'>) {
  if (input.assignedStaffId) {
    const m = await prisma.membership.findFirst({ where: { organizationId: orgId, userId: input.assignedStaffId } });
    if (!m) throw new AppError('担当スタッフが見つかりません');
  }
  if (input.primaryShopId) {
    const s = await prisma.shop.findFirst({ where: { id: input.primaryShopId, organizationId: orgId } });
    if (!s) throw new AppError('店舗が見つかりません');
  }
}

/** Existing live customers sharing the phone/email blind index. */
export async function findContactConflicts(orgId: string, contact: { phone?: string | null; email?: string | null }, excludeId?: string) {
  const or: Prisma.CustomerWhereInput[] = [];
  const ph = phoneHash(contact.phone), em = emailHash(contact.email);
  if (ph) or.push({ phoneHash: ph });
  if (em) or.push({ emailHash: em });
  if (!or.length) return [];
  return prisma.customer.findMany({
    where: { ...liveWhere(orgId), OR: or, ...(excludeId ? { NOT: { id: excludeId } } : {}) },
    select: { id: true, lastName: true, firstName: true, phoneHash: true, emailHash: true }, take: 5,
  });
}

export async function createCustomer(actor: Actor, input: CustomerInput, opts: { allowDuplicate?: boolean } = {}) {
  if (input.phone && !normalizePhone(input.phone)) throw new AppError('電話番号の形式が正しくありません');
  if (input.email && !normalizeEmail(input.email)) throw new AppError('メールアドレスの形式が正しくありません');
  await validateRefs(actor.orgId, input);
  if (!opts.allowDuplicate) {
    const dup = await findContactConflicts(actor.orgId, input);
    if (dup.length) throw new AppError(`同じ電話番号またはメールアドレスの顧客が登録済みです（${dup.map(fullName).join('、')}）。重複を承知で登録する場合はチェックを入れてください。`, 'DUPLICATE');
  }
  const c = await prisma.customer.create({
    data: {
      organizationId: actor.orgId, lastName: input.lastName, firstName: input.firstName,
      lastNameKana: storeKana(input.lastNameKana), firstNameKana: storeKana(input.firstNameKana),
      ...piiColumns({ phone: input.phone || null, email: input.email || null, address: input.address || null }),
      birthday: input.birthday || null, gender: input.gender || null, notes: input.notes || null,
      assignedStaffId: input.assignedStaffId || null, primaryShopId: input.primaryShopId || null,
      lineOptIn: input.lineOptIn, emailOptIn: input.emailOptIn, favorite: input.favorite,
    },
  });
  await audit({ orgId: actor.orgId, userId: actor.userId }, 'customer.create', 'Customer', c.id);
  return c;
}

/**
 * Update a customer. Contact fields: when `contactEditable` (the editor saw decrypted values),
 * blank clears; otherwise only non-blank values overwrite (masked editors can replace but not read).
 */
export async function updateCustomer(actor: Actor, id: string, input: CustomerInput, opts: { contactEditable: boolean }) {
  const existing = await prisma.customer.findFirst({ where: { id, ...liveWhere(actor.orgId) } });
  if (!existing) throw new NotFoundError('顧客が見つかりません');
  if (input.phone && !normalizePhone(input.phone)) throw new AppError('電話番号の形式が正しくありません');
  if (input.email && !normalizeEmail(input.email)) throw new AppError('メールアドレスの形式が正しくありません');
  await validateRefs(actor.orgId, input);
  const contact: { phone?: string | null; email?: string | null; address?: string | null } = {};
  for (const k of ['phone', 'email', 'address'] as const) {
    const v = input[k]?.trim() || null;
    if (opts.contactEditable) contact[k] = v;
    else if (v) contact[k] = v;
  }
  const c = await prisma.customer.update({
    where: { id },
    data: {
      lastName: input.lastName, firstName: input.firstName,
      lastNameKana: storeKana(input.lastNameKana), firstNameKana: storeKana(input.firstNameKana),
      ...piiColumns(contact),
      birthday: input.birthday || null, gender: input.gender || null, notes: input.notes || null,
      assignedStaffId: input.assignedStaffId || null, primaryShopId: input.primaryShopId || null,
      lineOptIn: input.lineOptIn, emailOptIn: input.emailOptIn, favorite: input.favorite,
    },
  });
  await audit({ orgId: actor.orgId, userId: actor.userId }, 'customer.update', 'Customer', id, { contactChanged: Object.keys(contact) });
  return c;
}

export async function getLiveCustomer(orgId: string, id: string) {
  const c = await prisma.customer.findFirst({ where: { id, ...liveWhere(orgId) } });
  if (!c) throw new NotFoundError('顧客が見つかりません');
  return c;
}

export async function setFavorite(actor: Actor, id: string, favorite: boolean) {
  await getLiveCustomer(actor.orgId, id);
  await prisma.customer.update({ where: { id }, data: { favorite } });
}

export async function softDeleteCustomer(actor: Actor, id: string, reason: string) {
  const c = await getLiveCustomer(actor.orgId, id);
  await prisma.customer.update({ where: { id }, data: { deletedAt: new Date() } });
  await audit({ orgId: actor.orgId, userId: actor.userId }, 'customer.delete', 'Customer', id, { reason, name: fullName(c) });
}

// ───────────────────────── Tags / identities / points ─────────────────────────

const HEX = /^#[0-9a-fA-F]{6}$/;

export async function addTag(actor: Actor, customerId: string, tag: { tagId?: string | null; name?: string | null; color?: string | null }) {
  await getLiveCustomer(actor.orgId, customerId);
  let tagId = tag.tagId ?? null;
  if (tagId) {
    const t = await prisma.tag.findFirst({ where: { id: tagId, organizationId: actor.orgId } });
    if (!t) throw new NotFoundError('タグが見つかりません');
  } else {
    const name = (tag.name ?? '').normalize('NFKC').trim();
    if (!name) throw new AppError('タグ名を入力してください');
    if (name.length > 30) throw new AppError('タグ名は30文字以内で入力してください');
    const color = tag.color && HEX.test(tag.color) ? tag.color : '#4d6fff';
    const t = await prisma.tag.upsert({
      where: { organizationId_name: { organizationId: actor.orgId, name } },
      create: { organizationId: actor.orgId, name, color }, update: {},
    });
    tagId = t.id;
  }
  await prisma.customerTag.upsert({ where: { customerId_tagId: { customerId, tagId } }, create: { customerId, tagId }, update: {} });
  return tagId;
}

export async function removeTag(actor: Actor, customerId: string, tagId: string) {
  await getLiveCustomer(actor.orgId, customerId);
  await prisma.customerTag.deleteMany({ where: { customerId, tagId, tag: { organizationId: actor.orgId } } });
}

export async function unlinkIdentity(actor: Actor, customerId: string, identityId: string) {
  const ident = await prisma.customerIdentity.findFirst({ where: { id: identityId, customerId, organizationId: actor.orgId } });
  if (!ident) throw new NotFoundError('連携情報が見つかりません');
  await prisma.customerIdentity.delete({ where: { id: ident.id } });
  await audit({ orgId: actor.orgId, userId: actor.userId }, 'customer.identity.unlink', 'Customer', customerId, { provider: ident.provider, identityId: ident.id });
}

export async function adjustPoints(actor: Actor, customerId: string, delta: number, reason: string) {
  if (!Number.isInteger(delta) || delta === 0) throw new AppError('ポイント数を入力してください');
  if (Math.abs(delta) > 1_000_000) throw new AppError('ポイント数が大きすぎます');
  const r = reason.trim();
  if (!r) throw new AppError('理由を入力してください');
  await getLiveCustomer(actor.orgId, customerId);
  return prisma.$transaction(async (tx) => {
    // serialize concurrent adjustments per customer
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`points:${customerId}`}))`;
    const bal = await pointsBalance(customerId, tx);
    if (bal + delta < 0) throw new AppError(`ポイント残高（${bal}pt）を超えて減算できません`);
    const row = await tx.pointLedger.create({ data: { organizationId: actor.orgId, customerId, delta, reason: `手動調整: ${r}` } });
    await audit({ orgId: actor.orgId, userId: actor.userId }, 'customer.points.adjust', 'Customer', customerId, { delta, reason: r, balanceAfter: bal + delta }, tx);
    return { balance: bal + delta, id: row.id };
  });
}

// ───────────────────────── Detail: stats + timeline ─────────────────────────

export async function customerDetailStats(orgId: string, customerId: string, now = Date.now()) {
  const [txs, noShow, cancel, points, c] = await Promise.all([
    prisma.transaction.findMany({ where: { customerId, organizationId: orgId, status: { in: [...VISIT_TX_STATUSES] } }, select: { paidAt: true, createdAt: true, total: true, refundedTotal: true } }),
    prisma.appointment.count({ where: { customerId, organizationId: orgId, status: 'NO_SHOW' } }),
    prisma.appointment.count({ where: { customerId, organizationId: orgId, status: 'CANCELLED' } }),
    pointsBalance(customerId),
    prisma.customer.findFirstOrThrow({ where: { id: customerId, organizationId: orgId }, select: { visitCount: true, firstVisitAt: true, lastVisitAt: true } }),
  ]);
  const s = visitStats(txs.map((t) => ({ at: t.paidAt ?? t.createdAt, amount: t.total - t.refundedTotal })));
  // Fall back to denormalized stats when no transactions (e.g. imported history).
  const useDenorm = s.visitCount === 0 && c.visitCount > 0;
  const lc = useDenorm ? customerLifecycle(c, now) : lifecycle(s, now);
  return {
    visitCount: useDenorm ? c.visitCount : s.visitCount,
    ltv: s.ltv, avgSpend: s.avgSpend,
    avgIntervalDays: useDenorm ? avgIntervalDays(c) : s.avgIntervalDays,
    lastVisitAt: useDenorm ? c.lastVisitAt : s.lastVisitAt ? new Date(s.lastVisitAt) : null,
    firstVisitAt: useDenorm ? c.firstVisitAt : s.firstVisitAt ? new Date(s.firstVisitAt) : null,
    lifecycle: lc, noShowCount: noShow, cancelCount: cancel, points,
  };
}

export type TimelineKind = 'appointment' | 'transaction' | 'karte' | 'message' | 'counseling' | 'review';
export interface TimelineItem {
  id: string; kind: TimelineKind; at: Date; title: string; detail?: string | null; href?: string;
  badges?: { label: string; tone: 'blue' | 'green' | 'amber' | 'red' | 'violet' | 'gray' }[];
}


type BadgeTone = 'blue' | 'green' | 'amber' | 'red' | 'violet' | 'gray';
const APPT_STATUS: Record<string, [string, BadgeTone]> = {
  REQUESTED: ['リクエスト', 'amber'], CONFIRMED: ['確定', 'blue'], ARRIVED: ['来店', 'green'], IN_SERVICE: ['施術中', 'blue'],
  COMPLETED: ['完了', 'green'], CANCELLED: ['キャンセル', 'gray'], NO_SHOW: ['無断キャンセル', 'red'],
};
const SOURCE: Record<string, string> = {
  STAFF: '店頭', WEB: 'ネット予約', LINE: 'LINE', PHONE: '電話', INSTAGRAM: 'Instagram', GOOGLE: 'Google', HOTPEPPER: '外部予約', MINIMO: '外部予約', RAKUTEN: '外部予約', OTHER: 'その他',
};
const TX_STATUS: Record<string, [string, 'green' | 'amber' | 'red' | 'gray']> = {
  DRAFT: ['下書き', 'gray'], PAID: ['支払済', 'green'], PARTIALLY_REFUNDED: ['一部返金', 'amber'], REFUNDED: ['返金済', 'red'], VOID: ['取消', 'gray'],
};

export async function customerTimeline(orgId: string, customerId: string, limit = 60): Promise<TimelineItem[]> {
  const where = { organizationId: orgId, customerId };
  const [appts, txs, kartes, msgs, counsel, reviews] = await Promise.all([
    prisma.appointment.findMany({ where, orderBy: { startAt: 'desc' }, take: limit, include: { menus: true, shop: { select: { name: true } } } }),
    prisma.transaction.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit, include: { items: { select: { name: true } } } }),
    prisma.karte.findMany({ where, orderBy: { visitDate: 'desc' }, take: limit, select: { id: true, visitDate: true, treatmentNote: true, shareEnabled: true, _count: { select: { photos: true } } } }),
    prisma.message.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit, select: { id: true, createdAt: true, direction: true, channel: true, body: true, status: true } }),
    prisma.counselingResponse.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit, include: { form: { select: { name: true } } } }),
    prisma.review.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit, select: { id: true, createdAt: true, rating: true, title: true, body: true } }),
  ]);
  const staffIds = [...new Set(appts.map((a) => a.staffId).filter(Boolean) as string[])];
  const staff = staffIds.length ? await prisma.membership.findMany({ where: { organizationId: orgId, userId: { in: staffIds } }, select: { userId: true, displayName: true } }) : [];
  const staffName = new Map(staff.map((s) => [s.userId, s.displayName]));
  const out: TimelineItem[] = [];
  for (const a of appts) {
    const [label, tone] = APPT_STATUS[a.status] ?? [a.status, 'gray'];
    out.push({
      id: `a-${a.id}`, kind: 'appointment', at: a.startAt,
      title: `予約 ${a.menus.map((m) => m.name).join('・') || a.title || (a.kind === 'CONSULTATION' ? 'ご相談' : 'メニュー未設定')}`,
      detail: [a.shop.name, a.staffId ? `担当: ${staffName.get(a.staffId) ?? '—'}` : '指名なし', a.cancelReason ? `理由: ${a.cancelReason}` : null].filter(Boolean).join(' / '),
      badges: [{ label, tone }, { label: SOURCE[a.source] ?? a.source, tone: 'gray' }],
      href: `/reservations?appt=${a.id}`,
    });
  }
  for (const t of txs) {
    const [label, tone] = TX_STATUS[t.status] ?? [t.status, 'gray'];
    out.push({
      id: `t-${t.id}`, kind: 'transaction', at: t.paidAt ?? t.createdAt,
      title: `会計 ¥${(t.total - t.refundedTotal).toLocaleString('ja-JP')}`,
      detail: t.items.map((i) => i.name).join('・') || null, badges: [{ label, tone }], href: `/pos/transactions/${t.id}`,
    });
  }
  for (const k of kartes) {
    out.push({
      id: `k-${k.id}`, kind: 'karte', at: k.visitDate, title: 'カルテ', detail: k.treatmentNote?.slice(0, 80) ?? null, href: `/karte/${k.id}`,
      badges: [...(k._count.photos ? [{ label: `写真${k._count.photos}`, tone: 'violet' as const }] : []), ...(k.shareEnabled ? [{ label: '共有中', tone: 'green' as const }] : [])],
    });
  }
  for (const m of msgs) {
    out.push({
      id: `m-${m.id}`, kind: 'message', at: m.createdAt, title: m.direction === 'INBOUND' ? `受信メッセージ（${m.channel}）` : `送信メッセージ（${m.channel}）`,
      detail: m.body.slice(0, 100), badges: [{ label: m.status, tone: m.status === 'FAILED' ? 'red' : m.status === 'SKIPPED' ? 'amber' : 'gray' }],
      href: `/messages?customerId=${customerId}`,
    });
  }
  for (const r of counsel) {
    out.push({
      id: `c-${r.id}`, kind: 'counseling', at: r.submittedAt ?? r.createdAt, title: `カウンセリング「${r.form.name}」`,
      badges: [{ label: r.status === 'SUBMITTED' ? '回答済' : '未回答', tone: r.status === 'SUBMITTED' ? 'green' : 'amber' }],
      href: `/customers/${customerId}?tab=counseling`,
    });
  }
  for (const r of reviews) {
    out.push({ id: `r-${r.id}`, kind: 'review', at: r.createdAt, title: `口コミ ${'★'.repeat(r.rating)}`, detail: r.title ?? r.body?.slice(0, 80) ?? null, href: '/reviews' });
  }
  return out.sort((a, b) => b.at.getTime() - a.at.getTime());
}

// ───────────────────────── Duplicates ─────────────────────────

export async function duplicateCandidates(orgId: string, minScore = 55): Promise<DuplicatePair[]> {
  const records = await prisma.customer.findMany({
    where: liveWhere(orgId),
    select: { id: true, phoneHash: true, emailHash: true, lastName: true, firstName: true, lastNameKana: true, firstNameKana: true, birthday: true },
  });
  return findDuplicates(records, minScore);
}

// ───────────────────────── CSV export ─────────────────────────

export const EXPORT_HEADER = ['顧客ID', '姓', '名', 'セイ', 'メイ', '電話', 'メール', '住所', '誕生日', '性別', '来店回数', '累計売上', '初回来店', '最終来店', '担当', 'タグ', 'お気に入り', 'LINE配信', 'メール配信', 'メモ', '登録日'];

function ymd(d: Date | null) { return d ? new Date(d.getTime() + 9 * 3600000).toISOString().slice(0, 10) : ''; }

export async function exportCustomersCsv(ctx: StaffContext, q: CustomerQuery): Promise<{ csv: string; count: number }> {
  if (!ctx.can('customer.export')) throw new ForbiddenError();
  const access = await piiAccess(ctx);
  if (!access.canView) throw new ForbiddenError('個人情報のロック解除が必要です（顧客詳細の「ロック解除」から一時解除できます）');
  const { where } = customerWhere(ctx.org.id, q);
  let finalWhere = where;
  if (q.lifecycle) {
    const all = await prisma.customer.findMany({ where, select: { id: true, visitCount: true, firstVisitAt: true, lastVisitAt: true } });
    finalWhere = { AND: [where, { id: { in: all.filter((c) => customerLifecycle(c) === q.lifecycle).map((c) => c.id) } }] };
  }
  const rows = await prisma.customer.findMany({
    where: finalWhere, orderBy: orderBy(q.sort), take: 50000,
    include: { tags: { include: { tag: { select: { name: true } } } } },
  });
  const staff = await prisma.membership.findMany({ where: { organizationId: ctx.org.id }, select: { userId: true, displayName: true } });
  const staffName = new Map(staff.map((s) => [s.userId, s.displayName]));
  const csv = toCsv(EXPORT_HEADER, rows.map((c) => [
    c.id, c.lastName, c.firstName, c.lastNameKana, c.firstNameKana, decryptField(c.phoneEnc), decryptField(c.emailEnc), decryptField(c.addressEnc),
    c.birthday, c.gender, c.visitCount, c.totalSales, ymd(c.firstVisitAt), ymd(c.lastVisitAt),
    c.assignedStaffId ? staffName.get(c.assignedStaffId) ?? '' : '', c.tags.map((t) => t.tag.name).join(';'),
    c.favorite ? '1' : '', c.lineOptIn ? '1' : '0', c.emailOptIn ? '1' : '0', c.notes, ymd(c.createdAt),
  ]));
  await audit(ctx, 'customer.export', 'Customer', null, { count: rows.length, via: access.via, filters: { ...q, page: undefined, perPage: undefined } });
  return { csv, count: rows.length };
}

// ───────────────────────── CSV import ─────────────────────────

export const IMPORT_FIELDS = {
  lastName: '姓', firstName: '名', fullName: '氏名（姓名まとめて）', lastNameKana: 'セイ', firstNameKana: 'メイ', fullKana: 'フリガナ（まとめて）',
  phone: '電話', email: 'メール', birthday: '誕生日', gender: '性別', address: '住所', notes: 'メモ', tags: 'タグ',
} as const;
export type ImportField = keyof typeof IMPORT_FIELDS;
export type ImportRow = Partial<Record<ImportField, string>>;
export type ImportMode = 'skip' | 'update';
export const MAX_IMPORT_ROWS = 5000;

export interface ImportRowResult { row: number; action: 'create' | 'update' | 'skip' | 'error'; name: string; message?: string; customerId?: string; matchedBy?: 'phone' | 'email' }
export interface ImportReport { created: number; updated: number; skipped: number; errors: number; rows: ImportRowResult[]; dryRun: boolean }

function splitTags(s: string | undefined): string[] {
  if (!s) return [];
  return [...new Set(s.normalize('NFKC').split(/[;|、,／/]+/).map((t) => t.trim()).filter(Boolean).map((t) => t.slice(0, 30)))];
}

function splitFull(s: string): [string, string] {
  const t = s.normalize('NFKC').trim().replace(/\s+/g, ' ');
  const i = t.indexOf(' ');
  return i < 0 ? [t, ''] : [t.slice(0, i), t.slice(i + 1)];
}

/**
 * Import customers with blind-index dedupe (phone first, then email), including duplicates
 * within the file itself. mode=skip leaves matches untouched; mode=update fills/overwrites
 * the provided non-empty columns and adds tags. dryRun computes the same report without writes.
 */
export async function importCustomers(actor: Actor & { shopId?: string | null }, input: ImportRow[], opts: { mode: ImportMode; dryRun: boolean }): Promise<ImportReport> {
  if (input.length > MAX_IMPORT_ROWS) throw new AppError(`一度に取り込めるのは${MAX_IMPORT_ROWS}行までです`);
  const existing = await prisma.customer.findMany({ where: liveWhere(actor.orgId), select: { id: true, phoneHash: true, emailHash: true, notes: true } });
  const byPhone = new Map<string, string>(), byEmail = new Map<string, string>();
  const notesById = new Map<string, string | null>();
  for (const c of existing) {
    if (c.phoneHash && !byPhone.has(c.phoneHash)) byPhone.set(c.phoneHash, c.id);
    if (c.emailHash && !byEmail.has(c.emailHash)) byEmail.set(c.emailHash, c.id);
    notesById.set(c.id, c.notes);
  }
  const tagIds = new Map((await prisma.tag.findMany({ where: { organizationId: actor.orgId }, select: { id: true, name: true } })).map((t) => [t.name, t.id]));
  const ensureTag = async (name: string) => {
    let id = tagIds.get(name);
    if (!id) {
      id = (await prisma.tag.upsert({ where: { organizationId_name: { organizationId: actor.orgId, name } }, create: { organizationId: actor.orgId, name }, update: {} })).id;
      tagIds.set(name, id);
    }
    return id;
  };

  const report: ImportReport = { created: 0, updated: 0, skipped: 0, errors: 0, rows: [], dryRun: opts.dryRun };
  for (let i = 0; i < input.length; i++) {
    const r = input[i];
    const rowNo = i + 2; // header is line 1
    const v = (k: ImportField) => (r[k] ?? '').normalize('NFKC').trim();
    let [lastName, firstName] = [v('lastName'), v('firstName')];
    if (!lastName && !firstName && v('fullName')) [lastName, firstName] = splitFull(v('fullName'));
    let [lk, fk] = [v('lastNameKana'), v('firstNameKana')];
    if (!lk && !fk && v('fullKana')) [lk, fk] = splitFull(v('fullKana'));
    const name = `${lastName} ${firstName}`.trim();
    const fail = (message: string) => { report.errors++; report.rows.push({ row: rowNo, action: 'error', name: name || '（名前なし）', message }); };
    if (!lastName) { fail('姓（または氏名）が空です'); continue; }
    if (lastName.length > 50 || firstName.length > 50) { fail('氏名が長すぎます'); continue; }
    const phoneRaw = v('phone'), emailRaw = v('email');
    const phone = phoneRaw ? normalizePhone(phoneRaw) : null;
    const email = emailRaw ? normalizeEmail(emailRaw) : null;
    if (phoneRaw && !phone) { fail(`電話番号の形式が正しくありません: ${phoneRaw}`); continue; }
    if (emailRaw && !email) { fail(`メールアドレスの形式が正しくありません: ${emailRaw}`); continue; }
    const bdRaw = v('birthday');
    const birthday = bdRaw ? normalizeBirthday(bdRaw) : null;
    if (bdRaw && !birthday) { fail(`誕生日の形式が正しくありません: ${bdRaw}`); continue; }
    const ph = phone ? phoneHash(phone) : null, em = email ? emailHash(email) : null;
    let matchId: string | undefined, matchedBy: 'phone' | 'email' | undefined;
    if (ph && byPhone.has(ph)) { matchId = byPhone.get(ph); matchedBy = 'phone'; }
    else if (em && byEmail.has(em)) { matchId = byEmail.get(em); matchedBy = 'email'; }
    const tags = splitTags(r.tags);
    const notes = v('notes') || null;

    try {
      if (matchId) {
        if (opts.mode === 'skip') {
          report.skipped++;
          report.rows.push({ row: rowNo, action: 'skip', name, matchedBy, customerId: matchId.startsWith('new:') ? undefined : matchId, message: `${matchedBy === 'phone' ? '電話番号' : 'メール'}が一致する顧客が存在します` });
          continue;
        }
        if (!opts.dryRun && !matchId.startsWith('new:')) {
          const data: Prisma.CustomerUpdateInput = { lastName, ...(firstName ? { firstName } : {}) };
          if (lk) data.lastNameKana = storeKana(lk);
          if (fk) data.firstNameKana = storeKana(fk);
          Object.assign(data, piiColumns({ ...(phone ? { phone } : {}), ...(email ? { email } : {}), ...(v('address') ? { address: v('address') } : {}) }));
          if (birthday) data.birthday = birthday;
          if (v('gender')) data.gender = v('gender');
          if (notes) {
            const prev = notesById.get(matchId) ?? null;
            if (!prev?.includes(notes)) { data.notes = prev ? `${prev}\n${notes}` : notes; notesById.set(matchId, data.notes as string); }
          }
          await prisma.customer.update({ where: { id: matchId }, data });
          for (const t of tags) {
            const tagId = await ensureTag(t);
            await prisma.customerTag.upsert({ where: { customerId_tagId: { customerId: matchId, tagId } }, create: { customerId: matchId, tagId }, update: {} });
          }
        }
        if (ph && !byPhone.has(ph)) byPhone.set(ph, matchId);
        if (em && !byEmail.has(em)) byEmail.set(em, matchId);
        report.updated++;
        report.rows.push({ row: rowNo, action: 'update', name, matchedBy, customerId: matchId.startsWith('new:') ? undefined : matchId });
        continue;
      }
      let id = `new:${i}`;
      if (!opts.dryRun) {
        const tagCreate = [];
        for (const t of tags) tagCreate.push({ tagId: await ensureTag(t) });
        const c = await prisma.customer.create({
          data: {
            organizationId: actor.orgId, primaryShopId: actor.shopId ?? null, lastName, firstName,
            lastNameKana: storeKana(lk), firstNameKana: storeKana(fk),
            ...piiColumns({ phone, email, address: v('address') || null }),
            birthday, gender: v('gender') || null, notes,
            tags: tagCreate.length ? { create: tagCreate } : undefined,
          },
        });
        id = c.id;
      }
      if (ph) byPhone.set(ph, id);
      if (em) byEmail.set(em, id);
      notesById.set(id, notes);
      report.created++;
      report.rows.push({ row: rowNo, action: 'create', name, customerId: id.startsWith('new:') ? undefined : id });
    } catch (e) {
      console.error('[import]', e);
      fail('保存に失敗しました');
    }
  }
  if (!opts.dryRun) {
    await audit({ orgId: actor.orgId, userId: actor.userId }, 'customer.import', 'Customer', null, {
      mode: opts.mode, total: input.length, created: report.created, updated: report.updated, skipped: report.skipped, errors: report.errors,
    });
  }
  return report;
}

// ───────────────────────── Lookups for forms ─────────────────────────

export async function staffOptions(orgId: string) {
  return prisma.membership.findMany({
    where: { organizationId: orgId, active: true }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    select: { userId: true, displayName: true, role: true },
  });
}

export async function tagOptions(orgId: string) {
  return prisma.tag.findMany({ where: { organizationId: orgId }, orderBy: { name: 'asc' }, select: { id: true, name: true, color: true } });
}

/** Parse list/export URL params into a CustomerQuery. */
export function parseCustomerQuery(sp: Record<string, string | string[] | undefined> | URLSearchParams): CustomerQuery {
  const get = (k: string) => {
    const v = sp instanceof URLSearchParams ? sp.get(k) : sp[k];
    return (Array.isArray(v) ? v[0] : v) ?? null;
  };
  const sort = get('sort');
  const lc = get('lc');
  const page = Number(get('page') ?? 1);
  return {
    q: get('q')?.slice(0, 100) ?? null,
    tagId: get('tag'), staffId: get('staff'), shopId: get('shop'),
    lifecycle: lc && (LIFECYCLES as readonly string[]).includes(lc) ? (lc as Lifecycle) : null,
    favorite: get('fav') === '1',
    sort: sort && (SORTS as readonly string[]).includes(sort) ? (sort as CustomerSort) : 'lastVisit',
    page: Number.isFinite(page) && page > 0 ? Math.floor(page) : 1,
  };
}
