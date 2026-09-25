// Transactional reservation service. All writes that can create a conflict run inside
// a DB transaction holding advisory locks on the shop and the involved staff, then
// re-evaluate the pure rules from @salonos/core against fresh data.
import type { AppointmentKind, AppointmentStatus, BookingSource, Prisma } from '@salonos/db';
import {
  ACTIVE_STATUSES, canBook, canTransition, computeAvailability, localToUtc, pickStaff, toLocalParts,
  type BookingConflict, type Interval, type Slot,
} from '@salonos/core';
import { randomToken } from '@salonos/core/crypto';
import { prisma, type Tx } from './db';
import { AppError, NotFoundError } from './errors';
import { recomputeCustomerStats } from './customers';

export const CONFLICT_MESSAGES: Record<BookingConflict, string> = {
  INVALID_RANGE: '終了時刻は開始時刻より後にしてください',
  STAFF_CONFLICT: '担当スタッフの予定が重複しています',
  SEAT_CAPACITY: '席数の上限を超えています',
  OUTSIDE_HOURS: '営業時間外です',
  HOLIDAY: '休業日です',
  IN_PAST: '過去の日時です',
  TOO_SOON: '直前のためネット予約を受け付けられません',
};

export class BookingError extends AppError {
  constructor(public reason: BookingConflict | 'IDEMPOTENT_MISMATCH' | 'NO_STAFF' | 'HOLD_EXPIRED') {
    super(CONFLICT_MESSAGES[reason as BookingConflict] ?? ({ NO_STAFF: '対応可能なスタッフがいません', HOLD_EXPIRED: '仮押さえの有効期限が切れました', IDEMPOTENT_MISMATCH: '重複した予約リクエストです' } as Record<string, string>)[reason], 'BOOKING_CONFLICT', 409);
  }
}

const iv = (a: { startAt: Date; endAt: Date }): Interval => ({ start: a.startAt.getTime(), end: a.endAt.getTime() });

export async function lockKeys(tx: Tx, keys: string[]) {
  for (const k of [...new Set(keys)].sort()) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${k}))`;
  }
}

type ShopRow = { id: string; organizationId: string; timezone: string; seatCount: number; slotIntervalMin: number; minNoticeMin: number; bookingHorizonDays: number };

/** Open window for a shop-local date, or null when closed; plus holiday flag. */
export async function dayWindow(db: Tx | typeof prisma, shop: ShopRow, date: string): Promise<{ openWindow: Interval | null; holiday: boolean; openMin: number | null; closeMin: number | null }> {
  const weekday = new Date(date + 'T00:00:00Z').getUTCDay();
  const [bh, hol] = await Promise.all([
    db.businessHour.findUnique({ where: { shopId_weekday: { shopId: shop.id, weekday } } }),
    db.shopHoliday.findUnique({ where: { shopId_date: { shopId: shop.id, date } } }),
  ]);
  if (!bh || bh.closed) return { openWindow: null, holiday: !!hol, openMin: null, closeMin: null };
  return {
    openWindow: { start: localToUtc(date, bh.openMin, shop.timezone).getTime(), end: localToUtc(date, bh.closeMin, shop.timezone).getTime() },
    holiday: !!hol, openMin: bh.openMin, closeMin: bh.closeMin,
  };
}

/** Busy intervals for seats (this shop) and staff (across the whole organization). */
export async function busyWindows(db: Tx | typeof prisma, shop: ShopRow, from: Date, to: Date, staffIds: string[], opts: { excludeAppointmentId?: string; excludeHoldToken?: string } = {}) {
  const now = new Date();
  const [shopAppts, staffAppts, holds] = await Promise.all([
    db.appointment.findMany({
      where: { shopId: shop.id, status: { in: [...ACTIVE_STATUSES] }, startAt: { lt: to }, endAt: { gt: from }, id: opts.excludeAppointmentId ? { not: opts.excludeAppointmentId } : undefined },
      select: { id: true, startAt: true, endAt: true, kind: true, staffId: true },
    }),
    staffIds.length
      ? db.appointment.findMany({
          where: { organizationId: shop.organizationId, staffId: { in: staffIds }, status: { in: [...ACTIVE_STATUSES] }, startAt: { lt: to }, endAt: { gt: from }, id: opts.excludeAppointmentId ? { not: opts.excludeAppointmentId } : undefined },
          select: { startAt: true, endAt: true, staffId: true },
        })
      : Promise.resolve([] as { startAt: Date; endAt: Date; staffId: string | null }[]),
    db.slotHold.findMany({
      where: { shopId: shop.id, expiresAt: { gt: now }, startAt: { lt: to }, endAt: { gt: from }, token: opts.excludeHoldToken ? { not: opts.excludeHoldToken } : undefined },
    }),
  ]);
  const seatBusy = [...shopAppts.filter((a) => a.kind !== 'PRIVATE').map(iv), ...holds.map(iv)];
  const staffBusy = new Map<string, Interval[]>(staffIds.map((id) => [id, []]));
  for (const a of staffAppts) if (a.staffId) staffBusy.get(a.staffId)?.push(iv(a));
  for (const h of holds) if (h.staffId) staffBusy.get(h.staffId)?.push(iv(h));
  return { seatBusy, staffBusy, shopAppts };
}

/** Staff who can be booked online at a shop. */
export async function bookableStaff(shopId: string) {
  const rows = await prisma.staffAssignment.findMany({
    where: { shopId, membership: { active: true, bookable: true, user: { isActive: true } } },
    include: { membership: true },
  });
  return rows.map((r) => r.membership).sort((a, b) => a.sortOrder - b.sortOrder || a.displayName.localeCompare(b.displayName));
}

async function getShop(db: Tx | typeof prisma, shopId: string): Promise<ShopRow> {
  const shop = await db.shop.findUnique({ where: { id: shopId }, select: { id: true, organizationId: true, timezone: true, seatCount: true, slotIntervalMin: true, minNoticeMin: true, bookingHorizonDays: true } });
  if (!shop) throw new NotFoundError('店舗が見つかりません');
  return shop;
}

export interface AvailabilityQuery { shopId: string; date: string; durationMin: number; staffId?: string | null; excludeHoldToken?: string; now?: Date }

export async function getAvailability(q: AvailabilityQuery): Promise<Slot[]> {
  const shop = await getShop(prisma, q.shopId);
  const now = q.now ?? new Date();
  const today = toLocalParts(now, shop.timezone).date;
  const horizon = new Date(now.getTime() + shop.bookingHorizonDays * 86400000);
  if (q.date < today || localToUtc(q.date, 0, shop.timezone) > horizon) return [];
  const day = await dayWindow(prisma, shop, q.date);
  if (!day.openWindow) return [];
  const staff = await bookableStaff(q.shopId);
  const staffIds = staff.map((s) => s.userId);
  const { seatBusy, staffBusy } = await busyWindows(prisma, shop, new Date(day.openWindow.start), new Date(day.openWindow.end), staffIds, { excludeHoldToken: q.excludeHoldToken });
  return computeAvailability({
    openWindow: day.openWindow, holiday: day.holiday, durationMin: q.durationMin, slotIntervalMin: shop.slotIntervalMin,
    seatCapacity: shop.seatCount, seatBusy, staff: staffIds.map((id) => ({ id, busy: staffBusy.get(id) ?? [] })),
    staffId: q.staffId ?? null, now: now.getTime(), minNoticeMin: shop.minNoticeMin,
  });
}

export interface MenuLine { menuId?: string | null; name: string; price: number; durationMin: number }

export interface CreateAppointmentInput {
  orgId: string;
  shopId: string;
  customerId?: string | null;
  /** null/undefined with autoAssignStaff=true → choose least-loaded free staff */
  staffId?: string | null;
  autoAssignStaff?: boolean;
  startAt: Date;
  /** Explicit end; otherwise sum of menu durations (min 15). */
  endAt?: Date;
  menus?: MenuLine[];
  kind?: AppointmentKind;
  source?: BookingSource;
  status?: AppointmentStatus;
  title?: string | null;
  note?: string | null;
  customerNote?: string | null;
  nominated?: boolean;
  couponId?: string | null;
  discount?: number;
  guestName?: string | null;
  guestPhone?: string | null;
  externalProvider?: string | null;
  externalRef?: string | null;
  idempotencyKey?: string | null;
  createdById?: string | null;
  /** Public/online bookings: business hours, holidays, notice are hard rules. */
  enforceHours?: boolean;
  /** Staff override for seat capacity (recorded as a warning). */
  allowOverCapacity?: boolean;
  holdToken?: string | null;
  now?: Date;
}

export interface BookingResult { appointmentId: string; warnings: BookingConflict[]; idempotentReplay: boolean }

const SOFT_BLOCKING: BookingConflict[] = ['OUTSIDE_HOURS', 'HOLIDAY', 'IN_PAST', 'TOO_SOON'];

function computeEnd(input: { startAt: Date; endAt?: Date; menus?: MenuLine[] }) {
  if (input.endAt) return input.endAt;
  const dur = Math.max(15, (input.menus ?? []).reduce((s, m) => s + m.durationMin, 0));
  return new Date(input.startAt.getTime() + dur * 60000);
}

export async function createAppointment(input: CreateAppointmentInput): Promise<BookingResult> {
  if (input.idempotencyKey) {
    const existing = await prisma.appointment.findUnique({ where: { organizationId_idempotencyKey: { organizationId: input.orgId, idempotencyKey: input.idempotencyKey } } });
    if (existing) return { appointmentId: existing.id, warnings: [], idempotentReplay: true };
  }
  const endAt = computeEnd(input);
  const kind = input.kind ?? 'NORMAL';
  const now = input.now ?? new Date();
  try {
    return await prisma.$transaction(async (tx) => {
      const shop = await getShop(tx, input.shopId);
      if (shop.organizationId !== input.orgId) throw new NotFoundError('店舗が見つかりません');
      const date = toLocalParts(input.startAt, shop.timezone).date;
      let candidates: string[] = input.staffId ? [input.staffId] : [];
      if (!input.staffId && input.autoAssignStaff) candidates = (await bookableStaff(shop.id)).map((m) => m.userId);
      await lockKeys(tx, [`shop:${shop.id}`, ...candidates.map((s) => `staff:${s}`)]);
      if (input.idempotencyKey) {
        // A concurrent request with the same key may have committed while we waited for the lock.
        const replay = await tx.appointment.findUnique({ where: { organizationId_idempotencyKey: { organizationId: input.orgId, idempotencyKey: input.idempotencyKey } } });
        if (replay) return { appointmentId: replay.id, warnings: [], idempotentReplay: true };
      }

      if (input.holdToken) {
        const hold = await tx.slotHold.findUnique({ where: { token: input.holdToken } });
        if (!hold || hold.expiresAt < now) throw new BookingError('HOLD_EXPIRED');
      }
      const day = await dayWindow(tx, shop, date);
      const { seatBusy, staffBusy } = await busyWindows(tx, shop, input.startAt, endAt, candidates, { excludeHoldToken: input.holdToken ?? undefined });
      const candidate = { start: input.startAt.getTime(), end: endAt.getTime() };
      const base = { candidate, seatBusy, seatCapacity: shop.seatCount, usesSeat: kind !== 'PRIVATE', openWindow: day.openWindow, holiday: day.holiday, now: now.getTime(), minNoticeMin: input.enforceHours ? shop.minNoticeMin : 0 };

      let staffId: string | null = input.staffId ?? null;
      let result = canBook({ ...base, staffBusy: staffId ? staffBusy.get(staffId) : [] });
      if (!input.staffId && input.autoAssignStaff) {
        const free = candidates.filter((id) => canBook({ ...base, staffBusy: staffBusy.get(id) }).ok);
        if (!free.length) throw new BookingError(result.ok ? 'NO_STAFF' : result.reason === 'SEAT_CAPACITY' ? 'SEAT_CAPACITY' : 'NO_STAFF');
        const load = await tx.appointment.groupBy({
          by: ['staffId'], where: { shopId: shop.id, staffId: { in: free }, status: { in: [...ACTIVE_STATUSES] }, startAt: { gte: localToUtc(date, 0, shop.timezone), lt: localToUtc(date, 1440, shop.timezone) } }, _count: true,
        });
        staffId = pickStaff(free, Object.fromEntries(load.map((l) => [l.staffId!, l._count])));
        result = canBook({ ...base, staffBusy: staffBusy.get(staffId!) });
      }
      const warnings = [...result.warnings];
      if (!result.ok) {
        if (result.reason === 'SEAT_CAPACITY' && input.allowOverCapacity && !input.enforceHours) warnings.push('SEAT_CAPACITY');
        else throw new BookingError(result.reason);
      }
      if (input.enforceHours) {
        const blocking = warnings.find((w) => SOFT_BLOCKING.includes(w));
        if (blocking) throw new BookingError(blocking);
      }
      const menus = input.menus ?? [];
      const gross = menus.reduce((s, m) => s + m.price, 0);
      const appt = await tx.appointment.create({
        data: {
          organizationId: input.orgId, shopId: shop.id, customerId: input.customerId ?? null, staffId,
          startAt: input.startAt, endAt, kind, source: input.source ?? 'STAFF', status: input.status ?? 'CONFIRMED',
          title: input.title ?? null, note: input.note ?? null, customerNote: input.customerNote ?? null,
          nominated: input.nominated ?? !!input.staffId, couponId: input.couponId ?? null,
          totalPrice: Math.max(0, gross - (input.discount ?? 0)),
          guestName: input.guestName ?? null, guestPhone: input.guestPhone ?? null,
          externalProvider: input.externalProvider ?? null, externalRef: input.externalRef ?? null,
          idempotencyKey: input.idempotencyKey ?? null, createdById: input.createdById ?? null,
          // Bearer secret for the public manage/review URLs: cryptographically random, never cuid.
          manageToken: randomToken(24),
          menus: { create: menus.map((m) => ({ menuId: m.menuId ?? null, name: m.name, price: m.price, durationMin: m.durationMin })) },
        },
      });
      if (input.holdToken) await tx.slotHold.deleteMany({ where: { token: input.holdToken } });
      return { appointmentId: appt.id, warnings, idempotentReplay: false };
    });
  } catch (e: any) {
    // Concurrent duplicate idempotency key → return the winner.
    if (e?.code === 'P2002' && input.idempotencyKey) {
      const existing = await prisma.appointment.findUnique({ where: { organizationId_idempotencyKey: { organizationId: input.orgId, idempotencyKey: input.idempotencyKey } } });
      if (existing) return { appointmentId: existing.id, warnings: [], idempotentReplay: true };
    }
    throw e;
  }
}

export interface UpdateAppointmentInput {
  orgId: string;
  id: string;
  startAt?: Date;
  endAt?: Date;
  staffId?: string | null;
  shopId?: string;
  menus?: MenuLine[];
  customerId?: string | null;
  kind?: AppointmentKind;
  title?: string | null;
  note?: string | null;
  nominated?: boolean;
  couponId?: string | null;
  discount?: number;
  allowOverCapacity?: boolean;
  enforceHours?: boolean;
  now?: Date;
}

/** Move / resize / reassign / edit. Re-validates conflicts excluding itself. */
export async function updateAppointment(input: UpdateAppointmentInput): Promise<{ warnings: BookingConflict[] }> {
  return prisma.$transaction(async (tx) => {
    const cur = await tx.appointment.findFirst({ where: { id: input.id, organizationId: input.orgId }, include: { menus: true } });
    if (!cur) throw new NotFoundError('予約が見つかりません');
    const shop = await getShop(tx, input.shopId ?? cur.shopId);
    if (shop.organizationId !== input.orgId) throw new NotFoundError('店舗が見つかりません');
    const staffId = input.staffId !== undefined ? input.staffId : cur.staffId;
    const startAt = input.startAt ?? cur.startAt;
    let endAt = input.endAt;
    if (!endAt) {
      if (input.menus && !input.startAt) endAt = computeEnd({ startAt, menus: input.menus });
      else endAt = new Date(startAt.getTime() + (cur.endAt.getTime() - cur.startAt.getTime()));
    }
    const kind = input.kind ?? cur.kind;
    const timeChanged = startAt.getTime() !== cur.startAt.getTime() || endAt.getTime() !== cur.endAt.getTime() || staffId !== cur.staffId || shop.id !== cur.shopId || kind !== cur.kind;
    const warnings: BookingConflict[] = [];
    if (timeChanged && (ACTIVE_STATUSES as readonly string[]).includes(cur.status)) {
      await lockKeys(tx, [`shop:${shop.id}`, ...(staffId ? [`staff:${staffId}`] : [])]);
      const date = toLocalParts(startAt, shop.timezone).date;
      const day = await dayWindow(tx, shop, date);
      const { seatBusy, staffBusy } = await busyWindows(tx, shop, startAt, endAt, staffId ? [staffId] : [], { excludeAppointmentId: cur.id });
      const r = canBook({
        candidate: { start: startAt.getTime(), end: endAt.getTime() }, staffBusy: staffId ? staffBusy.get(staffId) : [], seatBusy,
        seatCapacity: shop.seatCount, usesSeat: kind !== 'PRIVATE', openWindow: day.openWindow, holiday: day.holiday,
        now: (input.now ?? new Date()).getTime(), minNoticeMin: input.enforceHours ? shop.minNoticeMin : 0,
      });
      warnings.push(...r.warnings.filter((w) => w !== 'IN_PAST'));
      if (!r.ok) {
        if (r.reason === 'SEAT_CAPACITY' && input.allowOverCapacity && !input.enforceHours) warnings.push('SEAT_CAPACITY');
        else throw new BookingError(r.reason);
      }
      if (input.enforceHours) {
        const blocking = r.warnings.find((w) => SOFT_BLOCKING.includes(w));
        if (blocking) throw new BookingError(blocking);
      }
    }
    const data: Prisma.AppointmentUncheckedUpdateInput = { startAt, endAt, staffId, shopId: shop.id, kind };
    if (input.customerId !== undefined) data.customerId = input.customerId;
    if (input.title !== undefined) data.title = input.title;
    if (input.note !== undefined) data.note = input.note;
    if (input.nominated !== undefined) data.nominated = input.nominated;
    if (input.couponId !== undefined) data.couponId = input.couponId;
    if (input.menus) {
      await tx.appointmentMenu.deleteMany({ where: { appointmentId: cur.id } });
      await tx.appointmentMenu.createMany({ data: input.menus.map((m) => ({ appointmentId: cur.id, menuId: m.menuId ?? null, name: m.name, price: m.price, durationMin: m.durationMin })) });
      data.totalPrice = Math.max(0, input.menus.reduce((s, m) => s + m.price, 0) - (input.discount ?? 0));
    }
    await tx.appointment.update({ where: { id: cur.id }, data });
    return { warnings };
  });
}

export async function changeAppointmentStatus(orgId: string, id: string, status: AppointmentStatus, opts: { reason?: string | null; force?: boolean } = {}) {
  const cur = await prisma.appointment.findFirst({ where: { id, organizationId: orgId } });
  if (!cur) throw new NotFoundError('予約が見つかりません');
  if (!opts.force && !canTransition(cur.status, status)) throw new AppError(`ステータスを「${cur.status}」から「${status}」に変更できません`);
  // Re-activating a cancelled/no-show appointment must re-check conflicts.
  const reactivating = !(ACTIVE_STATUSES as readonly string[]).includes(cur.status) && (ACTIVE_STATUSES as readonly string[]).includes(status);
  return prisma.$transaction(async (tx) => {
    if (reactivating) {
      const shop = await getShop(tx, cur.shopId);
      await lockKeys(tx, [`shop:${shop.id}`, ...(cur.staffId ? [`staff:${cur.staffId}`] : [])]);
      const { seatBusy, staffBusy } = await busyWindows(tx, shop, cur.startAt, cur.endAt, cur.staffId ? [cur.staffId] : [], { excludeAppointmentId: cur.id });
      const r = canBook({ candidate: iv(cur), staffBusy: cur.staffId ? staffBusy.get(cur.staffId) : [], seatBusy, seatCapacity: shop.seatCount, usesSeat: cur.kind !== 'PRIVATE' });
      if (!r.ok) throw new BookingError(r.reason);
    }
    const updated = await tx.appointment.update({
      where: { id },
      data: {
        status,
        cancelledAt: status === 'CANCELLED' ? new Date() : status === cur.status ? cur.cancelledAt : null,
        cancelReason: status === 'CANCELLED' ? opts.reason ?? null : cur.cancelReason,
      },
    });
    if (cur.customerId && (status === 'CANCELLED' || status === 'NO_SHOW' || cur.status === 'CANCELLED' || cur.status === 'NO_SHOW')) {
      await recomputeCustomerStats(cur.customerId, tx);
    }
    return updated;
  });
}

export const HOLD_MINUTES = 10;

/** Temporary slot lock during public checkout. */
export async function createHold(shopId: string, staffId: string | null, startAt: Date, endAt: Date, now = new Date()) {
  return prisma.$transaction(async (tx) => {
    const shop = await getShop(tx, shopId);
    await lockKeys(tx, [`shop:${shop.id}`, ...(staffId ? [`staff:${staffId}`] : [])]);
    await tx.slotHold.deleteMany({ where: { shopId, expiresAt: { lt: now } } });
    const { seatBusy, staffBusy } = await busyWindows(tx, shop, startAt, endAt, staffId ? [staffId] : []);
    const r = canBook({ candidate: { start: startAt.getTime(), end: endAt.getTime() }, staffBusy: staffId ? staffBusy.get(staffId) : [], seatBusy, seatCapacity: shop.seatCount });
    if (!r.ok) throw new BookingError(r.reason);
    const token = randomToken(18);
    await tx.slotHold.create({ data: { shopId, staffId, startAt, endAt, token, expiresAt: new Date(now.getTime() + HOLD_MINUTES * 60000) } });
    return { token, expiresAt: new Date(now.getTime() + HOLD_MINUTES * 60000) };
  });
}

export const STATUS_LABEL: Record<AppointmentStatus, string> = {
  REQUESTED: 'リクエスト', CONFIRMED: '確定', ARRIVED: '来店', IN_SERVICE: '施術中', COMPLETED: '完了', CANCELLED: 'キャンセル', NO_SHOW: '無断キャンセル',
};

export const SOURCE_LABEL: Record<BookingSource, string> = {
  STAFF: '店頭', WEB: 'ネット予約', LINE: 'LINE', PHONE: '電話', INSTAGRAM: 'Instagram', GOOGLE: 'Google', HOTPEPPER: 'ホットペッパー', MINIMO: 'minimo', RAKUTEN: '楽天ビューティ', OTHER: 'その他',
};

export const KIND_LABEL: Record<AppointmentKind, string> = { NORMAL: '通常', CONSULTATION: '相談', PRIVATE: 'プライベート' };
