// Messaging domain services: conversation variables, segment recipients,
// broadcast execution and delivery retry. All sends go through notify.ts
// (sendCustomerMessage / provider helpers) so opt-outs and the delivery log apply.
import { Prisma, type MessageChannel } from '@salonos/db';
import { matchesSegment, renderTemplate, jaWeekday, minutesToHHMM, toLocalParts, type RoleName, type Segment } from '@salonos/core';
import { prisma } from './db';
import { env } from './env';
import { AppError, ForbiddenError, NotFoundError } from './errors';
import { linePush, resolveChannel, sendCustomerMessage, sendEmail } from './notify';
import { signLineLink } from './line-link';

export const ACTIVE_APPT_STATUSES = ['REQUESTED', 'CONFIRMED', 'ARRIVED', 'IN_SERVICE'] as const;

// ───────────────────────── Segment ─────────────────────────

function optInt(v: unknown, min = 0, max = 100000): number | undefined {
  if (v === '' || v === null || v === undefined) return undefined;
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return undefined;
  return Math.min(max, Math.max(min, n));
}

/** Sanitize an untrusted segment object (from forms or stored JSON). */
export function normalizeSegment(raw: unknown): Segment {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const s: Segment = {};
  const tagIds = Array.isArray(r.tagIds) ? r.tagIds.filter((t): t is string => typeof t === 'string' && t.length > 0 && t.length < 64).slice(0, 50) : [];
  if (tagIds.length) s.tagIds = tagIds;
  const min = optInt(r.lastVisitDaysMin), max = optInt(r.lastVisitDaysMax), visits = optInt(r.minVisits);
  if (min !== undefined) s.lastVisitDaysMin = min;
  if (max !== undefined) s.lastVisitDaysMax = max;
  if (visits) s.minVisits = visits;
  if (typeof r.staffId === 'string' && r.staffId) s.staffId = r.staffId;
  if (r.favorite === true || r.favorite === 'true' || r.favorite === 'on') s.favorite = true;
  if (typeof r.shopId === 'string' && r.shopId) s.shopId = r.shopId;
  return s;
}

/** Who is sending: OWNER/DIRECTOR may target the whole org, others only their own shops. */
export interface BroadcastSender { role: RoleName; shopIds: string[] }

/**
 * Validate foreign ids inside a segment belong to the org (tags, staff user, shop), and that
 * the sender may address that audience: below OWNER/DIRECTOR a shop is required and must be
 * one of the sender's shops (no org-wide broadcasts).
 */
export async function assertSegmentScope(orgId: string, s: Segment, sender: BroadcastSender) {
  if (sender.role !== 'OWNER' && sender.role !== 'DIRECTOR') {
    if (!s.shopId) throw new ForbiddenError('配信対象の店舗を選択してください（全店舗への配信はオーナー・ディレクターのみ可能です）');
    if (!sender.shopIds.includes(s.shopId)) throw new ForbiddenError('この店舗のお客様へ配信する権限がありません');
  }
  if (s.tagIds?.length) {
    const n = await prisma.tag.count({ where: { organizationId: orgId, id: { in: s.tagIds } } });
    if (n !== s.tagIds.length) throw new AppError('タグの指定が正しくありません');
  }
  if (s.staffId && !(await prisma.membership.findFirst({ where: { organizationId: orgId, userId: s.staffId } }))) throw new AppError('担当スタッフの指定が正しくありません');
  if (s.shopId && !(await prisma.shop.findFirst({ where: { organizationId: orgId, id: s.shopId } }))) throw new AppError('店舗の指定が正しくありません');
  if (s.lastVisitDaysMin !== undefined && s.lastVisitDaysMax !== undefined && s.lastVisitDaysMin > s.lastVisitDaysMax) {
    throw new AppError('最終来店日数の範囲が正しくありません（最小 ≦ 最大）');
  }
}

export interface RecipientResult {
  /** Customers who match the segment and can receive on the channel. */
  ids: string[];
  matched: number;
  optedOut: number;
  noContact: number;
}

/**
 * Evaluate a segment server-side with `matchesSegment`, then drop customers who
 * opted out of the channel or have no reachable address on it.
 */
export async function segmentRecipients(orgId: string, segment: Segment, channel: MessageChannel, now = new Date()): Promise<RecipientResult> {
  const rows = await prisma.customer.findMany({
    where: { organizationId: orgId, mergedIntoId: null, deletedAt: null },
    select: {
      id: true, lastVisitAt: true, visitCount: true, assignedStaffId: true, favorite: true, primaryShopId: true,
      lineOptIn: true, emailOptIn: true, emailEnc: true,
      tags: { select: { tagId: true } },
      identities: { where: { provider: 'LINE' }, select: { id: true }, take: 1 },
    },
    orderBy: { createdAt: 'asc' },
  });
  const t = now.getTime();
  const out: RecipientResult = { ids: [], matched: 0, optedOut: 0, noContact: 0 };
  for (const c of rows) {
    const ok = matchesSegment({
      tagIds: c.tags.map((x) => x.tagId), lastVisitAt: c.lastVisitAt ? c.lastVisitAt.getTime() : null, visitCount: c.visitCount,
      assignedStaffId: c.assignedStaffId, favorite: c.favorite, primaryShopId: c.primaryShopId,
    }, segment, t);
    if (!ok) continue;
    out.matched++;
    const hasAddr = channel === 'LINE' ? c.identities.length > 0 : channel === 'EMAIL' ? !!c.emailEnc : false;
    const optIn = channel === 'LINE' ? c.lineOptIn : channel === 'EMAIL' ? c.emailOptIn : false;
    if (!hasAddr) { out.noContact++; continue; }
    if (!optIn) { out.optedOut++; continue; }
    out.ids.push(c.id);
  }
  return out;
}

// ───────────────────────── Template variables ─────────────────────────

async function defaultShop(orgId: string, shopId?: string | null) {
  if (shopId) {
    const s = await prisma.shop.findFirst({ where: { id: shopId, organizationId: orgId } });
    if (s) return s;
  }
  return prisma.shop.findFirst({ where: { organizationId: orgId, active: true }, orderBy: { createdAt: 'asc' } });
}

export function bookingUrlFor(shopSlug: string, orgId: string, lineUserId?: string | null) {
  return `${env.appUrl}/book/${shopSlug}${lineUserId ? `?lk=${signLineLink(orgId, lineUserId)}` : ''}`;
}

/**
 * Variables for rendering a template for one customer (inbox composer, broadcasts, automations).
 * Appointment variables come from the next upcoming appointment; review_url from the latest completed one.
 */
export async function customerVars(orgId: string, customerId: string, shopId?: string | null, now = new Date()): Promise<Record<string, string>> {
  const c = await prisma.customer.findFirst({
    where: { id: customerId, organizationId: orgId },
    include: { identities: { where: { provider: 'LINE' }, take: 1 } },
  });
  if (!c) throw new NotFoundError('顧客が見つかりません');
  const shop = await defaultShop(orgId, shopId ?? c.primaryShopId);
  const tz = shop?.timezone ?? 'Asia/Tokyo';
  const [next, lastDone, staff, karte] = await Promise.all([
    prisma.appointment.findFirst({
      where: { organizationId: orgId, customerId, startAt: { gt: now }, status: { in: [...ACTIVE_APPT_STATUSES] } },
      include: { menus: true }, orderBy: { startAt: 'asc' },
    }),
    prisma.appointment.findFirst({ where: { organizationId: orgId, customerId, status: 'COMPLETED' }, orderBy: { startAt: 'desc' } }),
    c.assignedStaffId ? prisma.membership.findFirst({ where: { organizationId: orgId, userId: c.assignedStaffId } }) : null,
    prisma.karte.findFirst({ where: { organizationId: orgId, customerId, shareEnabled: true, shareToken: { not: null } }, orderBy: { visitDate: 'desc' } }),
  ]);
  const vars: Record<string, string> = {
    customer_name: `${c.lastName} ${c.firstName}`.trim(),
    shop_name: shop?.name ?? '',
    staff_name: staff?.displayName ?? '',
    booking_url: shop ? bookingUrlFor(shop.slug, orgId, c.identities[0]?.externalId) : '',
    days_since: c.lastVisitAt ? String(Math.floor((now.getTime() - c.lastVisitAt.getTime()) / 86400000)) : '',
    date: '', time: '', menu: '', manage_url: '', review_url: '', karte_url: '',
  };
  if (next) {
    const p = toLocalParts(next.startAt, tz);
    vars.date = `${p.month}/${p.day}(${jaWeekday(p.weekday)})`;
    vars.time = minutesToHHMM(p.minutes);
    vars.menu = next.menus.map((m) => m.name).join('・');
    vars.manage_url = `${env.appUrl}/booking/${next.manageToken}`;
    if (next.staffId) {
      const m = await prisma.membership.findFirst({ where: { organizationId: orgId, userId: next.staffId } });
      if (m) vars.staff_name = m.displayName;
    }
  }
  if (lastDone) vars.review_url = `${env.appUrl}/review/${lastDone.manageToken}`;
  if (karte?.shareToken) vars.karte_url = `${env.appUrl}/k/${karte.shareToken}`;
  return vars;
}

// ───────────────────────── Broadcast ─────────────────────────

export interface BroadcastRunResult { sent: number; failed: number; skipped: number; total: number }

/**
 * Atomically move a broadcast into SENDING (from DRAFT or SCHEDULED) and deliver it.
 * Returns null when another worker already claimed it.
 */
export async function startBroadcast(orgId: string, broadcastId: string, opts: { fromStatuses?: string[] } = {}): Promise<BroadcastRunResult | null> {
  const claimed = await prisma.broadcast.updateMany({
    where: { id: broadcastId, organizationId: orgId, status: { in: opts.fromStatuses ?? ['DRAFT', 'SCHEDULED'] } },
    data: { status: 'SENDING' },
  });
  if (claimed.count === 0) return null;
  return executeBroadcast(orgId, broadcastId);
}

/**
 * Deliver a SENDING broadcast. Idempotent per customer: recipients that already have a
 * message for this broadcast are skipped, so an interrupted run can be resumed safely.
 */
export async function executeBroadcast(orgId: string, broadcastId: string, now = new Date()): Promise<BroadcastRunResult> {
  const b = await prisma.broadcast.findFirst({ where: { id: broadcastId, organizationId: orgId } });
  if (!b) throw new NotFoundError('配信が見つかりません');
  if (b.status !== 'SENDING') throw new AppError('この配信は送信中ではありません');
  const segment = normalizeSegment(b.segment);
  const r = await segmentRecipients(orgId, segment, b.channel, now);
  const done = new Set((await prisma.message.findMany({ where: { organizationId: orgId, broadcastId: b.id }, select: { customerId: true } })).map((m) => m.customerId));
  const shopId = b.shopId ?? segment.shopId ?? null;
  const result: BroadcastRunResult = { sent: 0, failed: 0, skipped: 0, total: 0 };
  for (const customerId of r.ids) {
    if (done.has(customerId)) continue;
    let body: string;
    try {
      body = renderTemplate(b.body, await customerVars(orgId, customerId, shopId, now));
    } catch { continue; }
    const m = await sendCustomerMessage({
      orgId, shopId, customerId, body, channel: b.channel, broadcastId: b.id, createdById: b.createdById ?? undefined,
      subject: b.name,
    });
    done.add(customerId);
    if (m.status === 'SENT' || m.status === 'DELIVERED') result.sent++;
    else if (m.status === 'FAILED') result.failed++;
    else result.skipped++;
  }
  const total = await prisma.message.count({ where: { organizationId: orgId, broadcastId: b.id } });
  result.total = total;
  await prisma.broadcast.update({ where: { id: b.id }, data: { status: 'SENT', sentAt: new Date(), recipientCount: total } });
  return result;
}

export async function broadcastStatusCounts(orgId: string, broadcastIds: string[]) {
  if (!broadcastIds.length) return new Map<string, Record<string, number>>();
  const g = await prisma.message.groupBy({
    by: ['broadcastId', 'status'], where: { organizationId: orgId, broadcastId: { in: broadcastIds } }, _count: { _all: true },
  });
  const out = new Map<string, Record<string, number>>();
  for (const row of g) {
    const k = row.broadcastId!;
    const rec = out.get(k) ?? {};
    rec[row.status] = row._count._all;
    out.set(k, rec);
  }
  return out;
}

// ───────────────────────── Retry ─────────────────────────

/**
 * Re-attempt a FAILED outbound message in place (same delivery-log row).
 * Opt-outs are re-checked: an opted-out customer's message becomes SKIPPED.
 */
export async function retryMessage(orgId: string, messageId: string) {
  const m = await prisma.message.findFirst({ where: { id: messageId, organizationId: orgId, direction: 'OUTBOUND' } });
  if (!m) throw new NotFoundError('メッセージが見つかりません');
  if (m.status !== 'FAILED') throw new AppError('失敗したメッセージのみ再送できます');
  // Claim the row so two concurrent retries cannot double-send.
  const claimed = await prisma.message.updateMany({ where: { id: m.id, status: 'FAILED' }, data: { status: 'QUEUED' } });
  if (claimed.count === 0) throw new AppError('このメッセージは既に再送処理中です');
  const r = await resolveChannel(orgId, m.customerId, m.channel);
  if (!r?.channel) {
    return prisma.message.update({ where: { id: m.id }, data: { status: 'SKIPPED', error: '送信可能な連絡先がない、または配信停止中です' } });
  }
  const res = r.channel === 'LINE'
    ? await linePush(orgId, m.shopId, r.lineId!, m.body)
    : await sendEmail(r.email!, 'サロンからのお知らせ', m.body);
  return prisma.message.update({
    where: { id: m.id },
    data: res.ok
      ? { status: 'SENT', sentAt: new Date(), externalMessageId: res.externalId ?? null, error: res.sandbox ? 'sandbox' : null }
      : { status: 'FAILED', error: res.error ?? 'unknown error' },
  });
}

// ───────────────────────── Inbox ─────────────────────────

export interface ConversationRow {
  customerId: string; lastName: string; firstName: string; lastNameKana: string | null; firstNameKana: string | null;
  lineOptIn: boolean; emailOptIn: boolean;
  body: string; direction: 'INBOUND' | 'OUTBOUND'; status: string; channel: MessageChannel; createdAt: Date; unread: number;
}

/** Latest message per customer (DISTINCT ON), with unread inbound counts. */
export async function listConversations(orgId: string, opts: { q?: string; unreadOnly?: boolean; limit?: number } = {}): Promise<ConversationRow[]> {
  const P = Prisma;
  const q = opts.q?.normalize('NFKC').trim();
  const like = q ? `%${q.replace(/[\\%_]/g, (x) => `\\${x}`)}%` : null;
  const nameFilter = like
    ? P.sql`AND (c."lastName" || c."firstName" ILIKE ${like} OR c."lastName" || ' ' || c."firstName" ILIKE ${like} OR COALESCE(c."lastNameKana",'') || COALESCE(c."firstNameKana",'') ILIKE ${like})`
    : P.empty;
  const unreadFilter = opts.unreadOnly
    ? P.sql`AND EXISTS (SELECT 1 FROM "Message" u WHERE u."customerId" = c.id AND u."organizationId" = ${orgId} AND u.direction = 'INBOUND' AND u."readAt" IS NULL)`
    : P.empty;
  const rows = await prisma.$queryRaw<Omit<ConversationRow, 'unread'>[]>(P.sql`
    SELECT * FROM (
      SELECT DISTINCT ON (m."customerId")
        m."customerId", c."lastName", c."firstName", c."lastNameKana", c."firstNameKana", c."lineOptIn", c."emailOptIn",
        m.body, m.direction::text AS direction, m.status::text AS status, m.channel::text AS channel, m."createdAt"
      FROM "Message" m
      JOIN "Customer" c ON c.id = m."customerId"
      WHERE m."organizationId" = ${orgId} AND c."organizationId" = ${orgId} AND c."deletedAt" IS NULL
        ${nameFilter} ${unreadFilter}
      ORDER BY m."customerId", m."createdAt" DESC
    ) t ORDER BY t."createdAt" DESC LIMIT ${opts.limit ?? 100}`);
  if (!rows.length) return [];
  const unread = await prisma.message.groupBy({
    by: ['customerId'],
    where: { organizationId: orgId, direction: 'INBOUND', readAt: null, customerId: { in: rows.map((r) => r.customerId) } },
    _count: { _all: true },
  });
  const u = new Map(unread.map((x) => [x.customerId, x._count._all]));
  return rows.map((r) => ({ ...r, unread: u.get(r.customerId) ?? 0 }));
}

export async function markThreadRead(orgId: string, customerId: string) {
  await prisma.message.updateMany({ where: { organizationId: orgId, customerId, direction: 'INBOUND', readAt: null }, data: { readAt: new Date() } });
}

export type MessageWhere = Prisma.MessageWhereInput;
