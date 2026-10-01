import { sql } from 'kysely';
import {
  accessibleShopIds,
  assertShopAccess,
  auditUserId,
  can,
  requireAnyPermission,
  requirePermission,
  systemActor,
  type Ctx,
  type RequestMeta,
} from '../../auth/actor.js';
import { config } from '../../config.js';
import { withTenant } from '../../db/tenant.js';
import { enqueue } from '../../jobs/queue.js';
import { assertTokenResource, issueAccessToken, resolveAccessToken } from '../../lib/access-tokens.js';
import { audit, diff } from '../../lib/audit.js';
import { Errors } from '../../lib/errors.js';
import { emit } from '../../lib/events.js';
import { decodeCursor, paginate } from '../../lib/pagination.js';
import { parseShopSettings } from '../../lib/shop-settings.js';
import { storage } from '../../lib/storage.js';
import { localDate } from '../../lib/time.js';
import { assertCustomerAccess } from '../customers/access.js';
import { queueMessage } from '../messaging/api.js';
import type { CreateReviewRequestInput, ListReviewRequestsInput, ListReviewsInput, SubmitReviewInput } from './schemas.js';

export const REVIEW_REQUEST_TTL_SEC = 14 * 86400;
const NO_SHOP = '00000000-0000-0000-0000-000000000000';

/** Organization-level review settings (organizations.settings.reviews) */
export interface ReviewOrgSettings {
  /** auto-publish internal reviews with rating >= N; null = always moderate (default) */
  autoPublishMinRating: number | null;
  /** offer the shop's Google review URL after submitting when rating >= N (never a condition/incentive) */
  googleSuggestMinRating: number;
  /** skip automatic requests when the customer already got one within N days */
  autoRequestCooldownDays: number;
}

export function reviewOrgSettings(raw: unknown): ReviewOrgSettings {
  const r = ((raw ?? {}) as { reviews?: Record<string, unknown> }).reviews ?? {};
  const int = (v: unknown, min: number, max: number) => (typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : null);
  return {
    autoPublishMinRating: int(r.autoPublishMinRating, 1, 5),
    googleSuggestMinRating: int(r.googleSuggestMinRating, 1, 5) ?? 4,
    autoRequestCooldownDays: int(r.autoRequestCooldownDays, 0, 365) ?? 30,
  };
}

async function orgSettings(ctx: Ctx) {
  const org = await ctx.trx.selectFrom('organizations').select('settings').where('id', '=', ctx.actor.organizationId).executeTakeFirstOrThrow();
  return reviewOrgSettings(org.settings);
}

function reviewUrl(token: string) {
  return `${config.WEB_BASE_URL.replace(/\/$/, '')}/review/${token}`;
}

function shopFilterIds(ctx: Ctx): string[] | null {
  const ids = accessibleShopIds(ctx.actor);
  return ids ? (ids.length ? [...ids] : [NO_SHOP]) : null;
}

// ================================================================ review requests

interface IssueInput {
  shopId: string;
  customerId: string;
  appointmentId?: string | null;
  transactionId?: string | null;
  staffId?: string | null;
  send: boolean;
}

/** Create request row + single-use 14-day token (+ queue the message). Returns null on duplicate. */
async function issueReviewRequest(ctx: Ctx, input: IssueInput) {
  const row = await ctx.trx
    .insertInto('review_requests')
    .values({
      organization_id: ctx.actor.organizationId,
      shop_id: input.shopId,
      customer_id: input.customerId,
      appointment_id: input.appointmentId ?? null,
      transaction_id: input.transactionId ?? null,
      staff_id: input.staffId ?? null,
      status: 'created',
      created_by: auditUserId(ctx.actor),
    })
    .onConflict((oc) => oc.doNothing())
    .returning(['id'])
    .executeTakeFirst();
  if (!row) return null;
  const token = await issueAccessToken(ctx, {
    purpose: 'review_request',
    resourceType: 'review_request',
    resourceId: row.id,
    customerId: input.customerId,
    ttlSec: REVIEW_REQUEST_TTL_SEC,
    maxUses: 1,
  });
  const url = reviewUrl(token.token);
  let messageId: string | null = null;
  if (input.send) {
    const staff = input.staffId ? await ctx.trx.selectFrom('staffs').select('display_name').where('id', '=', input.staffId).executeTakeFirst() : null;
    // Review requests solicit a voluntary action → 'marketing' so marketing opt-outs are honoured.
    const res = await queueMessage(ctx, {
      customerId: input.customerId,
      shopId: input.shopId,
      category: 'marketing',
      templateKey: 'review_request',
      vars: { review: { url, expiresAt: token.expiresAt.toISOString() }, staff: { name: staff?.display_name ?? '' } },
      appointmentId: input.appointmentId ?? null,
      dedupeKey: `review-request:${row.id}`,
      sentByStaffId: ctx.actor.kind === 'staff' ? ctx.actor.staffId : null,
    });
    messageId = res.messageId;
  }
  await ctx.trx.updateTable('review_requests').set({ access_token_id: token.id, message_id: messageId }).where('id', '=', row.id).execute();
  return { id: row.id, url, expiresAt: token.expiresAt, messageId };
}

async function staffForTransaction(ctx: Ctx, transactionId: string): Promise<string | null> {
  const row = await ctx.trx
    .selectFrom('transaction_item_staff as s')
    .innerJoin('transaction_items as i', 'i.id', 's.transaction_item_id')
    .select('s.staff_id')
    .where('i.transaction_id', '=', transactionId)
    .orderBy(sql`case s.role when 'main' then 0 when 'assistant' then 1 else 2 end`)
    .orderBy('i.sort_order')
    .executeTakeFirst();
  return row?.staff_id ?? null;
}

/** Manual request (POST /review-requests) */
export async function createReviewRequest(ctx: Ctx, input: CreateReviewRequestInput) {
  requireAnyPermission(ctx.actor, 'review.manage', 'message.send');
  await assertCustomerAccess(ctx, input.customerId);
  let shopId = input.shopId ?? null;
  let staffId = input.staffId ?? null;
  let transactionId: string | null = null;
  if (input.appointmentId) {
    const a = await ctx.trx.selectFrom('appointments').select(['id', 'shop_id', 'staff_id', 'customer_id', 'status']).where('id', '=', input.appointmentId).where('deleted_at', 'is', null).executeTakeFirst();
    if (!a || a.customer_id !== input.customerId) throw Errors.notFound('予約', input.appointmentId);
    if (['cancelled', 'no_show'].includes(a.status)) throw Errors.business('APPOINTMENT_NOT_VISITED', 'キャンセル・無断キャンセルの予約には口コミ依頼を送れません');
    shopId ??= a.shop_id;
    staffId ??= a.staff_id;
    const tx = await ctx.trx.selectFrom('transactions').select('id').where('appointment_id', '=', a.id).where('status', 'in', ['completed', 'partially_refunded']).executeTakeFirst();
    transactionId = tx?.id ?? null;
  }
  shopId ??= ctx.meta.currentShopId ?? (ctx.actor.kind === 'staff' ? (ctx.actor.shopIds[0] ?? null) : null);
  if (!shopId) throw Errors.validation('店舗を指定してください');
  assertShopAccess(ctx.actor, shopId);
  const shop = await ctx.trx.selectFrom('shops').select('id').where('id', '=', shopId).where('deleted_at', 'is', null).executeTakeFirst();
  if (!shop) throw Errors.notFound('店舗', shopId);
  const issued = await issueReviewRequest(ctx, { shopId, customerId: input.customerId, appointmentId: input.appointmentId, transactionId, staffId, send: input.send });
  if (!issued) throw Errors.conflict('REVIEW_REQUEST_EXISTS', 'この来店には既に口コミ依頼が発行されています');
  await audit(ctx, { action: 'review_request.create', resourceType: 'review_request', resourceId: issued.id, shopId, after: { customerId: input.customerId, appointmentId: input.appointmentId ?? null, send: input.send } });
  return { ...(await getReviewRequestRow(ctx, issued.id)), url: issued.url };
}

const requestColumns = [
  'review_requests.id',
  'review_requests.shop_id',
  'review_requests.customer_id',
  'review_requests.appointment_id',
  'review_requests.transaction_id',
  'review_requests.staff_id',
  'review_requests.message_id',
  'review_requests.status',
  'review_requests.opened_at',
  'review_requests.submitted_at',
  'review_requests.created_at',
  'access_tokens.expires_at',
] as const;

function withEffectiveStatus<T extends { status: string; expires_at: Date | null }>(r: T) {
  const expired = ['created', 'sent', 'opened'].includes(r.status) && r.expires_at !== null && r.expires_at < new Date();
  return { ...r, status: expired ? 'expired' : r.status };
}

async function getReviewRequestRow(ctx: Ctx, id: string) {
  const r = await ctx.trx
    .selectFrom('review_requests')
    .leftJoin('access_tokens', 'access_tokens.id', 'review_requests.access_token_id')
    .select(requestColumns)
    .where('review_requests.id', '=', id)
    .executeTakeFirstOrThrow();
  return withEffectiveStatus(r);
}

export async function listReviewRequests(ctx: Ctx, input: ListReviewRequestsInput) {
  requireAnyPermission(ctx.actor, 'review.manage', 'message.send');
  if (input.shopId) assertShopAccess(ctx.actor, input.shopId);
  if (input.customerId) await assertCustomerAccess(ctx, input.customerId);
  let q = ctx.trx
    .selectFrom('review_requests')
    .leftJoin('access_tokens', 'access_tokens.id', 'review_requests.access_token_id')
    .leftJoin('customers', 'customers.id', 'review_requests.customer_id')
    .leftJoin('staffs', 'staffs.id', 'review_requests.staff_id')
    .select(requestColumns)
    .select(['customers.last_name as customer_last_name', 'customers.first_name as customer_first_name', 'staffs.display_name as staff_name']);
  const shops = shopFilterIds(ctx);
  if (shops) q = q.where('review_requests.shop_id', 'in', shops);
  if (input.shopId) q = q.where('review_requests.shop_id', '=', input.shopId);
  if (input.customerId) q = q.where('review_requests.customer_id', '=', input.customerId);
  if (input.status === 'expired') {
    q = q.where('review_requests.status', 'in', ['created', 'sent', 'opened']).where('access_tokens.expires_at', '<', new Date());
  } else if (input.status) {
    q = q.where('review_requests.status', '=', input.status);
    if (input.status !== 'submitted') q = q.where('access_tokens.expires_at', '>=', new Date());
  }
  const cursor = decodeCursor(input.cursor);
  if (cursor) q = q.where(sql`(review_requests.created_at, review_requests.id)`, '<', sql`(${cursor.v}::timestamptz, ${cursor.id}::uuid)`);
  const rows = await q.orderBy('review_requests.created_at', 'desc').orderBy('review_requests.id', 'desc').limit(input.limit + 1).execute();
  const page = paginate(rows, input.limit, (r) => r.created_at);
  return {
    items: page.items.map(({ customer_last_name, customer_first_name, ...r }) => ({
      ...withEffectiveStatus(r),
      customer_name: `${customer_last_name ?? ''} ${customer_first_name ?? ''}`.trim(),
    })),
    nextCursor: page.nextCursor,
  };
}

// ---------------------------------------------------------------- automatic requests

export interface AutoRequestPayload {
  shopId: string;
  customerId: string;
  appointmentId?: string | null;
  transactionId?: string | null;
}

/** Event subscriber body: enqueue the delayed request job (one per appointment/transaction) */
export async function scheduleAutoReviewRequest(ctx: Ctx, p: AutoRequestPayload) {
  if (!p.customerId || !p.shopId) return;
  const shop = await ctx.trx.selectFrom('shops').select('settings').where('id', '=', p.shopId).executeTakeFirst();
  if (!shop) return;
  const settings = parseShopSettings(shop.settings).review;
  if (!settings.autoRequest) return;
  const key = p.appointmentId ? `review-request:appt:${p.appointmentId}` : `review-request:tx:${p.transactionId}`;
  await enqueue(ctx, {
    type: 'reviews.auto_request',
    payload: { ...p },
    runAt: new Date(Date.now() + settings.requestDelayHours * 3600_000),
    dedupeKey: key,
  });
}

/** Job body: re-check everything at send time and issue at most one request per visit */
export async function runAutoReviewRequest(ctx: Ctx, p: AutoRequestPayload): Promise<{ skipped?: string; requestId?: string }> {
  const shop = await ctx.trx.selectFrom('shops').select(['id', 'settings', 'deleted_at']).where('id', '=', p.shopId).executeTakeFirst();
  if (!shop || shop.deleted_at) return { skipped: 'shop' };
  if (!parseShopSettings(shop.settings).review.autoRequest) return { skipped: 'disabled' };

  let appointmentId = p.appointmentId ?? null;
  let transactionId = p.transactionId ?? null;
  let staffId: string | null = null;
  if (transactionId) {
    const tx = await ctx.trx.selectFrom('transactions').select(['id', 'appointment_id', 'status']).where('id', '=', transactionId).executeTakeFirst();
    if (!tx || !['completed', 'partially_refunded'].includes(tx.status)) return { skipped: 'transaction' };
    appointmentId ??= tx.appointment_id;
  }
  if (appointmentId) {
    const a = await ctx.trx.selectFrom('appointments').select(['id', 'status', 'staff_id']).where('id', '=', appointmentId).where('deleted_at', 'is', null).executeTakeFirst();
    if (!a) return { skipped: 'appointment' };
    staffId = a.staff_id;
    if (!transactionId) {
      const tx = await ctx.trx.selectFrom('transactions').select('id').where('appointment_id', '=', a.id).where('status', 'in', ['completed', 'partially_refunded']).executeTakeFirst();
      transactionId = tx?.id ?? null;
      if (a.status !== 'completed' && !transactionId) return { skipped: 'not_completed' };
    }
  }
  if (!staffId && transactionId) staffId = await staffForTransaction(ctx, transactionId);

  // one request per visit: appointment or transaction already has one
  const existing = await ctx.trx
    .selectFrom('review_requests')
    .select(['id', 'transaction_id'])
    .where((eb) => eb.or([...(appointmentId ? [eb('appointment_id', '=', appointmentId)] : []), ...(transactionId ? [eb('transaction_id', '=', transactionId)] : [])]))
    .executeTakeFirst();
  if (existing) {
    if (!existing.transaction_id && transactionId) {
      await ctx.trx.updateTable('review_requests').set({ transaction_id: transactionId }).where('id', '=', existing.id).execute();
    }
    return { skipped: 'duplicate' };
  }

  const customer = await ctx.trx.selectFrom('customers').select(['id', 'status', 'deleted_at']).where('id', '=', p.customerId).executeTakeFirst();
  if (!customer || customer.deleted_at || customer.status !== 'active') return { skipped: 'customer' };
  const settings = await orgSettings(ctx);
  if (settings.autoRequestCooldownDays > 0) {
    const recent = await ctx.trx
      .selectFrom('review_requests')
      .select('id')
      .where('customer_id', '=', p.customerId)
      .where('created_at', '>', new Date(Date.now() - settings.autoRequestCooldownDays * 86400_000))
      .executeTakeFirst();
    if (recent) return { skipped: 'cooldown' };
  }
  const issued = await issueReviewRequest(ctx, { shopId: p.shopId, customerId: p.customerId, appointmentId, transactionId, staffId, send: true });
  if (!issued) return { skipped: 'duplicate' };
  return { requestId: issued.id };
}

/** message.sent subscriber: created → sent */
export async function markRequestSent(ctx: Ctx, messageId: string) {
  await ctx.trx.updateTable('review_requests').set({ status: 'sent' }).where('message_id', '=', messageId).where('status', '=', 'created').execute();
}

// ================================================================ public (token) flow

async function photoUrl(ctx: Ctx, fileId: unknown): Promise<string | null> {
  if (typeof fileId !== 'string' || !/^[0-9a-f-]{36}$/i.test(fileId)) return null;
  const f = await ctx.trx.selectFrom('files').select('object_key').where('id', '=', fileId).where('status', '=', 'uploaded').executeTakeFirst();
  return f ? storage.presignDownload(f.object_key, 3600) : null;
}

const PUBLIC_PROFILE_KEYS = ['bio', 'message', 'specialties', 'styles', 'yearsOfExperience', 'qualifications', 'instagram', 'tiktok', 'youtube', 'x'] as const;

/** Only whitelisted public_profile keys are exposed (staff JSON may contain internal notes) */
async function sanitizeProfile(ctx: Ctx, raw: unknown) {
  const p = (raw ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of PUBLIC_PROFILE_KEYS) if (p[k] !== undefined && p[k] !== null) out[k] = p[k];
  out.photoUrl = await photoUrl(ctx, p.photo_file_id ?? p.photoFileId);
  return out;
}

async function visitMenus(ctx: Ctx, appointmentId: string | null, transactionId: string | null): Promise<{ date: Date | null; menus: string[] }> {
  if (appointmentId) {
    const a = await ctx.trx.selectFrom('appointments').select('start_at').where('id', '=', appointmentId).executeTakeFirst();
    const menus = await ctx.trx.selectFrom('appointment_services').select('name').where('appointment_id', '=', appointmentId).orderBy('sort_order').execute();
    return { date: a?.start_at ?? null, menus: menus.map((m) => m.name) };
  }
  if (transactionId) {
    const t = await ctx.trx.selectFrom('transactions').select('completed_at').where('id', '=', transactionId).executeTakeFirst();
    const items = await ctx.trx.selectFrom('transaction_items').select('name').where('transaction_id', '=', transactionId).where('item_type', '=', 'service').orderBy('sort_order').execute();
    return { date: t?.completed_at ?? null, menus: items.map((i) => i.name) };
  }
  return { date: null, menus: [] };
}

function publicCtx(orgId: string, trx: Ctx['trx'], meta: RequestMeta): Ctx {
  return { actor: systemActor(orgId, 'public'), trx, meta };
}

const invalidLink = () => Errors.unauthenticated('リンクが無効か有効期限が切れています', 'INVALID_LINK');

export async function publicReviewRequest(token: string, meta: RequestMeta) {
  const t = await resolveAccessToken(token, 'review_request');
  assertTokenResource(t, 'review_request');
  return withTenant(
    t.organizationId,
    async (trx) => {
      const ctx = publicCtx(t.organizationId, trx, meta);
      const r = await trx
        .selectFrom('review_requests')
        .innerJoin('shops', 'shops.id', 'review_requests.shop_id')
        .leftJoin('staffs', 'staffs.id', 'review_requests.staff_id')
        .select([
          'review_requests.id',
          'review_requests.status',
          'review_requests.appointment_id',
          'review_requests.transaction_id',
          'shops.name as shop_name',
          'shops.slug as shop_slug',
          'shops.timezone',
          'staffs.id as staff_id',
          'staffs.display_name as staff_name',
          'staffs.title as staff_title',
          'staffs.public_profile',
        ])
        .where('review_requests.id', '=', t.resourceId)
        .executeTakeFirst();
      if (!r || r.status === 'submitted') throw invalidLink();
      if (r.status === 'created' || r.status === 'sent') {
        await trx.updateTable('review_requests').set({ status: 'opened', opened_at: new Date() }).where('id', '=', r.id).execute();
      }
      const visit = await visitMenus(ctx, r.appointment_id, r.transaction_id);
      const profile = r.staff_id ? await sanitizeProfile(ctx, r.public_profile) : null;
      return {
        shop: { name: r.shop_name, slug: r.shop_slug },
        staff: r.staff_id ? { id: r.staff_id, displayName: r.staff_name, title: r.staff_title, photoUrl: profile?.photoUrl ?? null } : null,
        visit: { date: visit.date ? localDate(visit.date, r.timezone) : null, menus: visit.menus },
      };
    },
    { traceId: meta.traceId },
  );
}

export async function submitPublicReview(token: string, input: SubmitReviewInput, meta: RequestMeta) {
  const t = await resolveAccessToken(token, 'review_request');
  assertTokenResource(t, 'review_request');
  return withTenant(
    t.organizationId,
    async (trx) => {
      const ctx = publicCtx(t.organizationId, trx, meta);
      const r = await trx.selectFrom('review_requests').selectAll().where('id', '=', t.resourceId).forUpdate().executeTakeFirst();
      if (!r || r.status === 'submitted') throw invalidLink();
      // consume the single-use token atomically with the review insert
      const now = new Date();
      const consumed = await trx
        .updateTable('access_tokens')
        .set({ use_count: sql`use_count + 1`, last_used_at: now })
        .where('id', '=', t.id)
        .where('revoked_at', 'is', null)
        .where('expires_at', '>', now)
        .where((eb) => eb.or([eb('max_uses', 'is', null), eb('use_count', '<', eb.ref('max_uses'))]))
        .executeTakeFirst();
      if (Number(consumed.numUpdatedRows) !== 1) throw invalidLink();

      const settings = await orgSettings(ctx);
      const status = settings.autoPublishMinRating !== null && input.rating >= settings.autoPublishMinRating ? 'published' : 'pending';
      const review = await trx
        .insertInto('reviews')
        .values({
          organization_id: t.organizationId,
          shop_id: r.shop_id,
          customer_id: r.customer_id,
          staff_id: r.staff_id,
          appointment_id: r.appointment_id,
          review_request_id: r.id,
          source: 'internal',
          rating: input.rating,
          title: input.title || null,
          body: input.body || null,
          reviewer_name: input.reviewerName || null,
          staff_rating: r.staff_id ? (input.staffRating ?? null) : null,
          status,
          posted_at: now,
        })
        .returning(['id', 'status', 'rating'])
        .executeTakeFirstOrThrow();
      await trx.updateTable('review_requests').set({ status: 'submitted', submitted_at: now }).where('id', '=', r.id).execute();
      await emit(ctx, { type: 'review.submitted', aggregateType: 'review', aggregateId: review.id, payload: { reviewId: review.id, shopId: r.shop_id, staffId: r.staff_id, rating: input.rating } });

      const shop = await trx.selectFrom('shops').select('settings').where('id', '=', r.shop_id).executeTakeFirstOrThrow();
      const googleUrl = parseShopSettings(shop.settings).review.googleReviewUrl;
      return {
        reviewId: review.id,
        status: review.status,
        message: 'ご協力ありがとうございました。',
        // An optional invitation only — the review above is stored regardless and nothing is offered in return.
        googleReviewUrl: googleUrl && input.rating >= settings.googleSuggestMinRating ? googleUrl : null,
      };
    },
    { traceId: meta.traceId },
  );
}

// ================================================================ staff management

const reviewColumns = [
  'reviews.id',
  'reviews.shop_id',
  'reviews.customer_id',
  'reviews.staff_id',
  'reviews.appointment_id',
  'reviews.review_request_id',
  'reviews.source',
  'reviews.external_review_id',
  'reviews.rating',
  'reviews.staff_rating',
  'reviews.title',
  'reviews.body',
  'reviews.reviewer_name',
  'reviews.status',
  'reviews.reply_body',
  'reviews.replied_at',
  'reviews.replied_by',
  'reviews.reply_synced_at',
  'reviews.reply_sync_error',
  'reviews.posted_at',
  'reviews.created_at',
  'reviews.updated_at',
] as const;

/** read access: review managers, org analysts, or stylists for their own reviews */
function readScope(ctx: Ctx): { ownStaffId: string | null } {
  requireAnyPermission(ctx.actor, 'review.manage', 'analytics.read', 'analytics.read_own');
  if (ctx.actor.kind === 'staff' && !can(ctx.actor, 'review.manage') && !can(ctx.actor, 'analytics.read')) return { ownStaffId: ctx.actor.staffId };
  return { ownStaffId: null };
}

export async function listReviews(ctx: Ctx, input: ListReviewsInput) {
  const { ownStaffId } = readScope(ctx);
  if (input.shopId) assertShopAccess(ctx.actor, input.shopId);
  let q = ctx.trx
    .selectFrom('reviews')
    .leftJoin('staffs', 'staffs.id', 'reviews.staff_id')
    .leftJoin('customers', 'customers.id', 'reviews.customer_id')
    .select(reviewColumns)
    .select(['staffs.display_name as staff_name', 'customers.last_name as customer_last_name', 'customers.first_name as customer_first_name']);
  const shops = shopFilterIds(ctx);
  if (shops) q = q.where('reviews.shop_id', 'in', shops);
  if (ownStaffId) q = q.where('reviews.staff_id', '=', ownStaffId);
  if (input.shopId) q = q.where('reviews.shop_id', '=', input.shopId);
  if (input.staffId) q = q.where('reviews.staff_id', '=', input.staffId);
  if (input.rating) q = q.where('reviews.rating', '=', input.rating);
  if (input.status) q = q.where('reviews.status', '=', input.status);
  if (input.source) q = q.where('reviews.source', '=', input.source);
  if (input.replied) q = q.where('reviews.reply_body', input.replied === 'true' ? 'is not' : 'is', null);
  const cursor = decodeCursor(input.cursor);
  if (cursor) q = q.where(sql`(reviews.posted_at, reviews.id)`, '<', sql`(${cursor.v}::timestamptz, ${cursor.id}::uuid)`);
  const rows = await q.orderBy('reviews.posted_at', 'desc').orderBy('reviews.id', 'desc').limit(input.limit + 1).execute();
  const page = paginate(rows, input.limit, (r) => r.posted_at);
  const showCustomer = can(ctx.actor, 'customer.read');
  return {
    items: page.items.map(({ customer_last_name, customer_first_name, ...r }) => ({
      ...r,
      customer_name: showCustomer && r.customer_id ? `${customer_last_name ?? ''} ${customer_first_name ?? ''}`.trim() : null,
    })),
    nextCursor: page.nextCursor,
  };
}

async function loadReviewForManage(ctx: Ctx, id: string) {
  requirePermission(ctx.actor, 'review.manage');
  const r = await ctx.trx.selectFrom('reviews').select(reviewColumns).where('reviews.id', '=', id).forUpdate().executeTakeFirst();
  if (!r) throw Errors.notFound('口コミ', id);
  assertShopAccess(ctx.actor, r.shop_id);
  return r;
}

export async function moderateReview(ctx: Ctx, id: string, status: 'published' | 'hidden' | 'pending') {
  const before = await loadReviewForManage(ctx, id);
  if (before.source === 'google' && status !== 'published' && status !== 'hidden') throw Errors.validation('Google口コミは公開/非表示のみ設定できます');
  await ctx.trx.updateTable('reviews').set({ status }).where('id', '=', id).execute();
  await audit(ctx, { action: 'review.moderate', resourceType: 'review', resourceId: id, shopId: before.shop_id, ...diff({ status: before.status }, { status }) });
  return { ...before, status };
}

export async function replyToReview(ctx: Ctx, id: string, body: string) {
  const before = await loadReviewForManage(ctx, id);
  const now = new Date();
  await ctx.trx
    .updateTable('reviews')
    .set({ reply_body: body, replied_at: now, replied_by: auditUserId(ctx.actor), reply_synced_at: null, reply_sync_error: null })
    .where('id', '=', id)
    .execute();
  if (before.source === 'google') {
    await enqueue(ctx, { type: 'reviews.google_reply', payload: { reviewId: id }, dedupeKey: `gbp-reply:${id}`, maxAttempts: 6 });
  }
  await audit(ctx, { action: 'review.reply', resourceType: 'review', resourceId: id, shopId: before.shop_id, ...diff({ reply_body: before.reply_body }, { reply_body: body }) });
  return ctx.trx.selectFrom('reviews').select(reviewColumns).where('reviews.id', '=', id).executeTakeFirstOrThrow();
}

async function ratingSummary(ctx: Ctx, filter: { shopId?: string; staffId?: string; shopIds?: string[] | null; publishedOnly?: boolean }) {
  let q = ctx.trx
    .selectFrom('reviews')
    .select(['rating', (eb) => eb.fn.countAll<number>().as('n')])
    .where('status', '=', 'published')
    .groupBy('rating');
  if (filter.shopId) q = q.where('shop_id', '=', filter.shopId);
  if (filter.staffId) q = q.where('staff_id', '=', filter.staffId);
  if (filter.shopIds) q = q.where('shop_id', 'in', filter.shopIds);
  const rows = await q.execute();
  const distribution: Record<'1' | '2' | '3' | '4' | '5', number> = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 };
  let count = 0;
  let sum = 0;
  for (const r of rows) {
    const n = Number(r.n);
    distribution[String(r.rating) as '1'] = n;
    count += n;
    sum += r.rating * n;
  }
  return { count, average: count ? Math.round((sum / count) * 100) / 100 : null, distribution };
}

export async function reviewSummary(ctx: Ctx, input: { shopId?: string; staffId?: string }) {
  const { ownStaffId } = readScope(ctx);
  if (input.shopId) assertShopAccess(ctx.actor, input.shopId);
  if (ownStaffId && input.staffId && input.staffId !== ownStaffId) throw Errors.forbidden('他のスタッフの口コミ集計は閲覧できません');
  const staffId = ownStaffId ?? input.staffId;
  const shops = shopFilterIds(ctx);
  const summary = await ratingSummary(ctx, { shopId: input.shopId, staffId, shopIds: shops });
  let pq = ctx.trx
    .selectFrom('reviews')
    .select([
      (eb) => eb.fn.count<number>('id').filterWhere('status', '=', 'pending').as('pending'),
      (eb) => eb.fn.count<number>('id').filterWhere('status', '=', 'hidden').as('hidden'),
      (eb) => eb.fn.count<number>('id').filterWhere((w) => w.and([w('status', '=', 'published'), w('reply_body', 'is', null)])).as('unreplied'),
      (eb) => eb.fn.avg<number>('staff_rating').filterWhere('status', '=', 'published').as('staff_rating_avg'),
    ]);
  if (input.shopId) pq = pq.where('shop_id', '=', input.shopId);
  if (staffId) pq = pq.where('staff_id', '=', staffId);
  if (shops) pq = pq.where('shop_id', 'in', shops);
  const extra = await pq.executeTakeFirstOrThrow();
  return {
    ...summary,
    pendingCount: Number(extra.pending),
    hiddenCount: Number(extra.hidden),
    unrepliedCount: Number(extra.unreplied),
    staffRatingAverage: extra.staff_rating_avg === null ? null : Math.round(Number(extra.staff_rating_avg) * 100) / 100,
  };
}

// ================================================================ public listing / profiles

export async function publicShopReviews(ctx: Ctx, shopId: string, input: { staffId?: string; cursor?: string; limit: number }) {
  let q = ctx.trx
    .selectFrom('reviews')
    .leftJoin('staffs', 'staffs.id', 'reviews.staff_id')
    .select([
      'reviews.id',
      'reviews.rating',
      'reviews.title',
      'reviews.body',
      'reviews.reviewer_name',
      'reviews.source',
      'reviews.staff_id',
      'staffs.display_name as staff_name',
      'reviews.posted_at',
      'reviews.reply_body',
      'reviews.replied_at',
    ])
    .where('reviews.shop_id', '=', shopId)
    .where('reviews.status', '=', 'published');
  if (input.staffId) q = q.where('reviews.staff_id', '=', input.staffId);
  const cursor = decodeCursor(input.cursor);
  if (cursor) q = q.where(sql`(reviews.posted_at, reviews.id)`, '<', sql`(${cursor.v}::timestamptz, ${cursor.id}::uuid)`);
  const rows = await q.orderBy('reviews.posted_at', 'desc').orderBy('reviews.id', 'desc').limit(input.limit + 1).execute();
  const page = paginate(rows, input.limit, (r) => r.posted_at);
  return {
    summary: cursor ? undefined : await ratingSummary(ctx, { shopId, staffId: input.staffId }),
    items: page.items.map(({ reviewer_name, ...r }) => ({ ...r, nickname: reviewer_name?.trim() || '匿名' })),
    nextCursor: page.nextCursor,
  };
}

export async function publicStaffProfile(ctx: Ctx, shopId: string, staffId: string) {
  const staff = await ctx.trx
    .selectFrom('staffs')
    .innerJoin('staff_shop_assignments as a', 'a.staff_id', 'staffs.id')
    .select(['staffs.id', 'staffs.display_name', 'staffs.title', 'staffs.public_profile', 'staffs.public_slug', 'staffs.nomination_fee', 'staffs.is_bookable'])
    .where('staffs.id', '=', staffId)
    .where('a.shop_id', '=', shopId)
    .where('a.ended_on', 'is', null)
    .where('staffs.status', '=', 'active')
    .where('staffs.deleted_at', 'is', null)
    .executeTakeFirst();
  if (!staff) throw Errors.notFound('スタッフ', staffId);
  const [profile, rating, recent] = await Promise.all([
    sanitizeProfile(ctx, staff.public_profile),
    ratingSummary(ctx, { staffId }),
    publicShopReviews(ctx, shopId, { staffId, limit: 10 }),
  ]);
  return {
    id: staff.id,
    displayName: staff.display_name,
    title: staff.title,
    publicSlug: staff.public_slug,
    nominationFee: staff.nomination_fee,
    bookable: staff.is_bookable,
    profile,
    rating,
    recentReviews: recent.items,
  };
}
