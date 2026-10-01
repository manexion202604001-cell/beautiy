import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { resolveAccessToken } from '../../lib/access-tokens.js';
import { Errors } from '../../lib/errors.js';
import { isoDate, isoDateTime, uuid } from '../../lib/schemas.js';
import { computeAvailability } from '../appointments/availability.js';
import { getAppointmentUnchecked } from '../appointments/service.js';
import { withTenant } from '../../db/tenant.js';
import { systemActor } from '../../auth/actor.js';
import * as svc from './service.js';

const tags = ['public'];
const publicRate = { auth: 'public' as const, rateLimit: { max: 60, timeWindow: '1 minute' } };
const slugParam = z.object({ slug: z.string().min(1).max(60) });

const bookingBody = z.object({
  menuIds: z.array(uuid).min(1).max(10),
  staffId: uuid.nullable().optional(),
  startAt: isoDateTime,
  couponId: uuid.nullable().optional(),
  customerNote: z.string().max(1000).nullable().optional(),
  channel: z.enum(['web', 'line']).optional(),
  clientRequestId: z.string().max(100).optional(),
  utm: z.record(z.string(), z.string().max(200)).optional(),
  referralCode: z.string().max(50).optional(),
  customer: z
    .object({
      lastName: z.string().min(1).max(50),
      firstName: z.string().min(1).max(50),
      lastNameKana: z.string().max(50).optional(),
      firstNameKana: z.string().max(50).optional(),
      phone: z.string().min(10).max(20),
      email: z.string().email().nullable().optional(),
    })
    .optional(),
});

const plugin: FastifyPluginAsyncZod = async (app) => {
  app.get('/public/shops/:slug', { config: publicRate, schema: { tags, summary: '店舗公開情報(メニュー/スタッフ/営業時間/クーポン)', params: slugParam } }, async (req) => {
    const shop = await svc.resolveShopSlug(req.params.slug);
    return svc.publicTx(shop, req.meta, (ctx) => svc.publicShopInfo(ctx, shop.shopId));
  });

  app.get(
    '/public/shops/:slug/availability',
    {
      config: publicRate,
      schema: {
        tags,
        summary: '空き枠(オンライン予約制約適用)',
        params: slugParam,
        querystring: z.object({
          menuIds: z.union([uuid, z.array(uuid)]).transform((v) => (Array.isArray(v) ? v : [v])),
          staffId: uuid.optional(),
          from: isoDate,
          to: isoDate,
          /** reschedule own booking (customer token required) */
          excludeAppointmentId: uuid.optional(),
        }),
      },
    },
    async (req) => {
      const shop = await svc.resolveShopSlug(req.params.slug);
      return svc.publicTx(shop, req.meta, async (ctx) => {
        const { excludeAppointmentId, ...query } = req.query;
        let exclude: string | undefined;
        if (excludeAppointmentId) {
          const actor = req.actor;
          const own =
            actor?.kind === 'customer' && actor.organizationId === shop.organizationId
              ? await ctx.trx.selectFrom('appointments').select('id').where('id', '=', excludeAppointmentId).where('customer_id', '=', actor.customerId).executeTakeFirst()
              : undefined;
          if (!own) throw Errors.forbidden('この予約の空き枠は確認できません');
          exclude = own.id;
        }
        const res = await computeAvailability(ctx, { shopId: shop.shopId, ...query, excludeAppointmentId: exclude, publicBooking: true });
        // do not reveal which staff are free for フリー queries beyond what is needed
        return { ...res, days: res.days.map((d) => ({ date: d.date, slots: d.slots.map((s) => ({ start: s.start, end: s.end, staffIds: req.query.staffId ? [req.query.staffId] : s.staffIds })) })) };
      });
    },
  );

  // ----- customer authentication
  app.post(
    '/public/shops/:slug/auth/line',
    { config: publicRate, schema: { tags, summary: 'LINE(LIFF)ログイン → 顧客トークン', params: slugParam, body: z.object({ idToken: z.string().min(5) }) } },
    async (req) => svc.loginWithLine(await svc.resolveShopSlug(req.params.slug), req.body.idToken, req.meta),
  );
  app.post(
    '/public/shops/:slug/auth/otp/request',
    { config: { auth: 'public', rateLimit: { max: 10, timeWindow: '1 minute' } }, schema: { tags, summary: 'SMS/メールOTP送信', params: slugParam, body: z.object({ destination: z.string().min(5).max(200) }) } },
    async (req) => svc.requestCustomerOtp(await svc.resolveShopSlug(req.params.slug), req.body.destination, req.meta),
  );
  app.post(
    '/public/auth/otp/verify',
    {
      config: { auth: 'public', rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: {
        tags,
        summary: 'OTP確認 → 顧客トークン',
        body: z.object({
          challengeId: uuid,
          code: z.string().regex(/^\d{6}$/),
          profile: z.object({ lastName: z.string().max(50).optional(), firstName: z.string().max(50).optional(), lastNameKana: z.string().max(50).optional(), firstNameKana: z.string().max(50).optional() }).optional(),
        }),
      },
    },
    (req) => svc.verifyCustomerOtp(req.body.challengeId, req.body.code, req.body.profile, req.meta),
  );

  // ----- booking (guest or authenticated customer)
  app.post(
    '/public/shops/:slug/appointments',
    { config: { auth: 'public', rateLimit: { max: 20, timeWindow: '1 minute' } }, schema: { tags, summary: 'Web/LINE予約作成', params: slugParam, body: bookingBody } },
    async (req, reply) => {
      const shop = await svc.resolveShopSlug(req.params.slug);
      const actor = req.actor?.kind === 'customer' && req.actor.organizationId === shop.organizationId ? req.actor : null;
      const result = actor
        ? await req.tx((ctx) => svc.createPublicBooking(ctx, shop, req.body, actor.customerId, actor.via))
        : await svc.publicTx(shop, req.meta, (ctx) => svc.createPublicBooking(ctx, shop, req.body, null, null));
      return reply.status(result.replayed ? 200 : 201).send(result);
    },
  );

  // ----- customer self-service (customer token)
  const customer = { auth: 'customer' as const };
  app.get('/public/me', { config: customer, schema: { tags, summary: '顧客プロフィール' } }, (req) => req.tx((ctx) => svc.customerProfile(ctx, req.customer().customerId)));
  app.patch(
    '/public/me',
    {
      config: customer,
      schema: {
        tags,
        body: z.object({
          lastName: z.string().max(50).optional(),
          firstName: z.string().max(50).optional(),
          lastNameKana: z.string().max(50).optional(),
          firstNameKana: z.string().max(50).optional(),
          phone: z.string().min(10).max(20).optional(),
          email: z.string().email().nullable().optional(),
          birthday: isoDate.nullable().optional(),
          marketingOptIn: z.boolean().optional(),
        }),
      },
    },
    (req) => req.tx((ctx) => svc.updateCustomerProfile(ctx, req.customer().customerId, req.body)),
  );
  app.get('/public/me/appointments', { config: customer, schema: { tags, querystring: z.object({ scope: z.enum(['upcoming', 'past']).default('upcoming') }) } }, (req) =>
    req.tx((ctx) => svc.customerAppointments(ctx, req.customer().customerId, req.query.scope)),
  );
  app.post('/public/me/appointments/:id/cancel', { config: customer, schema: { tags, summary: '顧客キャンセル(期限内)', params: z.object({ id: uuid }), body: z.object({ reason: z.string().max(500).optional() }).optional() } }, (req) =>
    req.tx((ctx) => svc.customerCancel(ctx, req.customer().customerId, req.params.id, req.body?.reason)),
  );
  app.patch(
    '/public/me/appointments/:id',
    { config: customer, schema: { tags, summary: '顧客による日時変更(期限内)', params: z.object({ id: uuid }), body: z.object({ startAt: isoDateTime, staffId: uuid.nullable().optional(), version: z.number().int() }) } },
    (req) => req.tx((ctx) => svc.customerReschedule(ctx, req.customer().customerId, req.params.id, req.body)),
  );

  // ----- guest booking management via signed link
  app.get('/public/bookings/:token', { config: publicRate, schema: { tags, summary: '予約確認(管理リンク)', params: z.object({ token: z.string().min(10) }) } }, async (req) => {
    const t = await resolveAccessToken(req.params.token, 'booking_manage');
    return withTenant(t.organizationId, async (trx) => {
      const ctx = { actor: systemActor(t.organizationId, 'public'), trx, meta: req.meta };
      const a = await getAppointmentUnchecked(ctx, t.resourceId);
      return svc.sanitizeAppointment(a, await svc.shopMeta(ctx, a.shop_id));
    });
  });
  app.post(
    '/public/bookings/:token/cancel',
    { config: publicRate, schema: { tags, summary: '予約キャンセル(管理リンク)', params: z.object({ token: z.string().min(10) }), body: z.object({ reason: z.string().max(500).optional() }).optional() } },
    async (req) => {
      const t = await resolveAccessToken(req.params.token, 'booking_manage');
      if (!t.customerId) throw Errors.unauthenticated('リンクが無効です', 'INVALID_LINK');
      return withTenant(t.organizationId, async (trx) => {
        const ctx = { actor: { kind: 'customer' as const, organizationId: t.organizationId, customerId: t.customerId!, via: 'link' as const }, trx, meta: req.meta };
        return svc.customerCancel(ctx, t.customerId!, t.resourceId, req.body?.reason);
      });
    },
  );
};

export default plugin;
