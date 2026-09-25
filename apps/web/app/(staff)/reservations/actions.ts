'use server';
import { z } from 'zod';
import { canTransition, isDateStr, localToUtc, maskPhone, normalizePhone, STATUS_TRANSITIONS, toLocalParts, type BookingConflict } from '@salonos/core';
import type { AppointmentStatus, Prisma } from '@salonos/db';
import { prisma } from '@/lib/server/db';
import { assertShop, requireStaff, type StaffContext } from '@/lib/server/session';
import { changeAppointmentStatus, createAppointment, updateAppointment, CONFLICT_MESSAGES, type MenuLine } from '@/lib/server/booking';
import { resolveCustomer } from '@/lib/server/customers';
import { maskedContact, phoneHash } from '@/lib/server/pii';
import { notifyAppointment } from '@/lib/server/appointment-notify';
import { audit } from '@/lib/server/audit';
import { AppError, ForbiddenError, NotFoundError, runAction, type ActionResult } from '@/lib/server/errors';
import { couponDiscount, couponValidAt, manageUrl, resolveMenus } from '@/lib/server/reservations';

/** ActionResult plus the booking conflict code so the client can offer an override. */
export type LedgerResult<T = undefined> = ActionResult<T> & { code?: string };

async function run<T>(fn: () => Promise<ActionResult<T> | void>): Promise<LedgerResult<T>> {
  return runAction<T>(async () => {
    try {
      return await fn();
    } catch (e: any) {
      if (e?.code === 'BOOKING_CONFLICT' && e?.reason) return { ok: false, error: e.message, code: e.reason } as LedgerResult<T>;
      throw e;
    }
  });
}

const id = z.string().trim().min(1).max(64);
const optId = z.string().trim().max(64).nullish().transform((v) => v || null);

async function loadAppt(ctx: StaffContext, apptId: string) {
  const a = await prisma.appointment.findFirst({ where: { id: apptId, organizationId: ctx.org.id } });
  if (!a) throw new NotFoundError('予約が見つかりません');
  assertShop(ctx, a.shopId);
  return a;
}

async function assertStaffInShop(ctx: StaffContext, shopId: string, staffId: string | null) {
  if (!staffId) return;
  const m = await prisma.membership.findFirst({ where: { organizationId: ctx.org.id, userId: staffId, active: true, shops: { some: { shopId } } } });
  if (!m) throw new AppError('担当スタッフがこの店舗に所属していません');
}

function shopOf(ctx: StaffContext, shopId: string) {
  const s = ctx.shops.find((x) => x.id === shopId);
  if (!s) throw new ForbiddenError('この店舗へのアクセス権がありません');
  return s;
}

function warningText(ws: BookingConflict[]) {
  return ws.map((w) => CONFLICT_MESSAGES[w] ?? w);
}

// ───────────── Appointment detail (drawer) ─────────────

export interface AppointmentDetail {
  id: string; shopId: string; date: string; startMin: number; durationMin: number; startAt: string; endAt: string;
  staffId: string | null; nominated: boolean; status: AppointmentStatus; kind: 'NORMAL' | 'CONSULTATION' | 'PRIVATE'; source: string;
  title: string | null; note: string | null; customerNote: string | null; couponId: string | null; totalPrice: number;
  menus: { menuId: string | null; name: string; price: number; durationMin: number }[];
  customer: { id: string; name: string; kana: string; phone: string; visitCount: number; lastVisitAt: string | null; noShowCount: number; cancelCount: number } | null;
  guestName: string | null; guestPhone: string | null; manageUrl: string; cancelReason: string | null; cancelledAt: string | null;
  karteId: string | null; transaction: { id: string; status: string } | null; createdAt: string; createdByName: string | null;
  transitions: string[]; externalProvider: string | null;
}

export async function getAppointmentAction(apptId: string): Promise<LedgerResult<AppointmentDetail>> {
  return run(async () => {
    const ctx = await requireStaff('appointment.read');
    const a = await prisma.appointment.findFirst({
      where: { id: id.parse(apptId), organizationId: ctx.org.id },
      include: { menus: true, customer: true, karte: { select: { id: true } }, transaction: { select: { id: true, status: true } } },
    });
    if (!a) throw new NotFoundError('予約が見つかりません');
    const shop = shopOf(ctx, a.shopId);
    const s = toLocalParts(a.startAt, shop.timezone);
    const createdBy = a.createdById ? await prisma.membership.findFirst({ where: { organizationId: ctx.org.id, userId: a.createdById }, select: { displayName: true } }) : null;
    const c = a.customer;
    return {
      ok: true,
      data: {
        id: a.id, shopId: a.shopId, date: s.date, startMin: s.minutes, durationMin: Math.round((a.endAt.getTime() - a.startAt.getTime()) / 60000),
        startAt: a.startAt.toISOString(), endAt: a.endAt.toISOString(), staffId: a.staffId, nominated: a.nominated, status: a.status, kind: a.kind,
        source: a.source, title: a.title, note: a.note, customerNote: a.customerNote, couponId: a.couponId, totalPrice: a.totalPrice,
        menus: a.menus.map((m) => ({ menuId: m.menuId, name: m.name, price: m.price, durationMin: m.durationMin })),
        customer: c && ctx.can('customer.read') ? {
          id: c.id, name: `${c.lastName} ${c.firstName}`.trim(), kana: `${c.lastNameKana ?? ''} ${c.firstNameKana ?? ''}`.trim(),
          phone: maskedContact(c).phone, visitCount: c.visitCount, lastVisitAt: c.lastVisitAt?.toISOString() ?? null, noShowCount: c.noShowCount, cancelCount: c.cancelCount,
        } : c ? { id: c.id, name: `${c.lastName} ${c.firstName}`.trim(), kana: '', phone: '', visitCount: 0, lastVisitAt: null, noShowCount: 0, cancelCount: 0 } : null,
        guestName: a.guestName, guestPhone: a.guestPhone ? maskPhone(normalizePhone(a.guestPhone) ?? a.guestPhone) : null,
        manageUrl: manageUrl(a.manageToken), cancelReason: a.cancelReason, cancelledAt: a.cancelledAt?.toISOString() ?? null,
        karteId: a.karte?.id ?? null, transaction: a.transaction, createdAt: a.createdAt.toISOString(), createdByName: createdBy?.displayName ?? null,
        transitions: STATUS_TRANSITIONS[a.status] ?? [], externalProvider: a.externalProvider,
      },
    };
  });
}

// ───────────── Customer search ─────────────

export interface CustomerHit { id: string; name: string; kana: string; phone: string; visitCount: number; lastVisitAt: string | null }

export async function searchCustomersAction(q: string): Promise<LedgerResult<CustomerHit[]>> {
  return run(async () => {
    const ctx = await requireStaff('appointment.write');
    if (!ctx.can('customer.read')) throw new ForbiddenError('顧客を検索する権限がありません');
    const term = z.string().trim().max(60).parse(q ?? '').normalize('NFKC');
    if (term.length < 1) return { ok: true, data: [] };
    const kana = term.replace(/[ぁ-ゖ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0x60));
    const parts = term.split(/\s+/).filter(Boolean);
    const or: Prisma.CustomerWhereInput[] = [
      { lastName: { contains: parts[0], mode: 'insensitive' } }, { firstName: { contains: parts[0], mode: 'insensitive' } },
      { lastNameKana: { contains: kana.split(/\s+/)[0] } }, { firstNameKana: { contains: kana.split(/\s+/)[0] } },
      // kana may have been stored in hiragana by older imports
      { lastNameKana: { contains: parts[0] } }, { firstNameKana: { contains: parts[0] } },
    ];
    const ph = phoneHash(term);
    if (ph) or.push({ phoneHash: ph });
    const rows = await prisma.customer.findMany({
      where: {
        organizationId: ctx.org.id, mergedIntoId: null, deletedAt: null, OR: or,
        ...(parts.length > 1 ? { AND: parts.slice(1).map((p) => ({ OR: [{ firstName: { contains: p, mode: 'insensitive' as const } }, { firstNameKana: { contains: p.replace(/[ぁ-ゖ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0x60)) } }] })) } : {}),
      },
      orderBy: [{ lastVisitAt: { sort: 'desc', nulls: 'last' } }], take: 12,
    });
    return {
      ok: true,
      data: rows.map((c) => ({
        id: c.id, name: `${c.lastName} ${c.firstName}`.trim(), kana: `${c.lastNameKana ?? ''} ${c.firstNameKana ?? ''}`.trim(),
        phone: maskedContact(c).phone, visitCount: c.visitCount, lastVisitAt: c.lastVisitAt?.toISOString() ?? null,
      })),
    };
  });
}

// ───────────── Create / edit ─────────────

const saveSchema = z.object({
  id: optId,
  idempotencyKey: z.string().max(80).nullish(),
  date: z.string().refine(isDateStr, '日付が正しくありません'),
  startMin: z.number().int().min(0).max(1439),
  durationMin: z.number().int().min(5, '所要時間は5分以上にしてください').max(720, '所要時間が長すぎます').nullish(),
  staffMode: z.enum(['staff', 'auto', 'none']),
  staffId: optId,
  nominated: z.boolean().default(false),
  kind: z.enum(['NORMAL', 'CONSULTATION', 'PRIVATE']),
  title: z.string().trim().max(80).nullish(),
  customerMode: z.enum(['existing', 'new', 'guest']),
  customerId: optId,
  newName: z.string().trim().max(60).nullish(),
  newKana: z.string().trim().max(60).nullish(),
  newPhone: z.string().trim().max(30).nullish(),
  guestName: z.string().trim().max(60).nullish(),
  guestPhone: z.string().trim().max(30).nullish(),
  menuIds: z.array(id).max(20).default([]),
  couponId: optId,
  note: z.string().trim().max(2000).nullish(),
  source: z.enum(['STAFF', 'PHONE', 'WEB', 'LINE', 'INSTAGRAM', 'GOOGLE', 'OTHER']).default('STAFF'),
  status: z.enum(['CONFIRMED', 'REQUESTED']).default('CONFIRMED'),
  notify: z.boolean().default(false),
  allowOverCapacity: z.boolean().default(false),
  waitlistId: optId,
});
export type SaveAppointmentInput = z.input<typeof saveSchema>;

export async function saveAppointmentAction(raw: SaveAppointmentInput): Promise<LedgerResult<{ id: string; warnings: string[] }>> {
  return run(async () => {
    const ctx = await requireStaff('appointment.write');
    const input = saveSchema.parse(raw);
    const existing = input.id ? await loadAppt(ctx, input.id) : null;
    const shopId = existing?.shopId ?? ctx.shop.id;
    const shop = shopOf(ctx, shopId);
    const isPrivate = input.kind === 'PRIVATE';

    // staff
    let staffId: string | null = null;
    if (input.staffMode === 'staff') {
      if (!input.staffId) throw new AppError('担当スタッフを選択してください');
      staffId = input.staffId;
      await assertStaffInShop(ctx, shopId, staffId);
    }
    if (isPrivate && input.staffMode !== 'staff') throw new AppError('プライベート予定は担当スタッフを選択してください');

    // menus / coupon
    const menus = isPrivate ? { lines: [] as MenuLine[], durationMin: 0, consultation: false, mixed: false, gross: 0 } : await resolveMenus(ctx.org.id, shopId, input.menuIds);
    if (existing && !isPrivate) {
      // Keep lines the drawer cannot show/select: fees without a menu (指名料) and since-retired menus.
      const [oldLines, activeMenus] = await Promise.all([
        prisma.appointmentMenu.findMany({ where: { appointmentId: existing.id } }),
        prisma.menu.findMany({ where: { shopId, active: true }, select: { id: true } }),
      ]);
      const active = new Set(activeMenus.map((m) => m.id));
      for (const l of oldLines) {
        if (!l.menuId || !active.has(l.menuId)) {
          menus.lines.push({ menuId: l.menuId, name: l.name, price: l.price, durationMin: l.durationMin });
          menus.durationMin += l.durationMin;
        }
      }
    }
    let discount = 0;
    let couponId: string | null = null;
    if (!isPrivate && input.couponId) {
      const coupon = await prisma.coupon.findFirst({ where: { id: input.couponId, shopId, organizationId: ctx.org.id } });
      if (!coupon) throw new AppError('クーポンが見つかりません');
      if (!couponValidAt(coupon, new Date()) && coupon.id !== existing?.couponId) throw new AppError('このクーポンは有効期間外または無効です');
      couponId = coupon.id;
      discount = couponDiscount(coupon, menus.lines);
    }

    // time
    const duration = input.durationMin ?? (menus.durationMin > 0 ? menus.durationMin : isPrivate ? 60 : 30);
    const startAt = localToUtc(input.date, input.startMin, shop.timezone);
    const endAt = new Date(startAt.getTime() + duration * 60000);

    // customer
    let customerId: string | null = null;
    let guestName: string | null = null, guestPhone: string | null = null;
    if (!isPrivate) {
      if (input.customerMode === 'existing') {
        if (!input.customerId) throw new AppError('お客様を検索して選択してください');
        const c = await prisma.customer.findFirst({ where: { id: input.customerId, organizationId: ctx.org.id, deletedAt: null } });
        if (!c) throw new AppError('お客様が見つかりません');
        customerId = c.mergedIntoId ?? c.id;
      } else if (input.customerMode === 'new') {
        if (!ctx.can('customer.write')) throw new ForbiddenError('顧客を登録する権限がありません');
        if (!input.newName) throw new AppError('お客様のお名前を入力してください');
        if (input.newPhone && !normalizePhone(input.newPhone)) throw new AppError('電話番号の形式が正しくありません');
        const r = await prisma.$transaction((tx) => resolveCustomer(tx, { orgId: ctx.org.id, shopId, name: input.newName!, kana: input.newKana || null, phone: input.newPhone || null }));
        customerId = r.customerId;
      } else {
        guestName = input.guestName || 'ゲスト';
        guestPhone = input.guestPhone || null;
      }
    }

    const kind = isPrivate ? 'PRIVATE' : menus.consultation && input.kind === 'NORMAL' ? 'CONSULTATION' : input.kind;
    const title = isPrivate ? (input.title || 'プライベート') : input.title || null;

    if (!existing) {
      if (input.waitlistId) await loadWaitlist(ctx, input.waitlistId);
      const r = await createAppointment({
        orgId: ctx.org.id, shopId, customerId, staffId, autoAssignStaff: input.staffMode === 'auto', startAt, endAt,
        menus: menus.lines, kind, source: input.source, status: input.status, title, note: input.note || null,
        nominated: input.staffMode === 'staff' ? input.nominated : false, couponId, discount, guestName, guestPhone,
        idempotencyKey: input.idempotencyKey ? `staff:${ctx.user.id}:${input.idempotencyKey}` : null, createdById: ctx.user.id,
        allowOverCapacity: input.allowOverCapacity,
      });
      if (r.warnings.includes('SEAT_CAPACITY')) await audit(ctx, 'appointment.capacity_override', 'Appointment', r.appointmentId, { shopId });
      if (input.waitlistId && !r.idempotentReplay) {
        await prisma.waitlistEntry.update({ where: { id: input.waitlistId }, data: { status: 'BOOKED', customerId: customerId ?? undefined } });
      }
      if (input.notify && customerId && !r.idempotentReplay) await notifyAppointment(r.appointmentId, input.status === 'REQUESTED' ? 'REQUESTED' : 'BOOKED');
      return { ok: true, message: '予約を登録しました', data: { id: r.appointmentId, warnings: warningText(r.warnings) } };
    }

    const r = await updateAppointment({
      orgId: ctx.org.id, id: existing.id, startAt, endAt,
      staffId: input.staffMode === 'auto' ? existing.staffId : staffId,
      menus: isPrivate ? [] : menus.lines, discount, couponId, kind, title, note: input.note || null,
      nominated: input.staffMode === 'staff' ? input.nominated : false,
      ...(input.customerMode === 'guest' && !isPrivate ? {} : { customerId }),
      allowOverCapacity: input.allowOverCapacity,
    });
    if (r.warnings.includes('SEAT_CAPACITY')) await audit(ctx, 'appointment.capacity_override', 'Appointment', existing.id, { shopId });
    const timeChanged = startAt.getTime() !== existing.startAt.getTime();
    if (input.notify && timeChanged && (existing.customerId || customerId)) await notifyAppointment(existing.id, 'CHANGED');
    return { ok: true, message: '予約を更新しました', data: { id: existing.id, warnings: warningText(r.warnings) } };
  });
}

// ───────────── Drag & drop move / resize ─────────────

const moveSchema = z.object({
  id,
  date: z.string().refine(isDateStr),
  startMin: z.number().int().min(0).max(1439),
  endMin: z.number().int().min(5).max(1440),
  /** undefined = keep, null = 未割当 */
  staffId: z.string().max(64).nullable().optional(),
  allowOverCapacity: z.boolean().default(false),
});

export async function moveAppointmentAction(raw: z.input<typeof moveSchema>): Promise<LedgerResult<{ warnings: string[] }>> {
  return run(async () => {
    const ctx = await requireStaff('appointment.write');
    const input = moveSchema.parse(raw);
    if (input.endMin <= input.startMin) throw new AppError('終了時刻は開始時刻より後にしてください');
    const a = await loadAppt(ctx, input.id);
    if (!['REQUESTED', 'CONFIRMED', 'ARRIVED', 'IN_SERVICE'].includes(a.status)) throw new AppError('この予約は移動できません');
    const shop = shopOf(ctx, a.shopId);
    if (input.staffId !== undefined) await assertStaffInShop(ctx, a.shopId, input.staffId);
    if (a.kind === 'PRIVATE' && input.staffId === null) throw new AppError('プライベート予定は未割当にできません');
    const startAt = localToUtc(input.date, input.startMin, shop.timezone);
    const endAt = localToUtc(input.date, input.endMin, shop.timezone);
    const staffChanged = input.staffId !== undefined && input.staffId !== a.staffId;
    const r = await updateAppointment({
      orgId: ctx.org.id, id: a.id, startAt, endAt, staffId: input.staffId,
      // moving a nominated booking to another stylist drops the nomination
      ...(staffChanged && a.nominated ? { nominated: false } : {}),
      allowOverCapacity: input.allowOverCapacity,
    });
    if (r.warnings.includes('SEAT_CAPACITY')) await audit(ctx, 'appointment.capacity_override', 'Appointment', a.id, { shopId: a.shopId });
    if (startAt.getTime() !== a.startAt.getTime() && a.customerId && a.kind !== 'PRIVATE') await notifyAppointment(a.id, 'CHANGED');
    return { ok: true, data: { warnings: warningText(r.warnings) } };
  });
}

// ───────────── Status ─────────────

const statusSchema = z.object({
  id,
  status: z.enum(['REQUESTED', 'CONFIRMED', 'ARRIVED', 'IN_SERVICE', 'COMPLETED', 'CANCELLED', 'NO_SHOW']),
  reason: z.string().trim().max(300).nullish(),
  notify: z.boolean().default(true),
});

export async function changeStatusAction(raw: z.input<typeof statusSchema>): Promise<LedgerResult> {
  return run(async () => {
    const ctx = await requireStaff('appointment.write');
    const input = statusSchema.parse(raw);
    const a = await loadAppt(ctx, input.id);
    if (!canTransition(a.status, input.status)) throw new AppError('このステータスには変更できません');
    if (input.status === 'CANCELLED' && !input.reason) throw new AppError('キャンセル理由を入力してください');
    await changeAppointmentStatus(ctx.org.id, a.id, input.status, { reason: input.reason ?? null });
    if (input.status === 'CANCELLED' || input.status === 'NO_SHOW' || a.status === 'CANCELLED' || a.status === 'NO_SHOW') {
      await audit(ctx, input.status === 'CANCELLED' ? 'appointment.cancel' : 'appointment.status', 'Appointment', a.id, { from: a.status, to: input.status, reason: input.reason ?? null });
    }
    if (a.customerId && a.kind !== 'PRIVATE') {
      if (a.status === 'REQUESTED' && input.status === 'CONFIRMED') await notifyAppointment(a.id, 'CONFIRMED');
      if (input.status === 'CANCELLED' && input.notify) await notifyAppointment(a.id, 'CANCELLED');
    }
    return { ok: true };
  });
}

// ───────────── Waitlist ─────────────

async function loadWaitlist(ctx: StaffContext, entryId: string) {
  const w = await prisma.waitlistEntry.findUnique({ where: { id: entryId }, include: { shop: { select: { organizationId: true } } } });
  if (!w || w.shop.organizationId !== ctx.org.id) throw new NotFoundError('キャンセル待ちが見つかりません');
  assertShop(ctx, w.shopId);
  return w;
}

const WAIT_STATUSES = ['WAITING', 'CONTACTED', 'BOOKED', 'CLOSED'] as const;

const waitSchema = z.object({
  name: z.string().trim().min(1, 'お名前を入力してください').max(60),
  contact: z.string().trim().max(100).optional(),
  desiredDate: z.string().refine(isDateStr, '希望日を入力してください'),
  timeNote: z.string().trim().max(100).optional(),
  menuNote: z.string().trim().max(200).optional(),
  staffId: z.string().trim().max(64).optional(),
  customerId: z.string().trim().max(64).optional(),
});

export async function addWaitlistAction(_: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await requireStaff('appointment.write');
    const input = waitSchema.parse(Object.fromEntries(fd));
    const staffId = input.staffId || null;
    await assertStaffInShop(ctx, ctx.shop.id, staffId);
    let customerId: string | null = null;
    if (input.customerId) {
      const c = await prisma.customer.findFirst({ where: { id: input.customerId, organizationId: ctx.org.id, deletedAt: null } });
      if (!c) throw new AppError('お客様が見つかりません');
      customerId = c.id;
    }
    await prisma.waitlistEntry.create({
      data: { shopId: ctx.shop.id, customerId, name: input.name, contact: input.contact || null, desiredDate: input.desiredDate, timeNote: input.timeNote || null, menuNote: input.menuNote || null, staffId },
    });
    return { ok: true, message: 'キャンセル待ちに追加しました' };
  });
}

export async function setWaitlistStatusAction(fd: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await requireStaff('appointment.write');
    const entryId = id.parse(fd.get('id'));
    const status = z.enum(WAIT_STATUSES).parse(fd.get('status'));
    await loadWaitlist(ctx, entryId);
    await prisma.waitlistEntry.update({ where: { id: entryId }, data: { status } });
    return { ok: true };
  });
}

export async function deleteWaitlistAction(fd: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await requireStaff('appointment.write');
    const entryId = id.parse(fd.get('id'));
    const w = await loadWaitlist(ctx, entryId);
    await prisma.waitlistEntry.delete({ where: { id: entryId } });
    await audit(ctx, 'waitlist.delete', 'WaitlistEntry', entryId, { shopId: w.shopId, desiredDate: w.desiredDate, status: w.status });
    return { ok: true };
  });
}
