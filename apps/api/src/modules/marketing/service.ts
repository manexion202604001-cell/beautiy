import { sql } from 'kysely';
import { accessibleShopIds, assertShopAccess, requireAnyPermission, requirePermission, systemActor, type Ctx, type RequestMeta } from '../../auth/actor.js';
import { config } from '../../config.js';
import { withSystem, withTenant } from '../../db/tenant.js';
import { audit, diff } from '../../lib/audit.js';
import { hmacSha256 } from '../../lib/crypto.js';
import { Errors } from '../../lib/errors.js';
import { decodeCursor, paginate } from '../../lib/pagination.js';
import { dayBounds } from '../../lib/time.js';
import { assertCustomerAccess } from '../customers/access.js';
import { displayName } from '../customers/service.js';
import { ensureReferralLink, insertReferralLink, referralLinkColumns, referralUrl, resolveReferralCode, type ReferralLinkRow } from './api.js';
import type { CreateReferralLinkInput, ListReferralLinksInput, UpdateReferralLinkInput } from './schemas.js';

// ---------------------------------------------------------------- helpers

function present(link: ReferralLinkRow) {
  return { ...link, url: referralUrl(link.code) };
}

async function validateRefs(ctx: Ctx, input: { shopId?: string | null; staffId?: string | null; customerId?: string | null; target?: string; targetId?: string | null }) {
  if (input.shopId) {
    assertShopAccess(ctx.actor, input.shopId);
    const shop = await ctx.trx.selectFrom('shops').select('id').where('id', '=', input.shopId).where('deleted_at', 'is', null).executeTakeFirst();
    if (!shop) throw Errors.notFound('店舗', input.shopId);
  }
  if (input.staffId) {
    const staff = await ctx.trx.selectFrom('staffs').select('id').where('id', '=', input.staffId).where('deleted_at', 'is', null).executeTakeFirst();
    if (!staff) throw Errors.notFound('スタッフ', input.staffId);
  }
  if (input.customerId) await assertCustomerAccess(ctx, input.customerId);
  if (input.target === 'product') {
    if (!input.targetId) throw Errors.validation('商品リンクには対象商品(targetId)が必要です');
    const p = await ctx.trx.selectFrom('products').select('id').where('id', '=', input.targetId).where('deleted_at', 'is', null).executeTakeFirst();
    if (!p) throw Errors.notFound('商品', input.targetId);
  }
  if (input.target === 'profile') {
    const staffId = input.targetId ?? input.staffId;
    if (!staffId) throw Errors.validation('プロフィールリンクにはスタッフの指定が必要です');
    const staff = await ctx.trx.selectFrom('staffs').select('id').where('id', '=', staffId).where('deleted_at', 'is', null).executeTakeFirst();
    if (!staff) throw Errors.notFound('スタッフ', staffId);
  }
}

async function loadLink(ctx: Ctx, id: string) {
  requirePermission(ctx.actor, 'marketing.manage');
  const link = await ctx.trx.selectFrom('referral_links').select(referralLinkColumns).where('id', '=', id).where('deleted_at', 'is', null).executeTakeFirst();
  if (!link) throw Errors.notFound('紹介リンク', id);
  assertShopAccess(ctx.actor, link.shop_id);
  return link;
}

// ---------------------------------------------------------------- CRUD

export async function createReferralLink(ctx: Ctx, input: CreateReferralLinkInput) {
  requirePermission(ctx.actor, 'marketing.manage');
  await validateRefs(ctx, input);
  const link = await insertReferralLink(ctx, input);
  await audit(ctx, { action: 'referral_link.create', resourceType: 'referral_link', resourceId: link.id, shopId: link.shop_id, after: link });
  return present(link);
}

export async function listReferralLinks(ctx: Ctx, input: ListReferralLinksInput) {
  requirePermission(ctx.actor, 'marketing.manage');
  if (input.shopId) assertShopAccess(ctx.actor, input.shopId);
  let q = ctx.trx
    .selectFrom('referral_links')
    .select(referralLinkColumns.map((c) => `referral_links.${c}` as const))
    .select((eb) => [
      eb
        .selectFrom('referral_events')
        .select(eb.fn.countAll<number>().as('n'))
        .whereRef('referral_events.referral_link_id', '=', 'referral_links.id')
        .where('referral_events.event_type', '=', 'booking')
        .as('booking_count'),
      eb
        .selectFrom('referral_events')
        .select(eb.fn.countAll<number>().as('n'))
        .whereRef('referral_events.referral_link_id', '=', 'referral_links.id')
        .where('referral_events.event_type', '=', 'purchase')
        .as('purchase_count'),
    ])
    .where('referral_links.deleted_at', 'is', null);
  const shops = accessibleShopIds(ctx.actor);
  if (shops) q = q.where((eb) => eb.or([eb('referral_links.shop_id', 'is', null), eb('referral_links.shop_id', 'in', shops.length ? [...shops] : ['00000000-0000-0000-0000-000000000000'])]));
  if (input.shopId) q = q.where('referral_links.shop_id', '=', input.shopId);
  if (input.staffId) q = q.where('referral_links.staff_id', '=', input.staffId);
  if (input.customerId) q = q.where('referral_links.customer_id', '=', input.customerId);
  if (input.target) q = q.where('referral_links.target', '=', input.target);
  if (input.active !== undefined) q = q.where('referral_links.is_active', '=', input.active);
  const cursor = decodeCursor(input.cursor);
  if (cursor) q = q.where(sql`(referral_links.created_at, referral_links.id)`, '<', sql`(${cursor.v}::timestamptz, ${cursor.id}::uuid)`);
  const rows = await q.orderBy('referral_links.created_at', 'desc').orderBy('referral_links.id', 'desc').limit(input.limit + 1).execute();
  const page = paginate(rows, input.limit, (r) => r.created_at);
  return {
    items: page.items.map((r) => ({ ...present(r), booking_count: Number(r.booking_count ?? 0), purchase_count: Number(r.purchase_count ?? 0) })),
    nextCursor: page.nextCursor,
  };
}

export async function getReferralLink(ctx: Ctx, id: string) {
  return present(await loadLink(ctx, id));
}

export async function updateReferralLink(ctx: Ctx, id: string, input: UpdateReferralLinkInput) {
  const before = await loadLink(ctx, id);
  await validateRefs(ctx, { shopId: input.shopId, staffId: input.staffId, target: before.target, targetId: input.targetId === undefined ? before.target_id : input.targetId });
  const after = await ctx.trx
    .updateTable('referral_links')
    .set({
      name: input.name,
      shop_id: input.shopId,
      staff_id: input.staffId,
      target_id: input.targetId,
      utm: input.utm ? JSON.stringify(Object.fromEntries(Object.entries(input.utm).filter(([, v]) => v))) : undefined,
      is_active: input.isActive,
    })
    .where('id', '=', id)
    .returning(referralLinkColumns)
    .executeTakeFirstOrThrow();
  await audit(ctx, { action: 'referral_link.update', resourceType: 'referral_link', resourceId: id, shopId: after.shop_id, ...diff(before, after) });
  return present(after);
}

export async function deleteReferralLink(ctx: Ctx, id: string) {
  const before = await loadLink(ctx, id);
  await ctx.trx.updateTable('referral_links').set({ deleted_at: new Date(), is_active: false }).where('id', '=', id).execute();
  await audit(ctx, { action: 'referral_link.delete', resourceType: 'referral_link', resourceId: id, shopId: before.shop_id, before });
}

// ---------------------------------------------------------------- stats

export async function referralLinkStats(ctx: Ctx, id: string, range: { from?: string; to?: string }) {
  const link = await loadLink(ctx, id);
  const org = await ctx.trx.selectFrom('organizations').select('timezone').where('id', '=', ctx.actor.organizationId).executeTakeFirstOrThrow();
  const from = range.from ? dayBounds(range.from, org.timezone).start : null;
  const to = range.to ? dayBounds(range.to, org.timezone).end : null;
  const inRange = (col: string) =>
    sql<boolean>`(${from}::timestamptz IS NULL OR ${sql.ref(col)} >= ${from}::timestamptz) AND (${to}::timestamptz IS NULL OR ${sql.ref(col)} < ${to}::timestamptz)`;

  const counts = await ctx.trx
    .selectFrom('referral_events')
    .select(['event_type', (eb) => eb.fn.countAll<number>().as('n'), (eb) => eb.fn.sum<number>('amount').as('amount')])
    .where('referral_link_id', '=', id)
    .where(inRange('created_at'))
    .groupBy('event_type')
    .execute();
  const byType = new Map(counts.map((c) => [c.event_type, { n: Number(c.n), amount: Number(c.amount ?? 0) }]));

  // visits: completed POS transactions of the attributed appointments (net of refunds)
  const visits = await ctx.trx
    .selectFrom('referral_events as e')
    .innerJoin('transactions as t', 't.appointment_id', 'e.appointment_id')
    .select([(eb) => eb.fn.count<number>('t.id').distinct().as('n'), (eb) => eb.fn.sum<number>(sql`t.total - t.refunded_total`).as('revenue')])
    .where('e.referral_link_id', '=', id)
    .where('e.event_type', '=', 'booking')
    .where('t.status', 'in', ['completed', 'partially_refunded'])
    .where(inRange('e.created_at'))
    .executeTakeFirst();

  // purchases: paid EC orders attributed to the link (cancelled/refunded amounts excluded)
  const purchases = await ctx.trx
    .selectFrom('referral_events as e')
    .innerJoin('orders as o', 'o.id', 'e.order_id')
    .select([(eb) => eb.fn.count<number>('o.id').distinct().as('n'), (eb) => eb.fn.sum<number>(sql`o.total - o.refunded_amount`).as('revenue')])
    .where('e.referral_link_id', '=', id)
    .where('e.event_type', '=', 'purchase')
    .where('o.status', 'in', ['paid', 'processing', 'shipped', 'delivered'])
    .where(inRange('e.created_at'))
    .executeTakeFirst();

  const clicks = from || to ? (byType.get('click')?.n ?? 0) : link.click_count;
  const bookings = byType.get('booking')?.n ?? 0;
  const visitRevenue = Number(visits?.revenue ?? 0);
  const purchaseRevenue = Number(purchases?.revenue ?? 0);
  return {
    linkId: link.id,
    code: link.code,
    from: range.from ?? null,
    to: range.to ?? null,
    clicks,
    bookings,
    signups: byType.get('signup')?.n ?? 0,
    completedVisits: Number(visits?.n ?? 0),
    visitRevenue,
    purchases: Number(purchases?.n ?? 0),
    purchaseRevenue,
    revenue: visitRevenue + purchaseRevenue,
    conversionRate: clicks > 0 ? Math.round((bookings / clicks) * 10000) / 10000 : null,
  };
}

// ---------------------------------------------------------------- customer referral (お友達紹介)

export async function ensureCustomerReferralLinkUnchecked(ctx: Ctx, customerId: string) {
  // serialize find-or-create per customer
  const c = await ctx.trx
    .selectFrom('customers')
    .select(['id', 'last_name', 'first_name', 'last_name_kana', 'first_name_kana', 'primary_shop_id', 'status'])
    .where('id', '=', customerId)
    .where('deleted_at', 'is', null)
    .forUpdate()
    .executeTakeFirst();
  if (!c || c.status !== 'active') throw Errors.notFound('顧客', customerId);
  const link = await ensureReferralLink(ctx, {
    name: `お友達紹介（${displayName(c) || 'お客様'}）`,
    shopId: c.primary_shop_id,
    customerId,
    target: 'booking',
    utm: { source: 'referral', medium: 'friend', campaign: 'friend_referral' },
  });
  return present(link);
}

export async function customerReferralLink(ctx: Ctx, customerId: string) {
  requireAnyPermission(ctx.actor, 'marketing.manage', 'customer.write');
  await assertCustomerAccess(ctx, customerId);
  const link = await ensureCustomerReferralLinkUnchecked(ctx, customerId);
  await audit(ctx, { action: 'referral_link.customer', resourceType: 'referral_link', resourceId: link.id, metadata: { customerId } });
  return link;
}

// ---------------------------------------------------------------- public redirect

const BOT_UA = /bot|crawler|spider|facebookexternalhit|slackbot|discordbot|twitterbot|linkedinbot|whatsapp|embedly|preview|headless/i;

async function activeShopSlug(ctx: Ctx, shopId: string | null | undefined): Promise<string | null> {
  if (!shopId) return null;
  const s = await ctx.trx.selectFrom('shops').select('slug').where('id', '=', shopId).where('deleted_at', 'is', null).where('status', '=', 'active').executeTakeFirst();
  return s?.slug ?? null;
}

/** Landing shop: link shop → staff's (primary) shop → referring customer's shop → first active shop */
async function shopSlugForLink(ctx: Ctx, link: ReferralLinkRow): Promise<string | null> {
  const fromLink = await activeShopSlug(ctx, link.shop_id);
  if (fromLink) return fromLink;
  const staffId = link.target === 'profile' ? (link.target_id ?? link.staff_id) : link.staff_id;
  if (staffId) {
    const assignments = await ctx.trx.selectFrom('staff_shop_assignments').select('shop_id').where('staff_id', '=', staffId).where('ended_on', 'is', null).orderBy('is_primary', 'desc').execute();
    for (const a of assignments) {
      const slug = await activeShopSlug(ctx, a.shop_id);
      if (slug) return slug;
    }
  }
  if (link.customer_id) {
    const c = await ctx.trx.selectFrom('customers').select('primary_shop_id').where('id', '=', link.customer_id).executeTakeFirst();
    const slug = await activeShopSlug(ctx, c?.primary_shop_id);
    if (slug) return slug;
  }
  const first = await ctx.trx.selectFrom('shops').select('slug').where('deleted_at', 'is', null).where('status', '=', 'active').orderBy('created_at').executeTakeFirst();
  return first?.slug ?? null;
}

export function targetUrl(link: Pick<ReferralLinkRow, 'code' | 'target' | 'target_id' | 'staff_id' | 'utm'>, shopSlug: string): string {
  const base = config.WEB_BASE_URL.replace(/\/$/, '');
  const slug = encodeURIComponent(shopSlug);
  let path: string;
  switch (link.target) {
    case 'product':
      path = link.target_id ? `/shop/${slug}/products/${link.target_id}` : `/shop/${slug}`;
      break;
    case 'profile': {
      const staffId = link.target_id ?? link.staff_id;
      path = staffId ? `/s/${slug}/staff/${staffId}` : `/s/${slug}`;
      break;
    }
    case 'review':
      path = `/s/${slug}/reviews`;
      break;
    default:
      path = `/book/${slug}`;
  }
  const url = new URL(base + path);
  url.searchParams.set('ref', link.code);
  if (link.target === 'booking' && link.staff_id) url.searchParams.set('staff', link.staff_id);
  const utm = (link.utm ?? {}) as Record<string, string>;
  for (const k of ['source', 'medium', 'campaign']) if (utm[k]) url.searchParams.set(`utm_${k}`, utm[k]);
  return url.toString();
}

/** Public: count the click (no PII; only a keyed user-agent hash) and return the redirect URL */
export async function followReferral(code: string, meta: RequestMeta & { referer?: string }): Promise<string> {
  const normalized = code.trim().toUpperCase();
  const found = await withSystem((trx) =>
    trx
      .selectFrom('referral_links')
      .innerJoin('organizations', 'organizations.id', 'referral_links.organization_id')
      .select(['referral_links.organization_id', 'referral_links.is_active', 'organizations.status as org_status'])
      .where('referral_links.code', '=', normalized)
      .where('referral_links.deleted_at', 'is', null)
      .executeTakeFirst(),
  );
  if (!found || !found.is_active || !['active', 'trial'].includes(found.org_status)) throw Errors.notFound('リンク');
  const orgId = found.organization_id;
  return withTenant(
    orgId,
    async (trx) => {
      const ctx: Ctx = { actor: systemActor(orgId, 'public'), trx, meta };
      const link = await resolveReferralCode(ctx, normalized, { activeOnly: true });
      if (!link) throw Errors.notFound('リンク');
      const slug = await shopSlugForLink(ctx, link);
      if (!slug) throw Errors.notFound('リンク');
      const ua = meta.userAgent ?? '';
      const bot = BOT_UA.test(ua);
      let refererHost: string | null;
      try {
        refererHost = meta.referer ? new URL(meta.referer).host : null;
      } catch {
        refererHost = null;
      }
      if (!bot) await trx.updateTable('referral_links').set({ click_count: sql`click_count + 1` }).where('id', '=', link.id).execute();
      await trx
        .insertInto('referral_events')
        .values({
          organization_id: orgId,
          referral_link_id: link.id,
          event_type: 'click',
          metadata: JSON.stringify({ uaHash: ua ? hmacSha256(config.TOKEN_SECRET, `ua:${ua}`).slice(0, 32) : null, refererHost, ...(bot ? { bot: true } : {}) }),
        })
        .execute();
      return targetUrl(link, slug);
    },
    { traceId: meta.traceId },
  );
}

// ---------------------------------------------------------------- attribution (event subscribers)

/** appointment.created: attribute bookings made through a referral code (source_detail.referralCode / ref / utm.ref) */
export async function attributeAppointment(ctx: Ctx, appointmentId: string) {
  const a = await ctx.trx.selectFrom('appointments').select(['id', 'customer_id', 'source', 'source_detail']).where('id', '=', appointmentId).executeTakeFirst();
  if (!a) return;
  const sd = (a.source_detail ?? {}) as { referralCode?: unknown; ref?: unknown; utm?: Record<string, unknown> };
  const raw = [sd.referralCode, sd.ref, sd.utm?.ref, sd.utm?.referralCode].find((v) => typeof v === 'string' && v.trim());
  if (typeof raw !== 'string') return;
  const link = await resolveReferralCode(ctx, raw);
  if (!link) return;
  if (link.customer_id && link.customer_id === a.customer_id) return; // self referral
  await ctx.trx
    .insertInto('referral_events')
    .values({
      organization_id: ctx.actor.organizationId,
      referral_link_id: link.id,
      event_type: 'booking',
      appointment_id: a.id,
      customer_id: a.customer_id,
      metadata: JSON.stringify({ source: a.source, ...(sd.utm ? { utm: sd.utm } : {}) }),
    })
    .onConflict((oc) => oc.doNothing())
    .execute();
  // friend referral: first booking of a new customer counts as a signup
  if (link.customer_id && a.customer_id) {
    const prior = await ctx.trx
      .selectFrom('appointments')
      .select('id')
      .where('customer_id', '=', a.customer_id)
      .where('id', '!=', a.id)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (!prior) {
      await ctx.trx
        .insertInto('referral_events')
        .values({ organization_id: ctx.actor.organizationId, referral_link_id: link.id, event_type: 'signup', appointment_id: a.id, customer_id: a.customer_id, metadata: JSON.stringify({ referrerCustomerId: link.customer_id }) })
        .onConflict((oc) => oc.doNothing())
        .execute();
    }
  }
}

/** order.paid: attribute EC purchases */
export async function attributeOrder(ctx: Ctx, payload: { orderId: string; customerId?: string | null; total?: number; referralLinkId?: string | null }) {
  if (!payload.referralLinkId) return;
  await ctx.trx
    .insertInto('referral_events')
    .values({
      organization_id: ctx.actor.organizationId,
      referral_link_id: payload.referralLinkId,
      event_type: 'purchase',
      order_id: payload.orderId,
      customer_id: payload.customerId ?? null,
      amount: payload.total ?? null,
    })
    .onConflict((oc) => oc.doNothing())
    .execute();
}
