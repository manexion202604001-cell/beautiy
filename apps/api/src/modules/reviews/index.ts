import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { registerJob } from '../../jobs/queue.js';
import { onEvent } from '../../lib/events.js';
import { registerOrgSeeder } from '../../lib/org-seeders.js';
import { idParam, uuid } from '../../lib/schemas.js';
import { publicTx, resolveShopSlug } from '../public/service.js';
import { requestGoogleImport } from './google.js';
import {
  createReviewRequestSchema,
  googleImportSchema,
  listReviewRequestsSchema,
  listReviewsSchema,
  moderateReviewSchema,
  publicReviewsQuerySchema,
  replySchema,
  submitReviewSchema,
  summaryQuerySchema,
} from './schemas.js';
import * as svc from './service.js';

// ---------------------------------------------------------------- side effects

// Automatic review request after the visit. POS ('transaction.completed') and appointment completion
// (salons without POS) share one dedupe key per appointment, and the job re-checks for an existing
// request, so each visit gets at most one request.
onEvent<{ transactionId: string; shopId: string; customerId: string | null; appointmentId: string | null }>('transaction.completed', (ctx, e) =>
  e.payload.customerId
    ? svc.scheduleAutoReviewRequest(ctx, { shopId: e.payload.shopId, customerId: e.payload.customerId, appointmentId: e.payload.appointmentId, transactionId: e.payload.transactionId })
    : undefined,
);
onEvent<{ shopId: string; customerId: string | null }>('appointment.completed', (ctx, e) =>
  e.payload.customerId ? svc.scheduleAutoReviewRequest(ctx, { shopId: e.payload.shopId, customerId: e.payload.customerId, appointmentId: e.aggregateId }) : undefined,
);
onEvent<{ messageId: string }>('message.sent', (ctx, e) => svc.markRequestSent(ctx, e.payload.messageId));

registerJob<svc.AutoRequestPayload>('reviews.auto_request', async (p, jc) => {
  await jc.tx((ctx) => svc.runAutoReviewRequest(ctx, p));
});

// Default message template (runs late and never overwrites a template seeded by the messaging module)
registerOrgSeeder(
  'reviews.templates',
  async (ctx) => {
    const body =
      '{{customer.name}}様\n先日は{{shop.name}}にご来店いただき、誠にありがとうございました。\nよろしければ今回のご体験について口コミをお聞かせください（1分ほどで完了します）。\n{{review.url}}\n※リンクの有効期限は14日間です。';
    await ctx.trx
      .insertInto('message_templates')
      .values(
        (['line', 'email', 'sms'] as const).map((channel) => ({
          organization_id: ctx.actor.organizationId,
          key: 'review_request',
          name: '口コミ依頼',
          channel,
          category: 'review',
          subject: channel === 'email' ? '【{{shop.name}}】ご来店ありがとうございました' : null,
          body,
        })),
      )
      .onConflict((oc) => oc.doNothing())
      .execute();
  },
  900,
);

// ---------------------------------------------------------------- routes

const tags = ['reviews'];
const publicRate = { auth: 'public' as const, rateLimit: { max: 30, timeWindow: '1 minute' } };
const tokenParam = z.object({ token: z.string().min(10).max(200) });

const plugin: FastifyPluginAsyncZod = async (app) => {
  // ----- review requests (口コミ依頼URL発行)
  app.get('/review-requests', { schema: { tags, summary: '口コミ依頼一覧', querystring: listReviewRequestsSchema } }, (req) => req.tx((ctx) => svc.listReviewRequests(ctx, req.query)));
  app.post(
    '/review-requests',
    { config: { idempotent: true }, schema: { tags, summary: '口コミ依頼の手動発行(URL返却・メッセージ送信)', body: createReviewRequestSchema } },
    async (req, reply) => reply.status(201).send(await req.tx((ctx) => svc.createReviewRequest(ctx, req.body))),
  );

  // ----- staff management (口コミ投稿・返信管理)
  app.get('/reviews', { schema: { tags, summary: '口コミ一覧', querystring: listReviewsSchema } }, (req) => req.tx((ctx) => svc.listReviews(ctx, req.query)));
  app.get('/reviews/summary', { schema: { tags, summary: '評価集計(平均・件数・分布)', querystring: summaryQuerySchema } }, (req) => req.tx((ctx) => svc.reviewSummary(ctx, req.query)));
  app.post('/reviews/google/import', { schema: { tags, summary: 'Google口コミの取り込みを今すぐ実行', body: googleImportSchema } }, async (req, reply) =>
    reply.status(202).send(await req.tx((ctx) => requestGoogleImport(ctx, req.body.integrationAccountId))),
  );
  app.patch('/reviews/:id', { schema: { tags, summary: '公開/非表示(モデレーション)', params: idParam, body: moderateReviewSchema } }, (req) =>
    req.tx((ctx) => svc.moderateReview(ctx, req.params.id, req.body.status)),
  );
  app.post('/reviews/:id/reply', { config: { idempotent: true }, schema: { tags, summary: '口コミへの返信(Google口コミはGBPへ反映)', params: idParam, body: replySchema } }, (req) =>
    req.tx((ctx) => svc.replyToReview(ctx, req.params.id, req.body.body)),
  );

  // ----- public: review form via signed single-use link
  app.get('/public/reviews/request/:token', { config: publicRate, schema: { tags, summary: '口コミ投稿フォーム情報(開封記録)', params: tokenParam } }, (req) =>
    svc.publicReviewRequest(req.params.token, req.meta),
  );
  app.post('/public/reviews/request/:token', { config: publicRate, schema: { tags, summary: '口コミ投稿(1回限り)', params: tokenParam, body: submitReviewSchema } }, async (req, reply) =>
    reply.status(201).send(await svc.submitPublicReview(req.params.token, req.body, req.meta)),
  );

  // ----- public listing / stylist profile (公開プロフィール)
  const slugParam = z.object({ slug: z.string().min(1).max(60) });
  app.get(
    '/public/shops/:slug/reviews',
    { config: { auth: 'public', rateLimit: { max: 60, timeWindow: '1 minute' } }, schema: { tags, summary: '公開口コミ一覧', params: slugParam, querystring: publicReviewsQuerySchema } },
    async (req) => {
      const shop = await resolveShopSlug(req.params.slug);
      return publicTx(shop, req.meta, (ctx) => svc.publicShopReviews(ctx, shop.shopId, req.query));
    },
  );
  app.get(
    '/public/shops/:slug/staff/:staffId/profile',
    { config: { auth: 'public', rateLimit: { max: 60, timeWindow: '1 minute' } }, schema: { tags, summary: 'スタイリスト公開プロフィール', params: slugParam.extend({ staffId: uuid }) } },
    async (req) => {
      const shop = await resolveShopSlug(req.params.slug);
      return publicTx(shop, req.meta, (ctx) => svc.publicStaffProfile(ctx, shop.shopId, req.params.staffId));
    },
  );
};

export default plugin;
