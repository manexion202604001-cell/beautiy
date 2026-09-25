// Reservation ledger queries + public (no-account) booking services.
// All appointment writes go through lib/server/booking.ts (locks, conflict checks, idempotency).
// Functions here do not depend on the Next request context so they can be integration-tested.
import { z } from 'zod';
import type { AppointmentKind, AppointmentStatus, BookingSource, Coupon } from '@salonos/db';
import {
  ACTIVE_STATUSES, addDays, computeAvailability, isDateStr, localToUtc, minutesToHHMM, normalizePhone, toLocalParts, todayIn, weekdayOf,
  type Slot,
} from '@salonos/core';
import { hmacHex, safeEqual, sha256 } from '@salonos/core/crypto';
import { prisma } from './db';
import { cryptoKeys, env } from './env';
import {
  BookingError, bookableStaff, busyWindows, changeAppointmentStatus, createAppointment, createHold, dayWindow, getAvailability, updateAppointment,
  type MenuLine,
} from './booking';
import { resolveCustomer } from './customers';
import { notifyAppointment } from './appointment-notify';
import { verifyLineLink } from './line-link';
import { audit } from './audit';
import { AppError, NotFoundError } from './errors';

// ───────────────────────── Shared helpers ─────────────────────────

/** Best-effort per-instance rate limiter (use an edge/WAF limiter at scale). */
const buckets = new Map<string, { n: number; reset: number }>();
export function rateLimit(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
  const b = buckets.get(key);
  if (!b || b.reset < now) {
    buckets.set(key, { n: 1, reset: now + windowMs });
    if (buckets.size > 5000) for (const [k, v] of buckets) if (v.reset < now) buckets.delete(k);
    return true;
  }
  b.n++;
  return b.n <= limit;
}

type CouponRule = Pick<Coupon, 'discountType' | 'discountValue' | 'menuIds'>;

export function couponValidAt(c: Pick<Coupon, 'active' | 'validFrom' | 'validTo'>, now: Date): boolean {
  if (!c.active) return false;
  if (c.validFrom && c.validFrom > now) return false;
  if (c.validTo && c.validTo < now) return false;
  return true;
}

/** Discount in yen for a coupon applied to menu lines. Lines without menuId (e.g. 指名料) are never discounted. */
export function couponDiscount(c: CouponRule, lines: { menuId?: string | null; price: number }[]): number {
  const eligible = lines.filter((l) => l.menuId && (c.menuIds.length === 0 || c.menuIds.includes(l.menuId)));
  const base = eligible.reduce((s, l) => s + Math.max(0, l.price), 0);
  if (base <= 0) return 0;
  const raw = c.discountType === 'PERCENT' ? Math.floor((base * Math.min(100, Math.max(0, c.discountValue))) / 100) : Math.max(0, c.discountValue);
  return Math.min(base, raw);
}

export function couponLabel(c: CouponRule): string {
  return c.discountType === 'PERCENT' ? `${c.discountValue}%OFF` : `¥${c.discountValue.toLocaleString('ja-JP')}引き`;
}

/** Validate menu ids against a shop and turn them into priced lines (order preserved, de-duplicated). */
export async function resolveMenus(orgId: string, shopId: string, menuIds: string[], opts: { publicOnly?: boolean } = {}) {
  const ids = [...new Set(menuIds.filter(Boolean))];
  if (!ids.length) return { lines: [] as MenuLine[], durationMin: 0, consultation: false, mixed: false, gross: 0 };
  const rows = await prisma.menu.findMany({
    where: { id: { in: ids }, organizationId: orgId, shopId, active: true, ...(opts.publicOnly ? { publicBookable: true } : {}) },
  });
  if (rows.length !== ids.length) throw new AppError('選択されたメニューが見つかりません。ページを再読み込みしてください。');
  const byId = new Map(rows.map((m) => [m.id, m]));
  const menus = ids.map((id) => byId.get(id)!);
  const lines: MenuLine[] = menus.map((m) => ({ menuId: m.id, name: m.name, price: m.price, durationMin: m.durationMin }));
  const consult = menus.filter((m) => m.isConsultation).length;
  return {
    lines, durationMin: lines.reduce((s, l) => s + l.durationMin, 0), gross: lines.reduce((s, l) => s + l.price, 0),
    consultation: consult > 0, mixed: consult > 0 && consult < menus.length,
  };
}

export function bookingDuration(menuMinutes: number) {
  return Math.max(15, menuMinutes);
}

const SHOP_ROW = { id: true, organizationId: true, timezone: true, seatCount: true, slotIntervalMin: true, minNoticeMin: true, bookingHorizonDays: true } as const;

/**
 * Bookable start times for a day. Same rules as getAvailability, but can additionally ignore
 * one existing appointment (customer-side reschedule of that appointment).
 */
export async function availableSlots(q: { shopId: string; date: string; durationMin: number; staffId?: string | null; excludeHoldToken?: string; excludeAppointmentId?: string; now?: Date }): Promise<Slot[]> {
  if (!q.excludeAppointmentId) return getAvailability(q);
  const shop = await prisma.shop.findUnique({ where: { id: q.shopId }, select: SHOP_ROW });
  if (!shop) throw new NotFoundError('店舗が見つかりません');
  const now = q.now ?? new Date();
  const today = toLocalParts(now, shop.timezone).date;
  const horizon = new Date(now.getTime() + shop.bookingHorizonDays * 86400000);
  if (q.date < today || localToUtc(q.date, 0, shop.timezone) > horizon) return [];
  const day = await dayWindow(prisma, shop, q.date);
  if (!day.openWindow) return [];
  const staffIds = (await bookableStaff(shop.id)).map((s) => s.userId);
  const { seatBusy, staffBusy } = await busyWindows(prisma, shop, new Date(day.openWindow.start), new Date(day.openWindow.end), staffIds, { excludeAppointmentId: q.excludeAppointmentId, excludeHoldToken: q.excludeHoldToken });
  return computeAvailability({
    openWindow: day.openWindow, holiday: day.holiday, durationMin: q.durationMin, slotIntervalMin: shop.slotIntervalMin,
    seatCapacity: shop.seatCount, seatBusy, staff: staffIds.map((id) => ({ id, busy: staffBusy.get(id) ?? [] })),
    staffId: q.staffId ?? null, now: now.getTime(), minNoticeMin: shop.minNoticeMin,
  });
}

/** Calendar of the next `count` days with closed/holiday flags (shop-local). */
export async function bookingDays(shop: { id: string; timezone: string; bookingHorizonDays: number }, now = new Date(), cap = 62) {
  const today = todayIn(shop.timezone, now);
  const count = Math.max(1, Math.min(cap, shop.bookingHorizonDays));
  const last = addDays(today, count - 1);
  const [hours, holidays] = await Promise.all([
    prisma.businessHour.findMany({ where: { shopId: shop.id } }),
    prisma.shopHoliday.findMany({ where: { shopId: shop.id, date: { gte: today, lte: last } } }),
  ]);
  const hol = new Map(holidays.map((h) => [h.date, h.reason ?? '休業日']));
  const byWd = new Map(hours.map((h) => [h.weekday, h]));
  return Array.from({ length: count }, (_, i) => {
    const date = addDays(today, i);
    const wd = weekdayOf(date);
    const bh = byWd.get(wd);
    return { date, weekday: wd, closed: !bh || bh.closed || hol.has(date), reason: hol.get(date) ?? (!bh || bh.closed ? '定休日' : null) };
  });
}

// ───────────────────────── Staff ledger ─────────────────────────

export interface LedgerAppt {
  id: string; date: string; startMin: number; endMin: number; startAt: string; endAt: string;
  staffId: string | null; status: AppointmentStatus; kind: AppointmentKind; source: BookingSource;
  customerId: string | null; customerName: string | null; title: string | null; menus: string[];
  nominated: boolean; totalPrice: number; paid: boolean; hasKarte: boolean; hasNote: boolean;
}

export interface LedgerDay { date: string; weekday: number; openMin: number | null; closeMin: number | null; holiday: string | null }

export async function loadLedger(orgId: string, shop: { id: string; timezone: string }, from: string, days: number) {
  const tz = shop.timezone;
  const rangeStart = localToUtc(from, 0, tz), rangeEnd = localToUtc(addDays(from, days), 0, tz);
  const [appts, staff, hours, holidays] = await Promise.all([
    prisma.appointment.findMany({
      where: { organizationId: orgId, shopId: shop.id, startAt: { lt: rangeEnd }, endAt: { gt: rangeStart } },
      include: {
        customer: { select: { lastName: true, firstName: true } }, menus: { select: { name: true } },
        transaction: { select: { status: true } }, karte: { select: { id: true } },
      },
      orderBy: { startAt: 'asc' },
    }),
    bookableStaff(shop.id),
    prisma.businessHour.findMany({ where: { shopId: shop.id } }),
    prisma.shopHoliday.findMany({ where: { shopId: shop.id, date: { gte: from, lt: addDays(from, days) } } }),
  ]);
  const hol = new Map(holidays.map((h) => [h.date, h.reason ?? '休業日']));
  const byWd = new Map(hours.map((h) => [h.weekday, h]));
  const dayList: LedgerDay[] = Array.from({ length: days }, (_, i) => {
    const date = addDays(from, i);
    const bh = byWd.get(weekdayOf(date));
    const open = bh && !bh.closed;
    return { date, weekday: weekdayOf(date), openMin: open ? bh!.openMin : null, closeMin: open ? bh!.closeMin : null, holiday: hol.get(date) ?? null };
  });

  const list: LedgerAppt[] = appts.map((a) => {
    const s = toLocalParts(a.startAt, tz), e = toLocalParts(a.endAt, tz);
    // clamp multi-day blocks to the start day
    const endMin = e.date === s.date ? e.minutes : 1440;
    return {
      id: a.id, date: s.date, startMin: s.minutes, endMin: Math.max(endMin, s.minutes + 5), startAt: a.startAt.toISOString(), endAt: a.endAt.toISOString(),
      staffId: a.staffId, status: a.status, kind: a.kind, source: a.source, customerId: a.customerId,
      customerName: a.customer ? `${a.customer.lastName} ${a.customer.firstName}`.trim() : a.guestName,
      title: a.title, menus: a.menus.map((m) => m.name), nominated: a.nominated, totalPrice: a.totalPrice,
      paid: a.transaction?.status === 'PAID' || a.transaction?.status === 'PARTIALLY_REFUNDED', hasKarte: !!a.karte, hasNote: !!(a.note || a.customerNote),
    };
  });

  const columns = staff.map((m) => ({ staffId: m.userId, name: m.displayName, imageUrl: m.imageUrl }));
  const known = new Set(columns.map((c) => c.staffId));
  const extraIds = [...new Set(list.map((a) => a.staffId).filter((id): id is string => !!id && !known.has(id)))];
  if (extraIds.length) {
    const extra = await prisma.membership.findMany({ where: { organizationId: orgId, userId: { in: extraIds } } });
    for (const id of extraIds) {
      const m = extra.find((x) => x.userId === id);
      columns.push({ staffId: id, name: m?.displayName ?? '（退職・他店スタッフ）', imageUrl: m?.imageUrl ?? null });
    }
  }

  // The same staff's bookings at other shops of the org (so moves don't surprise with conflicts).
  const staffIds = columns.map((c) => c.staffId);
  const foreignRows = staffIds.length ? await prisma.appointment.findMany({
    where: { organizationId: orgId, shopId: { not: shop.id }, staffId: { in: staffIds }, status: { in: [...ACTIVE_STATUSES] }, startAt: { lt: rangeEnd }, endAt: { gt: rangeStart } },
    select: { staffId: true, startAt: true, endAt: true, shop: { select: { name: true } } },
  }) : [];
  const foreign = foreignRows.map((f) => {
    const s = toLocalParts(f.startAt, tz), e = toLocalParts(f.endAt, tz);
    return { staffId: f.staffId!, date: s.date, startMin: s.minutes, endMin: e.date === s.date ? e.minutes : 1440, shopName: f.shop.name };
  });

  return { appts: list, columns, days: dayList, foreign };
}

/** Pending online requests (REQUESTED) for the shop that still need a decision. */
export async function pendingRequests(orgId: string, shopId: string, tz: string, now = new Date()) {
  const rows = await prisma.appointment.findMany({
    where: { organizationId: orgId, shopId, status: 'REQUESTED', endAt: { gt: now } },
    include: { customer: { select: { lastName: true, firstName: true } } }, orderBy: { startAt: 'asc' }, take: 20,
  });
  return rows.map((a) => {
    const p = toLocalParts(a.startAt, tz);
    return { id: a.id, date: p.date, time: minutesToHHMM(p.minutes), name: a.customer ? `${a.customer.lastName} ${a.customer.firstName}`.trim() : a.guestName ?? 'ゲスト', source: a.source };
  });
}

// ───────────────────────── Public booking ─────────────────────────

export async function loadPublicShop(slug: string, now = new Date()) {
  const shop = await prisma.shop.findUnique({ where: { slug }, include: { organization: { select: { id: true, name: true } } } });
  if (!shop || !shop.active) return null;
  const [menus, coupons, staff, days] = await Promise.all([
    prisma.menu.findMany({ where: { shopId: shop.id, organizationId: shop.organizationId, active: true, publicBookable: true }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }),
    prisma.coupon.findMany({ where: { shopId: shop.id, organizationId: shop.organizationId, active: true, publicBookable: true }, orderBy: { createdAt: 'asc' } }),
    bookableStaff(shop.id),
    bookingDays(shop, now),
  ]);
  return {
    shop: {
      id: shop.id, orgId: shop.organizationId, name: shop.name, slug: shop.slug, phone: shop.phone, address: shop.address, timezone: shop.timezone,
      bookingMode: shop.bookingMode, bookingHorizonDays: shop.bookingHorizonDays, cancelDeadlineHours: shop.cancelDeadlineHours,
      description: shop.description, imageUrl: shop.imageUrl, accessInfo: shop.accessInfo,
    },
    menus: menus.map((m) => ({ id: m.id, category: m.category, name: m.name, description: m.description, durationMin: m.durationMin, price: m.price, isConsultation: m.isConsultation })),
    coupons: coupons.filter((c) => couponValidAt(c, now)).map((c) => ({
      id: c.id, name: c.name, description: c.description, discountType: c.discountType, discountValue: c.discountValue, menuIds: c.menuIds,
      newCustomerOnly: c.newCustomerOnly, validTo: c.validTo?.toISOString() ?? null, label: couponLabel(c),
    })),
    staff: staff.map((m) => ({ userId: m.userId, name: m.displayName, imageUrl: m.imageUrl, bio: m.publicBio, specialties: m.specialties, nominationFee: m.nominationFee })),
    days,
  };
}
export type PublicShop = NonNullable<Awaited<ReturnType<typeof loadPublicShop>>>;

// Bot guard: the page embeds a signed render timestamp; submissions faster than 3s are rejected.
const FORM_MIN_MS = 3000;
const FORM_MAX_MS = 12 * 3600_000;
function formSig(ts: string) { return hmacHex(cryptoKeys().hashKey.toString('hex'), `book-form:${ts}`).slice(0, 24); }
export function signFormToken(now = Date.now()): string {
  const ts = String(now);
  return `${ts}.${formSig(ts)}`;
}
export function checkFormToken(token: string | null | undefined, now = Date.now()): 'ok' | 'invalid' | 'too_fast' | 'expired' {
  if (!token) return 'invalid';
  const [ts, sig] = token.split('.');
  if (!ts || !sig || !/^\d+$/.test(ts) || !safeEqual(sig, formSig(ts))) return 'invalid';
  const age = now - Number(ts);
  if (age < FORM_MIN_MS) return 'too_fast';
  if (age > FORM_MAX_MS) return 'expired';
  return 'ok';
}

const idSchema = z.string().trim().min(1).max(64);

/** Resolve the online booking source from the entry link. */
export function resolveSource(orgId: string, lk: string | null | undefined, src: string | null | undefined, now = Date.now()): { source: BookingSource; lineUserId: string | null } {
  const link = verifyLineLink(lk, now);
  if (link && link.orgId === orgId) return { source: 'LINE', lineUserId: link.lineUserId };
  const s = (src ?? '').toLowerCase();
  if (s === 'instagram') return { source: 'INSTAGRAM', lineUserId: null };
  if (s === 'google') return { source: 'GOOGLE', lineUserId: null };
  return { source: 'WEB', lineUserId: null };
}

export const holdSchema = z.object({
  shopSlug: z.string().trim().min(1).max(80),
  menuIds: z.array(idSchema).min(1, 'メニューを選択してください').max(10),
  staffId: idSchema.nullable().optional(),
  startAt: z.string().datetime({ offset: true }),
  previousToken: z.string().max(80).nullable().optional(),
});

async function publicShopRow(slug: string) {
  const shop = await prisma.shop.findUnique({ where: { slug } });
  if (!shop || !shop.active) throw new NotFoundError('店舗が見つかりません');
  return shop;
}

async function assertBookableStaff(shopId: string, staffId: string | null | undefined) {
  if (!staffId) return null;
  const m = (await bookableStaff(shopId)).find((s) => s.userId === staffId);
  if (!m) throw new AppError('選択されたスタッフは現在ネット予約を受け付けていません');
  return m;
}

/** Place a 10-minute hold on a slot the customer picked (verifies it is still offered). */
export async function publicHold(raw: z.input<typeof holdSchema>, now = new Date()) {
  const input = holdSchema.parse(raw);
  const shop = await publicShopRow(input.shopSlug);
  const menus = await resolveMenus(shop.organizationId, shop.id, input.menuIds, { publicOnly: true });
  await assertBookableStaff(shop.id, input.staffId);
  const startAt = new Date(input.startAt);
  const date = toLocalParts(startAt, shop.timezone).date;
  const duration = bookingDuration(menus.durationMin);
  const prev = input.previousToken ? await prisma.slotHold.findUnique({ where: { token: input.previousToken } }) : null;
  const prevToken = prev && prev.shopId === shop.id ? prev.token : undefined;
  const slots = await getAvailability({ shopId: shop.id, date, durationMin: duration, staffId: input.staffId ?? null, excludeHoldToken: prevToken, now });
  const slot = slots.find((s) => s.start === startAt.getTime());
  if (!slot) throw new BookingError('STAFF_CONFLICT');
  if (prevToken) await prisma.slotHold.deleteMany({ where: { token: prevToken } });
  // 指名なし: also reserve one free stylist so the slot can't be lost to a nominated booking.
  const holdStaff = input.staffId ?? slot.staffIds[0] ?? null;
  return createHold(shop.id, holdStaff, startAt, new Date(slot.end), now);
}

export async function releaseHold(token: string | null | undefined) {
  if (!token) return;
  await prisma.slotHold.deleteMany({ where: { token } });
}

/**
 * Public bookings must start on a slot the booking page offers: on the shop's slot grid,
 * within bookingHorizonDays, after the minimum notice, with capacity, and (when a stylist
 * was chosen) with that stylist free. The customer's own hold is ignored so a held slot
 * still counts as free.
 */
async function assertOfferedSlot(
  shop: { id: string; organizationId: string; timezone: string; seatCount: number; slotIntervalMin: number; minNoticeMin: number; bookingHorizonDays: number },
  startAt: Date, endAt: Date, staffId: string | null, holdToken: string | null, now: Date,
) {
  const date = toLocalParts(startAt, shop.timezone).date;
  const durationMin = Math.round((endAt.getTime() - startAt.getTime()) / 60000);
  const slots = await getAvailability({ shopId: shop.id, date, durationMin, staffId, excludeHoldToken: holdToken ?? undefined, now });
  const slot = slots.find((s) => s.start === startAt.getTime());
  if (slot && (!staffId || slot.staffIds.includes(staffId))) return;
  // Friendlier reason when the time is simply outside the day's opening hours.
  const day = await dayWindow(prisma, shop, date);
  if (day.openWindow && !day.holiday && (startAt.getTime() < day.openWindow.start || endAt.getTime() > day.openWindow.end)) throw new BookingError('OUTSIDE_HOURS');
  throw new BookingError('STAFF_CONFLICT');
}

const kanaRe = /^[\p{Script=Katakana}\p{Script=Hiragana}ー\s・ｰ　]+$/u;

export const publicBookingSchema = z.object({
  shopSlug: z.string().trim().min(1).max(80),
  menuIds: z.array(idSchema).min(1, 'メニューを選択してください').max(10),
  couponId: idSchema.nullable().optional(),
  staffId: idSchema.nullable().optional(),
  startAt: z.string().datetime({ offset: true }),
  holdToken: z.string().max(80).nullable().optional(),
  name: z.string().trim().min(1, 'お名前を入力してください').max(60, 'お名前が長すぎます'),
  kana: z.string().trim().min(1, 'フリガナを入力してください').max(60, 'フリガナが長すぎます').regex(kanaRe, 'フリガナはカタカナまたはひらがなで入力してください'),
  phone: z.string().trim().min(1, '電話番号を入力してください').max(30).refine((v) => !!normalizePhone(v), '電話番号の形式が正しくありません'),
  email: z.union([z.literal(''), z.string().trim().max(200).email('メールアドレスの形式が正しくありません')]).optional(),
  note: z.string().trim().max(500, 'ご要望は500文字以内で入力してください').optional(),
  consent: z.literal(true, { errorMap: () => ({ message: 'プライバシーポリシーへの同意が必要です' }) }),
  idempotencyKey: z.string().min(8).max(80),
  formToken: z.string().max(100),
  website: z.string().max(200).optional(),
  lk: z.string().max(1000).nullable().optional(),
  src: z.string().max(20).nullable().optional(),
});
export type PublicBookingInput = z.input<typeof publicBookingSchema>;

export interface PublicBookingResult { appointmentId: string; manageToken: string; status: AppointmentStatus; replay: boolean }

/**
 * Public, account-less booking. Re-validates everything server-side: menus/coupon/staff are
 * loaded from the DB (client prices are never trusted), the slot is re-checked under lock
 * by createAppointment with enforceHours, and the customer is resolved before the appointment.
 */
export async function publicBook(raw: PublicBookingInput, opts: { now?: Date } = {}): Promise<PublicBookingResult> {
  const now = opts.now ?? new Date();
  if (raw && typeof raw === 'object' && raw.website) throw new AppError('送信内容を確認できませんでした。お手数ですが再度お試しください。');
  const input = publicBookingSchema.parse(raw);
  const guard = checkFormToken(input.formToken, now.getTime());
  if (guard === 'too_fast' || guard === 'invalid') throw new AppError('送信内容を確認できませんでした。お手数ですが再度お試しください。');
  if (guard === 'expired') throw new AppError('ページの有効期限が切れました。再読み込みしてからご予約ください。');

  const shop = await publicShopRow(input.shopSlug);
  const orgId = shop.organizationId;
  const menus = await resolveMenus(orgId, shop.id, input.menuIds, { publicOnly: true });
  if (menus.mixed) throw new AppError('相談予約は他のメニューと同時に選択できません');
  const staff = await assertBookableStaff(shop.id, input.staffId);
  const lines: MenuLine[] = [...menus.lines];
  if (staff && staff.nominationFee > 0) lines.push({ menuId: null, name: '指名料', price: staff.nominationFee, durationMin: 0 });

  let discount = 0;
  let coupon: Coupon | null = null;
  if (input.couponId) {
    coupon = await prisma.coupon.findFirst({ where: { id: input.couponId, shopId: shop.id, organizationId: orgId, publicBookable: true } });
    if (!coupon || !couponValidAt(coupon, now)) throw new AppError('選択されたクーポンは現在ご利用いただけません');
    discount = couponDiscount(coupon, lines);
    if (discount <= 0 && coupon.discountValue > 0) throw new AppError('クーポンの対象メニューを選択してください');
  }

  const startAt = new Date(input.startAt);
  const endAt = new Date(startAt.getTime() + bookingDuration(menus.durationMin) * 60000);
  let holdToken: string | null = null;
  if (input.holdToken) {
    const hold = await prisma.slotHold.findUnique({ where: { token: input.holdToken } });
    if (hold && hold.shopId === shop.id && hold.startAt.getTime() === startAt.getTime() && hold.expiresAt > now) holdToken = hold.token;
  }

  const phone = normalizePhone(input.phone)!;
  // Namespaced + bound to the phone so a replayed key can't reveal someone else's booking.
  const idempotencyKey = `pub:${sha256(`${input.idempotencyKey}:${phone}`).slice(0, 48)}`;
  const replayOf = await prisma.appointment.findUnique({ where: { organizationId_idempotencyKey: { organizationId: orgId, idempotencyKey } }, select: { id: true } });
  // Only times the booking page actually offers are accepted (slot grid, horizon, notice,
  // capacity and the chosen stylist); anything else is reported as a taken slot. A replay of
  // an already-created booking skips this (its own appointment now occupies the slot).
  if (!replayOf) await assertOfferedSlot(shop, startAt, endAt, staff?.userId ?? null, holdToken, now);

  const { source, lineUserId } = resolveSource(orgId, input.lk, input.src, now.getTime());
  // Phone/email typed into a public form are unverified: they only attach the booking to an
  // existing customer when the submitted name matches too (see resolveCustomer). A verified
  // LINE identity that is already linked remains authoritative.
  const { customerId } = await prisma.$transaction((tx) => resolveCustomer(tx, {
    orgId, shopId: shop.id, name: input.name, kana: input.kana, phone, email: input.email || null,
    identity: lineUserId ? { provider: 'LINE', externalId: lineUserId } : null,
    requireNameMatch: true,
  }));

  if (coupon?.newCustomerOnly) {
    const prior = await prisma.appointment.count({ where: { organizationId: orgId, customerId, status: { in: ['COMPLETED', 'ARRIVED', 'IN_SERVICE'] } } });
    const c = await prisma.customer.findUnique({ where: { id: customerId }, select: { visitCount: true } });
    if (prior > 0 || (c?.visitCount ?? 0) > 0) throw new AppError('このクーポンは初めてご来店の方限定です。クーポンを外してご予約ください。');
  }

  const status: AppointmentStatus = shop.bookingMode === 'REQUEST' ? 'REQUESTED' : 'CONFIRMED';
  const base = {
    orgId, shopId: shop.id, customerId, staffId: staff?.userId ?? null, autoAssignStaff: !staff, nominated: !!staff,
    startAt, endAt, menus: lines, kind: (menus.consultation ? 'CONSULTATION' : 'NORMAL') as AppointmentKind,
    source, status, customerNote: input.note || null, couponId: coupon?.id ?? null, discount,
    // What the customer typed. Public pages render only this, never the matched record's name.
    guestName: input.name, guestPhone: phone,
    idempotencyKey,
    enforceHours: true, now,
  };
  let result;
  try {
    result = await createAppointment({ ...base, holdToken });
  } catch (e) {
    // Hold lapsed between the check and the lock: the slot may still be free, retry without it.
    if (e instanceof BookingError && e.reason === 'HOLD_EXPIRED') result = await createAppointment({ ...base, holdToken: null });
    else throw e;
  }
  const appt = await prisma.appointment.findUniqueOrThrow({ where: { id: result.appointmentId }, select: { id: true, manageToken: true, status: true, customerId: true } });
  if (result.idempotentReplay && appt.customerId !== customerId) throw new AppError('重複した予約リクエストです。ページを再読み込みしてください。');
  if (!result.idempotentReplay) await notifyAppointment(appt.id, status === 'REQUESTED' ? 'REQUESTED' : 'BOOKED');
  return { appointmentId: appt.id, manageToken: appt.manageToken, status: appt.status, replay: result.idempotentReplay };
}

// ───────────────────────── Customer change / cancel (manage URL) ─────────────────────────

export async function loadManagedAppointment(token: string) {
  if (!token || token.length > 80) return null;
  const a = await prisma.appointment.findUnique({
    where: { manageToken: token },
    // Public page: the matched customer record (name, contact) is never loaded — only what
    // the booker typed (guestName) is shown.
    include: { shop: true, menus: true },
  });
  if (!a) return null;
  const staff = a.staffId ? await prisma.membership.findFirst({ where: { organizationId: a.organizationId, userId: a.staffId }, select: { displayName: true } }) : null;
  return { ...a, staffName: staff?.displayName ?? null };
}
export type ManagedAppointment = NonNullable<Awaited<ReturnType<typeof loadManagedAppointment>>>;

export function cancelDeadline(a: { startAt: Date }, shop: { cancelDeadlineHours: number }): Date {
  return new Date(a.startAt.getTime() - shop.cancelDeadlineHours * 3600_000);
}

export type ModifyCheck = { ok: true } | { ok: false; reason: 'CLOSED_STATUS' | 'PAST_DEADLINE' | 'PRIVATE' };

export function customerCanModify(a: { status: AppointmentStatus; kind: AppointmentKind; startAt: Date }, shop: { cancelDeadlineHours: number }, now = new Date()): ModifyCheck {
  if (a.kind === 'PRIVATE') return { ok: false, reason: 'PRIVATE' };
  if (a.status !== 'CONFIRMED' && a.status !== 'REQUESTED') return { ok: false, reason: 'CLOSED_STATUS' };
  if (now > cancelDeadline(a, shop)) return { ok: false, reason: 'PAST_DEADLINE' };
  return { ok: true };
}

function modifyError(r: ModifyCheck, shop: { phone: string | null; cancelDeadlineHours: number }): AppError {
  if (!r.ok && r.reason === 'PAST_DEADLINE') {
    return new AppError(`オンラインでの変更・キャンセル期限（ご予約の${shop.cancelDeadlineHours}時間前）を過ぎています。${shop.phone ? `お手数ですがお電話（${shop.phone}）でご連絡ください。` : 'お手数ですが店舗へ直接ご連絡ください。'}`);
  }
  return new AppError('このご予約は変更・キャンセルできません');
}

export async function publicCancel(token: string, reason: string | null | undefined, now = new Date()) {
  const a = await loadManagedAppointment(token);
  if (!a) throw new NotFoundError('ご予約が見つかりません');
  const check = customerCanModify(a, a.shop, now);
  if (!check.ok) throw modifyError(check, a.shop);
  const note = (reason ?? '').trim().slice(0, 300);
  await changeAppointmentStatus(a.organizationId, a.id, 'CANCELLED', { reason: note ? `お客様によるキャンセル：${note}` : 'お客様によるキャンセル' });
  await audit({ orgId: a.organizationId, userId: null }, 'appointment.cancel', 'Appointment', a.id, { by: 'customer', reason: note || null });
  await notifyAppointment(a.id, 'CANCELLED');
  return { id: a.id };
}

export const rescheduleSchema = z.object({ token: z.string().min(1).max(80), startAt: z.string().datetime({ offset: true }) });

export async function publicReschedule(raw: z.input<typeof rescheduleSchema>, now = new Date()) {
  const input = rescheduleSchema.parse(raw);
  const a = await loadManagedAppointment(input.token);
  if (!a) throw new NotFoundError('ご予約が見つかりません');
  const check = customerCanModify(a, a.shop, now);
  if (!check.ok) throw modifyError(check, a.shop);
  const startAt = new Date(input.startAt);
  if (startAt.getTime() === a.startAt.getTime()) return { id: a.id, changed: false };
  const durationMin = Math.round((a.endAt.getTime() - a.startAt.getTime()) / 60000);
  const date = toLocalParts(startAt, a.shop.timezone).date;
  const keepStaff = a.nominated && a.staffId ? a.staffId : null;
  const slots = await availableSlots({ shopId: a.shopId, date, durationMin, staffId: keepStaff, excludeAppointmentId: a.id, now });
  const slot = slots.find((s) => s.start === startAt.getTime());
  if (!slot) throw new BookingError('STAFF_CONFLICT');
  // Nominated: same stylist. Otherwise keep the current stylist if free, else any free one.
  const staffId = keepStaff ?? (a.staffId && slot.staffIds.includes(a.staffId) ? a.staffId : slot.staffIds[0] ?? null);
  await updateAppointment({ orgId: a.organizationId, id: a.id, startAt, endAt: new Date(startAt.getTime() + durationMin * 60000), staffId, enforceHours: true, now });
  await audit({ orgId: a.organizationId, userId: null }, 'appointment.reschedule', 'Appointment', a.id, { by: 'customer', from: a.startAt.toISOString(), to: startAt.toISOString() });
  await notifyAppointment(a.id, 'CHANGED');
  return { id: a.id, changed: true };
}

export function manageUrl(token: string) {
  return `${env.appUrl}/booking/${token}`;
}

export { isDateStr };
