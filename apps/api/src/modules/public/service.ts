import { sql } from 'kysely';
import { systemActor, type Ctx, type RequestMeta } from '../../auth/actor.js';
import { signCustomerToken } from '../../auth/jwt.js';
import { config } from '../../config.js';
import { withSystem, withTenant } from '../../db/tenant.js';
import { issueAccessToken } from '../../lib/access-tokens.js';
import { audit } from '../../lib/audit.js';
import { hashToken, otpCode } from '../../lib/crypto.js';
import { Errors } from '../../lib/errors.js';
import { verifyLineIdToken } from '../../lib/line-auth.js';
import { sendEmail, sendSms } from '../../lib/mailer.js';
import { normalizeEmail, normalizePhone } from '../../lib/normalize.js';
import { parseShopSettings } from '../../lib/shop-settings.js';
import { addMinutes, dateRange, localDate } from '../../lib/time.js';
import { createAppointment, getAppointmentUnchecked, transitionAppointment, updateAppointment } from '../appointments/service.js';
import { listCoupons, effectiveMenus } from '../catalog/service.js';
import { resolveCustomer } from '../customers/identity.js';
import { getBusinessHours, listExceptions } from '../schedules/service.js';

export interface PublicShop {
  organizationId: string;
  shopId: string;
  timezone: string;
}

/** Resolve a public shop slug → tenant (system lookup; only bookable shops are exposed) */
export async function resolveShopSlug(slug: string): Promise<PublicShop> {
  const shop = await withSystem((trx) =>
    trx
      .selectFrom('shops')
      .innerJoin('organizations', 'organizations.id', 'shops.organization_id')
      .select(['shops.id', 'shops.organization_id', 'shops.timezone', 'shops.public_booking_enabled', 'shops.status', 'organizations.status as org_status'])
      .where('shops.slug', '=', slug)
      .where('shops.deleted_at', 'is', null)
      .executeTakeFirst(),
  );
  if (!shop || shop.status !== 'active' || !shop.public_booking_enabled || !['active', 'trial'].includes(shop.org_status)) {
    throw Errors.notFound('店舗');
  }
  return { organizationId: shop.organization_id, shopId: shop.id, timezone: shop.timezone };
}

/** Tenant transaction for anonymous public requests */
export function publicTx<T>(shop: { organizationId: string }, meta: RequestMeta, fn: (ctx: Ctx) => Promise<T>) {
  return withTenant(shop.organizationId, (trx) => fn({ actor: systemActor(shop.organizationId, 'public'), trx, meta }), { traceId: meta.traceId });
}

export async function publicShopInfo(ctx: Ctx, shopId: string) {
  const shop = await ctx.trx
    .selectFrom('shops')
    .select(['id', 'name', 'slug', 'timezone', 'phone', 'postal_code', 'prefecture', 'city', 'address_line', 'description', 'settings'])
    .where('id', '=', shopId)
    .executeTakeFirstOrThrow();
  const settings = parseShopSettings(shop.settings);
  const today = localDate(new Date(), shop.timezone);
  const horizonEnd = dateRange(today, today).length ? localDate(addMinutes(new Date(), settings.booking.horizonDays * 1440), shop.timezone) : today;
  const [hours, exceptions, staff, menus, coupons] = await Promise.all([
    getBusinessHours(ctx, shopId),
    listExceptions(ctx, shopId, today, horizonEnd),
    ctx.trx
      .selectFrom('staffs')
      .innerJoin('staff_shop_assignments as a', 'a.staff_id', 'staffs.id')
      .select(['staffs.id', 'staffs.display_name', 'staffs.title', 'staffs.nomination_fee', 'staffs.public_profile', 'staffs.public_slug'])
      .where('a.shop_id', '=', shopId)
      .where('a.ended_on', 'is', null)
      .where('staffs.is_bookable', '=', true)
      .where('staffs.status', '=', 'active')
      .where('staffs.deleted_at', 'is', null)
      .orderBy('staffs.sort_order')
      .execute(),
    effectiveMenus(ctx, shopId, { publicOnly: true }),
    listCoupons(ctx, { shopId, publicOnly: true, activeAt: new Date() }),
  ]);
  const { settings: _s, ...publicShop } = shop;
  return {
    shop: publicShop,
    booking: {
      slotIntervalMin: settings.booking.slotIntervalMin,
      leadTimeMin: settings.booking.leadTimeMin,
      horizonDays: settings.booking.horizonDays,
      cancelDeadlineHours: settings.booking.cancelDeadlineHours,
      allowStaffSelection: settings.booking.allowStaffSelection,
      maxServicesPerBooking: settings.booking.maxServicesPerBooking,
      requireApproval: settings.booking.requireApproval,
    },
    businessHours: hours,
    exceptions,
    staff: settings.booking.allowStaffSelection ? staff : [],
    menus: menus.map((m) => ({
      id: m.id,
      categoryId: m.categoryId,
      categoryName: m.categoryName,
      name: m.name,
      description: m.description,
      durationMin: m.durationMin,
      price: m.price,
      isConsultation: m.isConsultation,
      newCustomerOnly: m.newCustomerOnly,
      staffIds: m.staffIds,
    })),
    coupons: coupons.map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      discountType: c.discount_type,
      discountValue: c.discount_value,
      applicableMenuIds: c.applicable_menu_ids,
      minAmount: c.min_amount,
      validUntil: c.valid_until,
      newCustomerOnly: c.new_customer_only,
    })),
  };
}

// ---------------------------------------------------------------- customer auth

async function lineChannelFor(ctx: Ctx, shopId: string) {
  // shop-specific channel wins over organization-wide channel (要件 23.1: 店舗単位/法人単位の両対応)
  return ctx.trx
    .selectFrom('line_channels')
    .select(['id', 'channel_id', 'login_channel_id', 'shop_id'])
    .where('status', '=', 'active')
    .where((eb) => eb.or([eb('shop_id', '=', shopId), eb('shop_id', 'is', null)]))
    .orderBy((eb) => eb.case().when('shop_id', 'is', null).then(1).else(0).end())
    .executeTakeFirst();
}

export async function loginWithLine(shop: PublicShop, idToken: string, meta: RequestMeta) {
  // verify with LINE outside any DB transaction (external latency must not hold a connection/locks)
  const channel = await publicTx(shop, meta, (ctx) => lineChannelFor(ctx, shop.shopId));
  const profile = await verifyLineIdToken(idToken, channel?.login_channel_id);
  return publicTx(shop, meta, async (ctx) => {
    const resolved = await resolveCustomer(ctx, {
      provider: 'line',
      providerAccountId: channel?.channel_id ?? 'default',
      externalId: profile.userId,
      displayName: profile.displayName,
      profile: { pictureUrl: profile.pictureUrl },
      email: profile.email,
      shopId: shop.shopId,
      acquisitionSource: 'line',
    });
    await ctx.trx
      .updateTable('customer_identities')
      .set({ is_following: true, display_name: profile.displayName ?? null })
      .where('customer_id', '=', resolved.customerId)
      .where('provider', '=', 'line')
      .where('external_id', '=', profile.userId)
      .execute();
    const token = await signCustomerToken({ sub: resolved.customerId, org: shop.organizationId, via: 'line' });
    const customer = await ctx.trx.selectFrom('customers').select(['last_name', 'first_name', 'phone', 'email']).where('id', '=', resolved.customerId).executeTakeFirstOrThrow();
    return {
      token,
      customerId: resolved.customerId,
      isNew: resolved.created,
      // a LINE-only customer must still provide name/phone before booking
      profileComplete: !!(customer.last_name && customer.phone),
    };
  });
}

export async function requestCustomerOtp(shop: PublicShop, destination: string, meta: RequestMeta) {
  const isEmail = destination.includes('@');
  const normalized = isEmail ? normalizeEmail(destination) : normalizePhone(destination);
  if (!normalized) throw Errors.validation('電話番号またはメールアドレスが正しくありません');
  const code = otpCode();
  const challenge = await withSystem(async (trx) => {
    // basic abuse guard: max 5 OTPs per destination per hour
    const recent = await trx
      .selectFrom('otp_challenges')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('destination', '=', normalized)
      .where('created_at', '>', new Date(Date.now() - 3600_000))
      .executeTakeFirstOrThrow();
    if (Number(recent.n) >= 5) throw Errors.rateLimited('確認コードの送信回数が上限に達しました。しばらくしてから再試行してください');
    return trx
      .insertInto('otp_challenges')
      .values({
        organization_id: shop.organizationId,
        purpose: 'customer_login',
        channel: isEmail ? 'email' : 'sms',
        destination: normalized,
        code_hash: hashToken(code),
        expires_at: new Date(Date.now() + 10 * 60_000),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
  });
  const text = `ご予約確認コード: ${code}（10分間有効）`;
  if (isEmail) await sendEmail({ to: normalized, subject: '確認コード', text });
  else await sendSms({ to: normalized, text });
  void meta;
  return { challengeId: challenge.id, channel: isEmail ? 'email' : 'sms', ...(config.DEV_EXPOSE_OTP ? { devCode: code } : {}) };
}

export async function verifyCustomerOtp(challengeId: string, code: string, profile: { lastName?: string; firstName?: string; lastNameKana?: string; firstNameKana?: string } | undefined, meta: RequestMeta) {
  const ch = await withSystem(async (trx) => {
    const row = await trx.selectFrom('otp_challenges').selectAll().where('id', '=', challengeId).forUpdate().executeTakeFirst();
    if (!row || row.purpose !== 'customer_login' || !row.organization_id || row.consumed_at || row.expires_at < new Date() || row.attempts >= row.max_attempts) {
      return null;
    }
    if (hashToken(code) !== row.code_hash) {
      await trx.updateTable('otp_challenges').set({ attempts: row.attempts + 1 }).where('id', '=', row.id).execute();
      return null;
    }
    await trx.updateTable('otp_challenges').set({ consumed_at: new Date() }).where('id', '=', row.id).execute();
    return row;
  });
  if (!ch) throw Errors.unauthenticated('確認コードが正しくないか、有効期限が切れています', 'INVALID_OTP');
  const orgId = ch.organization_id!;
  return withTenant(orgId, async (trx) => {
    const ctx: Ctx = { actor: systemActor(orgId, 'public'), trx, meta };
    const resolved = await resolveCustomer(ctx, {
      phone: ch.channel === 'sms' ? ch.destination : null,
      email: ch.channel === 'email' ? ch.destination : null,
      lastName: profile?.lastName,
      firstName: profile?.firstName,
      lastNameKana: profile?.lastNameKana,
      firstNameKana: profile?.firstNameKana,
      acquisitionSource: 'web',
    });
    const token = await signCustomerToken({ sub: resolved.customerId, org: orgId, via: 'otp' });
    return { token, customerId: resolved.customerId, isNew: resolved.created };
  });
}

// ---------------------------------------------------------------- customer self-service

export async function customerProfile(ctx: Ctx, customerId: string) {
  const c = await ctx.trx
    .selectFrom('customers')
    .select(['id', 'last_name', 'first_name', 'last_name_kana', 'first_name_kana', 'phone', 'email', 'birthday', 'gender', 'point_balance', 'marketing_opt_in', 'visit_count', 'status'])
    .where('id', '=', customerId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (!c || c.status === 'merged' || c.status === 'deleted') throw Errors.unauthenticated();
  return c;
}

export async function updateCustomerProfile(
  ctx: Ctx,
  customerId: string,
  input: Partial<{ lastName: string; firstName: string; lastNameKana: string; firstNameKana: string; phone: string; email: string | null; birthday: string | null; marketingOptIn: boolean }>,
) {
  await ctx.trx
    .updateTable('customers')
    .set({
      last_name: input.lastName,
      first_name: input.firstName,
      last_name_kana: input.lastNameKana,
      first_name_kana: input.firstNameKana,
      phone: input.phone,
      phone_normalized: input.phone !== undefined ? normalizePhone(input.phone) : undefined,
      email: input.email !== undefined ? normalizeEmail(input.email) : undefined,
      birthday: input.birthday,
      marketing_opt_in: input.marketingOptIn,
    })
    .where('id', '=', customerId)
    .execute();
  await audit(ctx, { action: 'customer.self_update', resourceType: 'customer', resourceId: customerId, after: input });
  return customerProfile(ctx, customerId);
}

export function sanitizeAppointment(a: Awaited<ReturnType<typeof getAppointmentUnchecked>>, shop: { name: string; slug?: string; timezone?: string; cancelDeadlineHours: number }) {
  const deadline = addMinutes(a.start_at, -shop.cancelDeadlineHours * 60);
  const active = ['tentative', 'confirmed'].includes(a.status);
  return {
    id: a.id,
    bookingReference: a.booking_reference,
    shopId: a.shop_id,
    shopName: shop.name,
    shopSlug: shop.slug ?? null,
    timezone: shop.timezone ?? 'Asia/Tokyo',
    staffId: a.staff_id,
    staffName: a.staff_name,
    isNominated: a.is_nominated,
    startAt: a.start_at,
    endAt: a.end_at,
    status: a.status,
    services: a.services.map((s) => ({ menuId: s.menu_id, name: s.name, durationMin: s.duration_min, price: s.price })),
    estimatedTotal: a.estimated_total,
    customerNote: a.customer_note,
    version: a.version,
    cancelDeadline: deadline,
    canModify: active && deadline > new Date(),
  };
}

async function shopMeta(ctx: Ctx, shopId: string) {
  const s = await ctx.trx.selectFrom('shops').select(['name', 'slug', 'timezone', 'settings']).where('id', '=', shopId).executeTakeFirstOrThrow();
  return { name: s.name, slug: s.slug, timezone: s.timezone, cancelDeadlineHours: parseShopSettings(s.settings).booking.cancelDeadlineHours, settings: parseShopSettings(s.settings) };
}

export interface PublicBookingInput {
  menuIds: string[];
  staffId?: string | null;
  startAt: string;
  couponId?: string | null;
  customerNote?: string | null;
  channel?: 'web' | 'line';
  clientRequestId?: string;
  utm?: Record<string, string>;
  referralCode?: string;
  customer?: { lastName: string; firstName: string; lastNameKana?: string; firstNameKana?: string; phone: string; email?: string | null };
}

export async function createPublicBooking(ctx: Ctx, shop: PublicShop, input: PublicBookingInput, customerId: string | null, via: 'line' | 'otp' | 'link' | null) {
  // replay protection for clients without Idempotency-Key context
  if (input.clientRequestId) {
    const existing = await ctx.trx
      .selectFrom('appointments')
      .select('id')
      .where('shop_id', '=', shop.shopId)
      .where(sql<string>`source_detail->>'clientRequestId'`, '=', input.clientRequestId)
      .where('created_at', '>', new Date(Date.now() - 86400_000))
      .executeTakeFirst();
    if (existing) {
      const meta = await shopMeta(ctx, shop.shopId);
      return { appointment: sanitizeAppointment(await getAppointmentUnchecked(ctx, existing.id), meta), manageUrl: null, replayed: true };
    }
  }
  let cid = customerId;
  if (!cid) {
    if (!input.customer) throw Errors.validation('お客様情報を入力してください');
    // guest contact details are unverified: only link to an existing record when the name matches too
    const resolved = await resolveCustomer(ctx, { ...input.customer, shopId: shop.shopId, acquisitionSource: input.channel ?? 'web', contactMatchRequiresName: true });
    cid = resolved.customerId;
  } else if (input.customer) {
    // fill missing profile fields for LINE-first customers
    const current = await ctx.trx.selectFrom('customers').select(['last_name', 'phone']).where('id', '=', cid).executeTakeFirstOrThrow();
    if (!current.last_name || !current.phone) {
      await updateCustomerProfile(ctx, cid, {
        lastName: current.last_name ? undefined : input.customer.lastName,
        firstName: current.last_name ? undefined : input.customer.firstName,
        lastNameKana: input.customer.lastNameKana,
        firstNameKana: input.customer.firstNameKana,
        phone: current.phone ? undefined : input.customer.phone,
      });
    }
  }
  const meta = await shopMeta(ctx, shop.shopId);
  if (input.staffId && !meta.settings.booking.allowStaffSelection) throw Errors.validation('この店舗ではスタッフ指名はできません');

  const appt = await createAppointment(
    ctx,
    {
      shopId: shop.shopId,
      customerId: cid,
      staffId: input.staffId ?? null,
      startAt: input.startAt,
      menuIds: input.menuIds,
      couponId: input.couponId ?? null,
      source: via === 'line' || input.channel === 'line' ? 'line' : 'web',
      sourceDetail: {
        ...(input.clientRequestId ? { clientRequestId: input.clientRequestId } : {}),
        ...(input.utm ? { utm: input.utm } : {}),
        ...(input.referralCode ? { referralCode: input.referralCode } : {}),
      },
      customerNote: input.customerNote ?? null,
    },
    { publicBooking: true, trusted: true },
  );
  const ttl = Math.max(3600, Math.round((appt.end_at.getTime() - Date.now()) / 1000) + 86400);
  const { token } = await issueAccessToken(ctx, { purpose: 'booking_manage', resourceType: 'appointment', resourceId: appt.id, customerId: cid, ttlSec: ttl });
  return { appointment: sanitizeAppointment(appt, meta), manageUrl: `${config.WEB_BASE_URL}/b/manage/${token}`, replayed: false };
}

export async function customerAppointments(ctx: Ctx, customerId: string, scope: 'upcoming' | 'past') {
  const now = new Date();
  let q = ctx.trx.selectFrom('appointments').select(['id', 'shop_id']).where('customer_id', '=', customerId).where('deleted_at', 'is', null);
  q = scope === 'upcoming' ? q.where('end_at', '>=', now).where('status', 'in', ['tentative', 'confirmed', 'checked_in']).orderBy('start_at') : q.where('start_at', '<', now).orderBy('start_at', 'desc').limit(50);
  const rows = await q.execute();
  const metas = new Map<string, Awaited<ReturnType<typeof shopMeta>>>();
  const out = [];
  for (const r of rows) {
    if (!metas.has(r.shop_id)) metas.set(r.shop_id, await shopMeta(ctx, r.shop_id));
    out.push(sanitizeAppointment(await getAppointmentUnchecked(ctx, r.id), metas.get(r.shop_id)!));
  }
  return out;
}

async function ownAppointment(ctx: Ctx, customerId: string, appointmentId: string) {
  const a = await getAppointmentUnchecked(ctx, appointmentId);
  if (a.customer_id !== customerId) throw Errors.notFound('予約', appointmentId);
  const meta = await shopMeta(ctx, a.shop_id);
  return { a, meta };
}

function assertModifiable(a: { start_at: Date; status: string }, deadlineHours: number) {
  if (!['tentative', 'confirmed'].includes(a.status)) throw Errors.business('APPOINTMENT_NOT_EDITABLE', 'この予約は変更できません');
  if (addMinutes(a.start_at, -deadlineHours * 60) <= new Date()) {
    throw Errors.business('CANCEL_DEADLINE_PASSED', `予約の変更・キャンセルは${deadlineHours}時間前までです。店舗へ直接ご連絡ください`);
  }
}

export async function customerCancel(ctx: Ctx, customerId: string, appointmentId: string, reason?: string) {
  const { a, meta } = await ownAppointment(ctx, customerId, appointmentId);
  assertModifiable(a, meta.cancelDeadlineHours);
  const updated = await transitionAppointment(ctx, appointmentId, 'cancelled', { reason: reason ?? 'お客様によるキャンセル', cancelledBy: 'customer', trusted: true });
  return sanitizeAppointment(updated, meta);
}

export async function customerReschedule(ctx: Ctx, customerId: string, appointmentId: string, input: { startAt: string; staffId?: string | null; version: number }) {
  const { a, meta } = await ownAppointment(ctx, customerId, appointmentId);
  assertModifiable(a, meta.cancelDeadlineHours);
  const updated = await updateAppointment(ctx, appointmentId, { version: input.version, startAt: input.startAt, staffId: input.staffId === undefined ? undefined : input.staffId }, { publicBooking: true, trusted: true });
  return sanitizeAppointment(updated, meta);
}

export { shopMeta };
