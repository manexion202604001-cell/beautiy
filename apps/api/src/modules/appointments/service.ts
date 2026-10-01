import { sql } from 'kysely';
import { assertShopAccess, auditUserId, requirePermission, type Ctx } from '../../auth/actor.js';
import { audit } from '../../lib/audit.js';
import { referenceCode } from '../../lib/crypto.js';
import { Errors } from '../../lib/errors.js';
import { emit } from '../../lib/events.js';
import { addMinutes, dayBounds, localDate } from '../../lib/time.js';
import { effectiveMenus, evaluateCoupon, type EffectiveMenu } from '../catalog/service.js';
import { assertCustomerAccess } from '../customers/access.js';
import { ensureVisitedRelation } from '../customers/service.js';
import { recomputeCustomerStats } from '../customers/stats.js';
import { loadScheduleData } from '../schedules/calendar.js';
import {
  ACTIVE_STATUSES,
  buildPlans,
  candidateStaff,
  checkSlot,
  chooseLeastBusyStaff,
  loadOccupancy,
  loadShop,
  occupiedRange,
  pickResources,
  type StaffPlan,
} from './availability.js';
import type { CreateAppointmentInput, ListAppointmentsInput, UpdateAppointmentInput } from './schemas.js';

type Status = 'tentative' | 'confirmed' | 'checked_in' | 'in_service' | 'completed' | 'cancelled' | 'no_show';

/** Allowed status transitions (state machine) */
export const TRANSITIONS: Record<Status, Status[]> = {
  tentative: ['confirmed', 'cancelled'],
  confirmed: ['checked_in', 'in_service', 'completed', 'cancelled', 'no_show'],
  checked_in: ['in_service', 'completed', 'cancelled', 'no_show'],
  in_service: ['completed', 'checked_in'],
  completed: ['in_service'], // only via POS void (reopen)
  cancelled: ['confirmed'], // restore
  no_show: ['confirmed'], // correction
};

const SLOT_REASON_MESSAGES: Record<string, string> = {
  outside_schedule: '営業時間/勤務時間外です',
  staff_busy: 'この時間帯は既に予約が入っています',
  resource_unavailable: '必要な席・設備が空いていません',
  lead_time: '予約受付締切を過ぎています',
  horizon: '予約受付期間外です',
};

export interface PlanInput {
  shopId: string;
  staffId: string | null | undefined;
  startAt: Date;
  menuIds: string[];
  publicBooking?: boolean;
  allowOutsideSchedule?: boolean;
  excludeAppointmentId?: string;
}

export interface ResolvedPlan {
  staffId: string;
  autoAssigned: boolean;
  plan: StaffPlan;
  menus: EffectiveMenu[];
  occupied: { start: Date; end: Date };
  resources: { resourceId: string; start: Date; end: Date }[];
  tz: string;
}

/**
 * Resolve staff (指名 or auto-assigned フリー), durations, buffers and resources for a booking,
 * validating the slot. Takes per-staff advisory locks so concurrent bookings for the same
 * staff serialize; the DB exclusion constraint remains the final guard (要件 12).
 */
export async function resolvePlan(ctx: Ctx, input: PlanInput): Promise<ResolvedPlan> {
  const shop = await loadShop(ctx, input.shopId);
  const menus = await effectiveMenus(ctx, input.shopId, { publicOnly: input.publicBooking, menuIds: input.menuIds });
  const ordered = input.menuIds.map((id) => menus.find((m) => m.id === id));
  if (ordered.some((m) => !m)) throw Errors.validation('予約できないメニューが含まれています');
  const menuList = ordered as EffectiveMenu[];

  const candidates = await candidateStaff(ctx, input.shopId, input.menuIds, input.staffId ?? undefined);
  if (input.staffId && !candidates.includes(input.staffId)) {
    throw Errors.business('STAFF_NOT_AVAILABLE', 'このスタッフは指定メニューを担当できないか、この店舗で予約を受け付けていません');
  }
  if (!candidates.length) throw Errors.business('NO_STAFF', '担当可能なスタッフがいません');

  // lock candidate staff in a stable order to avoid deadlocks
  for (const id of [...candidates].sort()) {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'staff:' + id}, 0))`.execute(ctx.trx);
  }

  const date = localDate(input.startAt, shop.timezone);
  const plans = await buildPlans(ctx, menuList, candidates);
  const data = await loadScheduleData(ctx, input.shopId, candidates, date, date, shop.timezone);
  const bounds = dayBounds(date, shop.timezone);
  const occupancy = await loadOccupancy(ctx, input.shopId, candidates, addMinutes(bounds.start, -720), addMinutes(bounds.end, 720), data, input.excludeAppointmentId);

  const ok: string[] = [];
  let lastReason = 'staff_busy';
  for (const staffId of candidates) {
    const plan = plans.get(staffId)!;
    const check = checkSlot(plan, input.startAt, data, occupancy, { publicBooking: input.publicBooking, settings: shop.parsed, now: new Date() });
    if (check.ok) ok.push(staffId);
    else if (input.allowOutsideSchedule && check.reason === 'outside_schedule') {
      // staff override: still must not clash with other appointments or resources
      const occ = occupiedRange(plan, input.startAt);
      const busy = occupancy.staffBusy.get(staffId) ?? [];
      const clash = busy.some((b) => b.start < occ.end && occ.start < b.end);
      const resOk = !plan.resourceNeeds.length || !!pickResources(plan, input.startAt, occupancy);
      if (!clash && resOk) ok.push(staffId);
      else lastReason = clash ? 'staff_busy' : 'resource_unavailable';
    } else lastReason = check.reason ?? lastReason;
  }
  if (!ok.length) {
    throw Errors.conflict('SLOT_UNAVAILABLE', SLOT_REASON_MESSAGES[lastReason] ?? 'この時間帯は予約できません', { reason: lastReason });
  }

  let staffId: string;
  let autoAssigned = false;
  if (input.staffId) staffId = input.staffId;
  else {
    if (!shop.parsed.booking.autoAssignFree && input.publicBooking) throw Errors.validation('担当スタッフを選択してください');
    staffId = (await chooseLeastBusyStaff(ctx, ok, date, shop.timezone))!;
    autoAssigned = true;
  }
  const plan = plans.get(staffId)!;
  const resources = plan.resourceNeeds.length ? (pickResources(plan, input.startAt, occupancy) ?? []) : [];
  for (const r of [...resources].sort((a, b) => a.resourceId.localeCompare(b.resourceId))) {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'resource:' + r.resourceId}, 0))`.execute(ctx.trx);
  }
  return { staffId, autoAssigned, plan, menus: menuList, occupied: occupiedRange(plan, input.startAt), resources, tz: shop.timezone };
}

async function uniqueReference(ctx: Ctx): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const ref = referenceCode(8);
    const exists = await ctx.trx.selectFrom('appointments').select('id').where('booking_reference', '=', ref).executeTakeFirst();
    if (!exists) return ref;
  }
  throw Errors.system('予約番号の採番に失敗しました');
}

async function recordEvent(ctx: Ctx, appointmentId: string, eventType: string, payload: Record<string, unknown> = {}) {
  const actorType = ctx.actor.kind === 'staff' ? 'staff' : ctx.actor.kind === 'customer' ? 'customer' : payload.external ? 'external' : 'system';
  await ctx.trx
    .insertInto('appointment_events')
    .values({
      organization_id: ctx.actor.organizationId,
      appointment_id: appointmentId,
      event_type: eventType,
      actor_type: actorType,
      actor_id: ctx.actor.kind === 'staff' ? ctx.actor.staffId : ctx.actor.kind === 'customer' ? ctx.actor.customerId : null,
      payload: JSON.stringify(payload),
      trace_id: ctx.meta.traceId ?? null,
    })
    .execute();
}

export interface CreateOptions {
  publicBooking?: boolean;
  /** skip permission/shop checks (public/system channels authorize themselves) */
  trusted?: boolean;
}

export async function createAppointment(ctx: Ctx, input: CreateAppointmentInput, opts: CreateOptions = {}) {
  if (!opts.trusted) {
    requirePermission(ctx.actor, 'appointment.write');
    assertShopAccess(ctx.actor, input.shopId);
    if (input.customerId) await assertCustomerAccess(ctx, input.customerId);
  }
  const startAt = new Date(input.startAt);
  const resolved = await resolvePlan(ctx, {
    shopId: input.shopId,
    staffId: input.staffId,
    startAt,
    menuIds: input.menuIds,
    publicBooking: opts.publicBooking,
    allowOutsideSchedule: !opts.publicBooking && input.allowOutsideSchedule,
  });

  const estimated = resolved.plan.services.reduce((s, x) => s + x.price, 0);
  let couponDiscount = 0;
  if (input.couponId) {
    const ev = await evaluateCoupon(ctx, {
      couponId: input.couponId,
      shopId: input.shopId,
      customerId: input.customerId,
      lines: resolved.plan.services.map((s) => ({ menuId: s.menuId, amount: s.price })),
      at: startAt,
    });
    if (!ev.valid) throw Errors.business('COUPON_INVALID', ev.reason ?? 'クーポンを利用できません');
    couponDiscount = ev.discountAmount;
  }

  const shop = await loadShop(ctx, input.shopId);
  const status = input.status ?? (opts.publicBooking && shop.parsed.booking.requireApproval ? 'tentative' : 'confirmed');
  const isNominated = input.isNominated ?? (!!input.staffId && !resolved.autoAssigned);
  const consultation = resolved.menus.some((m) => m.isConsultation);

  const appt = await ctx.trx
    .insertInto('appointments')
    .values({
      organization_id: ctx.actor.organizationId,
      shop_id: input.shopId,
      customer_id: input.customerId ?? null,
      staff_id: resolved.staffId,
      is_nominated: isNominated,
      booking_reference: await uniqueReference(ctx),
      start_at: startAt,
      end_at: addMinutes(startAt, resolved.plan.durationMin),
      occupied_start_at: resolved.occupied.start,
      occupied_end_at: resolved.occupied.end,
      status,
      source: input.source,
      source_detail: JSON.stringify({ ...(input.sourceDetail ?? {}), ...(resolved.autoAssigned ? { autoAssigned: true } : {}) }),
      coupon_id: input.couponId ?? null,
      is_consultation: consultation,
      customer_note: input.customerNote ?? null,
      staff_note: input.staffNote ?? null,
      estimated_total: Math.max(0, estimated - couponDiscount),
      confirmed_at: status === 'confirmed' ? new Date() : null,
      created_by: auditUserId(ctx.actor),
      trace_id: ctx.meta.traceId ?? null,
    })
    .returning(['id'])
    .executeTakeFirstOrThrow();

  await insertServicesAndResources(ctx, appt.id, resolved);
  if (input.couponId) {
    await ctx.trx
      .insertInto('coupon_redemptions')
      .values({ organization_id: ctx.actor.organizationId, coupon_id: input.couponId, customer_id: input.customerId ?? null, appointment_id: appt.id, status: 'reserved' })
      .execute();
  }
  if (input.customerId) {
    await ensureVisitedRelation(ctx, input.customerId, input.shopId);
    await recomputeCustomerStats(ctx, input.customerId);
  }
  await recordEvent(ctx, appt.id, 'created', { source: input.source, staffId: resolved.staffId, autoAssigned: resolved.autoAssigned });
  await audit(ctx, { action: 'appointment.create', resourceType: 'appointment', resourceId: appt.id, shopId: input.shopId, after: { ...input, staffId: resolved.staffId } });
  await emit(ctx, {
    type: 'appointment.created',
    aggregateType: 'appointment',
    aggregateId: appt.id,
    payload: {
      shopId: input.shopId,
      customerId: input.customerId ?? null,
      staffId: resolved.staffId,
      startAt: startAt.toISOString(),
      source: input.source,
      sourceDetail: input.sourceDetail ?? {},
      status,
      version: 1,
    },
  });
  return getAppointmentUnchecked(ctx, appt.id);
}

async function insertServicesAndResources(ctx: Ctx, appointmentId: string, resolved: ResolvedPlan) {
  await ctx.trx
    .insertInto('appointment_services')
    .values(
      resolved.plan.services.map((s, i) => ({
        organization_id: ctx.actor.organizationId,
        appointment_id: appointmentId,
        menu_id: s.menuId,
        name: s.name,
        duration_min: s.durationMin,
        price: s.price,
        tax_rate_bp: s.taxRateBp,
        staff_id: resolved.staffId,
        start_offset_min: s.offsetMin,
        sort_order: i,
      })),
    )
    .execute();
  if (resolved.resources.length) {
    await ctx.trx
      .insertInto('appointment_resources')
      .values(resolved.resources.map((r) => ({ organization_id: ctx.actor.organizationId, appointment_id: appointmentId, resource_id: r.resourceId, start_at: r.start, end_at: r.end })))
      .execute();
  }
}

export async function getAppointmentUnchecked(ctx: Ctx, id: string) {
  const a = await ctx.trx
    .selectFrom('appointments')
    .leftJoin('customers', 'customers.id', 'appointments.customer_id')
    .leftJoin('staffs', 'staffs.id', 'appointments.staff_id')
    .selectAll('appointments')
    .select([
      'customers.last_name as customer_last_name',
      'customers.first_name as customer_first_name',
      'customers.last_name_kana as customer_last_name_kana',
      'customers.first_name_kana as customer_first_name_kana',
      'customers.phone as customer_phone',
      'customers.visit_count as customer_visit_count',
      'staffs.display_name as staff_name',
      'staffs.color as staff_color',
    ])
    .where('appointments.id', '=', id)
    .where('appointments.deleted_at', 'is', null)
    .executeTakeFirst();
  if (!a) throw Errors.notFound('予約', id);
  const [services, resources] = await Promise.all([
    ctx.trx.selectFrom('appointment_services').select(['id', 'menu_id', 'name', 'duration_min', 'price', 'tax_rate_bp', 'staff_id', 'start_offset_min']).where('appointment_id', '=', id).orderBy('sort_order').execute(),
    ctx.trx
      .selectFrom('appointment_resources')
      .innerJoin('resources', 'resources.id', 'appointment_resources.resource_id')
      .select(['appointment_resources.resource_id', 'resources.name', 'resources.resource_type', 'appointment_resources.start_at', 'appointment_resources.end_at'])
      .where('appointment_resources.appointment_id', '=', id)
      .where('appointment_resources.is_active', '=', true)
      .execute(),
  ]);
  const customerName = a.customer_id ? `${a.customer_last_name ?? ''} ${a.customer_first_name ?? ''}`.trim() || `${a.customer_last_name_kana ?? ''} ${a.customer_first_name_kana ?? ''}`.trim() : null;
  return { ...a, customer_name: customerName, is_new_customer: a.customer_id ? (a.customer_visit_count ?? 0) === 0 : null, services, resources };
}

export async function getAppointment(ctx: Ctx, id: string) {
  requirePermission(ctx.actor, 'appointment.read');
  const a = await getAppointmentUnchecked(ctx, id);
  assertShopAccess(ctx.actor, a.shop_id);
  return a;
}

export async function listAppointments(ctx: Ctx, input: ListAppointmentsInput) {
  requirePermission(ctx.actor, 'appointment.read');
  let q = ctx.trx
    .selectFrom('appointments')
    .leftJoin('customers', 'customers.id', 'appointments.customer_id')
    .leftJoin('staffs', 'staffs.id', 'appointments.staff_id')
    .select([
      'appointments.id',
      'appointments.shop_id',
      'appointments.customer_id',
      'appointments.staff_id',
      'appointments.is_nominated',
      'appointments.booking_reference',
      'appointments.start_at',
      'appointments.end_at',
      'appointments.occupied_start_at',
      'appointments.occupied_end_at',
      'appointments.status',
      'appointments.source',
      'appointments.is_consultation',
      'appointments.estimated_total',
      'appointments.customer_note',
      'appointments.staff_note',
      'appointments.version',
      sql<string>`trim(coalesce(customers.last_name, '') || ' ' || coalesce(customers.first_name, ''))`.as('customer_name'),
      sql<string>`trim(coalesce(customers.last_name_kana, '') || ' ' || coalesce(customers.first_name_kana, ''))`.as('customer_name_kana'),
      'customers.visit_count as customer_visit_count',
      'staffs.display_name as staff_name',
      'staffs.color as staff_color',
    ])
    .where('appointments.deleted_at', 'is', null)
    .orderBy('appointments.start_at')
    .limit(input.limit);
  if (input.shopId) {
    assertShopAccess(ctx.actor, input.shopId);
    q = q.where('appointments.shop_id', '=', input.shopId);
  } else if (ctx.actor.kind === 'staff' && !ctx.actor.allShops) {
    q = q.where('appointments.shop_id', 'in', ctx.actor.shopIds.length ? [...ctx.actor.shopIds] : ['00000000-0000-0000-0000-000000000000']);
  }
  if (input.date && input.shopId) {
    const shop = await loadShop(ctx, input.shopId);
    const b = dayBounds(input.date, shop.timezone);
    q = q.where('appointments.start_at', '>=', b.start).where('appointments.start_at', '<', b.end);
  }
  if (input.from) q = q.where('appointments.end_at', '>', new Date(input.from));
  if (input.to) q = q.where('appointments.start_at', '<', new Date(input.to));
  if (input.staffId) q = q.where('appointments.staff_id', '=', input.staffId);
  if (input.customerId) q = q.where('appointments.customer_id', '=', input.customerId);
  if (input.status) q = q.where('appointments.status', 'in', Array.isArray(input.status) ? input.status : [input.status]);
  if (input.source) q = q.where('appointments.source', '=', input.source);
  const rows = await q.execute();
  const ids = rows.map((r) => r.id);
  const services = ids.length
    ? await ctx.trx.selectFrom('appointment_services').select(['appointment_id', 'menu_id', 'name', 'duration_min', 'price']).where('appointment_id', 'in', ids).orderBy('sort_order').execute()
    : [];
  return rows.map((r) => ({
    ...r,
    is_new_customer: r.customer_id ? (r.customer_visit_count ?? 0) === 0 : null,
    services: services.filter((s) => s.appointment_id === r.id).map(({ appointment_id: _a, ...s }) => s),
  }));
}

async function lockAppointment(ctx: Ctx, id: string, expectedVersion?: number) {
  const a = await ctx.trx.selectFrom('appointments').selectAll().where('id', '=', id).where('deleted_at', 'is', null).forUpdate().executeTakeFirst();
  if (!a) throw Errors.notFound('予約', id);
  if (expectedVersion !== undefined && a.version !== expectedVersion) {
    throw Errors.conflict('VERSION_CONFLICT', '他の操作で予約が更新されています。最新の内容を確認してください', { currentVersion: a.version });
  }
  return a;
}

export async function updateAppointment(ctx: Ctx, id: string, input: UpdateAppointmentInput, opts: CreateOptions = {}) {
  if (!opts.trusted) requirePermission(ctx.actor, 'appointment.write');
  const before = await lockAppointment(ctx, id, input.version);
  if (!opts.trusted) assertShopAccess(ctx.actor, before.shop_id);
  if (!['tentative', 'confirmed', 'checked_in'].includes(before.status)) {
    throw Errors.business('APPOINTMENT_NOT_EDITABLE', 'この状態の予約は変更できません', { status: before.status });
  }
  if (input.customerId && !opts.trusted) await assertCustomerAccess(ctx, input.customerId);

  const currentServices = await ctx.trx.selectFrom('appointment_services').select(['menu_id']).where('appointment_id', '=', id).orderBy('sort_order').execute();
  const menuIds = input.menuIds ?? currentServices.map((s) => s.menu_id!).filter(Boolean);
  const startAt = input.startAt ? new Date(input.startAt) : before.start_at;
  const staffChanged = input.staffId !== undefined && input.staffId !== before.staff_id;
  const scheduleChanged = staffChanged || !!input.menuIds || (input.startAt !== undefined && startAt.getTime() !== before.start_at.getTime());

  const patch: Record<string, unknown> = {
    customer_note: input.customerNote,
    staff_note: input.staffNote,
    customer_id: input.customerId,
    is_nominated: input.isNominated,
    coupon_id: input.couponId,
    updated_by: auditUserId(ctx.actor),
    trace_id: ctx.meta.traceId ?? null,
    version: before.version + 1,
  };

  if (scheduleChanged) {
    const resolved = await resolvePlan(ctx, {
      shopId: before.shop_id,
      staffId: input.staffId === undefined ? before.staff_id : input.staffId,
      startAt,
      menuIds,
      publicBooking: opts.publicBooking,
      allowOutsideSchedule: !opts.publicBooking && input.allowOutsideSchedule,
      excludeAppointmentId: id,
    });
    Object.assign(patch, {
      staff_id: resolved.staffId,
      start_at: startAt,
      end_at: addMinutes(startAt, resolved.plan.durationMin),
      occupied_start_at: resolved.occupied.start,
      occupied_end_at: resolved.occupied.end,
      estimated_total: resolved.plan.services.reduce((s, x) => s + x.price, 0),
      is_consultation: resolved.menus.some((m) => m.isConsultation),
    });
    await ctx.trx.deleteFrom('appointment_services').where('appointment_id', '=', id).execute();
    await ctx.trx.deleteFrom('appointment_resources').where('appointment_id', '=', id).execute();
    await ctx.trx.updateTable('appointments').set(patch).where('id', '=', id).execute();
    await insertServicesAndResources(ctx, id, resolved);
  } else {
    await ctx.trx.updateTable('appointments').set(patch).where('id', '=', id).execute();
  }

  const eventType = scheduleChanged ? 'rescheduled' : 'updated';
  await recordEvent(ctx, id, eventType, {
    from: { startAt: before.start_at, staffId: before.staff_id },
    to: { startAt, staffId: patch.staff_id ?? before.staff_id },
  });
  const after = await getAppointmentUnchecked(ctx, id);
  await audit(ctx, {
    action: `appointment.${eventType}`,
    resourceType: 'appointment',
    resourceId: id,
    shopId: before.shop_id,
    before: { start_at: before.start_at, staff_id: before.staff_id, customer_id: before.customer_id },
    after: { start_at: after.start_at, staff_id: after.staff_id, customer_id: after.customer_id },
  });
  for (const cid of new Set([before.customer_id, after.customer_id].filter(Boolean) as string[])) await recomputeCustomerStats(ctx, cid);
  await emit(ctx, {
    type: `appointment.${eventType}`,
    aggregateType: 'appointment',
    aggregateId: id,
    payload: {
      shopId: before.shop_id,
      customerId: after.customer_id,
      staffId: after.staff_id,
      startAt: after.start_at.toISOString(),
      previousStartAt: before.start_at.toISOString(),
      previousStaffId: before.staff_id,
      source: after.source,
      version: after.version,
    },
  });
  return after;
}

export async function transitionAppointment(
  ctx: Ctx,
  id: string,
  to: Status,
  opts: { version?: number; reason?: string; cancelledBy?: 'customer' | 'staff' | 'system' | 'external'; trusted?: boolean } = {},
) {
  if (!opts.trusted) requirePermission(ctx.actor, 'appointment.write');
  const a = await lockAppointment(ctx, id, opts.version);
  if (!opts.trusted) assertShopAccess(ctx.actor, a.shop_id);
  const from = a.status as Status;
  if (from === to) return getAppointmentUnchecked(ctx, id);
  if (!TRANSITIONS[from].includes(to)) {
    throw Errors.business('INVALID_TRANSITION', `予約を「${from}」から「${to}」へ変更できません`, { from, to });
  }
  const now = new Date();
  const patch: Record<string, unknown> = { status: to, version: a.version + 1, updated_by: auditUserId(ctx.actor) };
  if (to === 'confirmed') {
    patch.confirmed_at = a.confirmed_at ?? now;
    if (from === 'cancelled' || from === 'no_show') {
      // restoring: the slot must still be free (exclusion constraint will reject otherwise)
      patch.cancelled_at = null;
      patch.cancel_reason = null;
      patch.cancelled_by_type = null;
      patch.no_show_at = null;
    }
  }
  if (to === 'checked_in') patch.checked_in_at = now;
  if (to === 'completed') patch.completed_at = now;
  if (to === 'cancelled') {
    if (!opts.cancelledBy && ctx.actor.kind === 'customer') opts.cancelledBy = 'customer';
    patch.cancelled_at = now;
    patch.cancel_reason = opts.reason ?? null;
    patch.cancelled_by_type = opts.cancelledBy ?? (ctx.actor.kind === 'staff' ? 'staff' : 'system');
  }
  if (to === 'no_show') {
    if (a.start_at > now) throw Errors.business('NO_SHOW_BEFORE_START', '開始時刻前に無断キャンセルにはできません');
    patch.no_show_at = now;
  }
  await ctx.trx.updateTable('appointments').set(patch).where('id', '=', id).execute();

  const releasing = to === 'cancelled' || to === 'no_show';
  const restoring = (from === 'cancelled' || from === 'no_show') && to === 'confirmed';
  if (releasing) {
    await ctx.trx.updateTable('appointment_resources').set({ is_active: false }).where('appointment_id', '=', id).execute();
    await ctx.trx.updateTable('coupon_redemptions').set({ status: 'released' }).where('appointment_id', '=', id).where('status', '=', 'reserved').execute();
  }
  if (restoring) {
    await ctx.trx.updateTable('appointment_resources').set({ is_active: true }).where('appointment_id', '=', id).execute();
    await ctx.trx.updateTable('coupon_redemptions').set({ status: 'reserved' }).where('appointment_id', '=', id).where('status', '=', 'released').execute();
  }

  await recordEvent(ctx, id, to === 'confirmed' && restoring ? 'restored' : to, { from, reason: opts.reason });
  await audit(ctx, { action: `appointment.${to}`, resourceType: 'appointment', resourceId: id, shopId: a.shop_id, before: { status: from }, after: { status: to, reason: opts.reason } });
  if (a.customer_id) await recomputeCustomerStats(ctx, a.customer_id);
  await emit(ctx, {
    type: `appointment.${to === 'confirmed' && restoring ? 'restored' : to}`,
    aggregateType: 'appointment',
    aggregateId: id,
    payload: {
      shopId: a.shop_id,
      customerId: a.customer_id,
      staffId: a.staff_id,
      startAt: a.start_at.toISOString(),
      from,
      to,
      reason: opts.reason ?? null,
      cancelledBy: patch.cancelled_by_type ?? null,
      source: a.source,
      version: a.version + 1,
    },
  });
  return getAppointmentUnchecked(ctx, id);
}

export async function appointmentHistory(ctx: Ctx, id: string) {
  await getAppointment(ctx, id);
  return ctx.trx.selectFrom('appointment_events').select(['id', 'event_type', 'actor_type', 'actor_id', 'payload', 'created_at']).where('appointment_id', '=', id).orderBy('created_at').execute();
}

/** Appointments needing attention: tentative approvals, past-start still confirmed (no-show candidates) */
export async function attentionList(ctx: Ctx, shopId: string) {
  requirePermission(ctx.actor, 'appointment.read');
  assertShopAccess(ctx.actor, shopId);
  const now = new Date();
  const [tentative, overdue] = await Promise.all([
    ctx.trx.selectFrom('appointments').select(['id', 'start_at', 'customer_id', 'staff_id', 'source']).where('shop_id', '=', shopId).where('status', '=', 'tentative').where('deleted_at', 'is', null).orderBy('start_at').limit(100).execute(),
    ctx.trx
      .selectFrom('appointments')
      .select(['id', 'start_at', 'customer_id', 'staff_id', 'source'])
      .where('shop_id', '=', shopId)
      .where('status', '=', 'confirmed')
      .where('start_at', '<', addMinutes(now, -30))
      .where('start_at', '>', addMinutes(now, -7 * 24 * 60))
      .where('deleted_at', 'is', null)
      .orderBy('start_at')
      .limit(100)
      .execute(),
  ]);
  return { tentative, noShowCandidates: overdue };
}

export { ACTIVE_STATUSES };
