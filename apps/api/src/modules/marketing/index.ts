import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { onEvent } from '../../lib/events.js';
import { idParam } from '../../lib/schemas.js';
import { createReferralLinkSchema, createSnsAssetSchema, listReferralLinksSchema, listSnsAssetsSchema, statsQuerySchema, updateReferralLinkSchema } from './schemas.js';
import * as svc from './service.js';
import * as sns from './sns.js';

// ---- attribution subscribers (transactional, cheap)
onEvent('appointment.created', (ctx, e) => svc.attributeAppointment(ctx, e.aggregateId));
onEvent<{ orderId: string; customerId?: string | null; total?: number; referralLinkId?: string | null }>('order.paid', (ctx, e) => svc.attributeOrder(ctx, e.payload));

const tags = ['marketing'];

const plugin: FastifyPluginAsyncZod = async (app) => {
  // ----- referral / tracking links (紹介リンク・計測パラメータ)
  app.get('/referral-links', { schema: { tags, summary: '紹介リンク一覧', querystring: listReferralLinksSchema } }, (req) => req.tx((ctx) => svc.listReferralLinks(ctx, req.query)));
  app.post('/referral-links', { config: { idempotent: true }, schema: { tags, summary: '紹介リンク作成(短縮コード発行)', body: createReferralLinkSchema } }, async (req, reply) =>
    reply.status(201).send(await req.tx((ctx) => svc.createReferralLink(ctx, req.body))),
  );
  app.get('/referral-links/:id', { schema: { tags, params: idParam } }, (req) => req.tx((ctx) => svc.getReferralLink(ctx, req.params.id)));
  app.patch('/referral-links/:id', { schema: { tags, summary: '紹介リンク更新(コードは不変)', params: idParam, body: updateReferralLinkSchema } }, (req) =>
    req.tx((ctx) => svc.updateReferralLink(ctx, req.params.id, req.body)),
  );
  app.delete('/referral-links/:id', { schema: { tags, params: idParam } }, async (req, reply) => {
    await req.tx((ctx) => svc.deleteReferralLink(ctx, req.params.id));
    return reply.status(204).send();
  });
  app.get('/referral-links/:id/stats', { schema: { tags, summary: 'クリック・予約・購入・売上', params: idParam, querystring: statsQuerySchema } }, (req) =>
    req.tx((ctx) => svc.referralLinkStats(ctx, req.params.id, req.query)),
  );
  app.post('/customers/:id/referral-link', { schema: { tags, summary: 'お友達紹介リンク発行(既存があれば再利用)', params: idParam } }, (req) =>
    req.tx((ctx) => svc.customerReferralLink(ctx, req.params.id)),
  );

  // customer self-service: own friend-referral link
  app.get('/public/me/referral-link', { config: { auth: 'customer' }, schema: { tags, summary: '自分のお友達紹介リンク' } }, (req) =>
    req.tx((ctx) => svc.ensureCustomerReferralLinkUnchecked(ctx, req.customer().customerId)),
  );

  // public redirect: counts the click and 302s to the booking/product/profile page
  app.get(
    '/public/r/:code',
    { config: { auth: 'public', rateLimit: { max: 120, timeWindow: '1 minute' } }, schema: { tags, summary: '紹介リンクのリダイレクト(クリック計測)', params: z.object({ code: z.string().min(4).max(50) }) } },
    async (req, reply) => {
      const referer = typeof req.headers.referer === 'string' ? req.headers.referer : undefined;
      const url = await svc.followReferral(req.params.code, { ...req.meta, referer });
      return reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer').redirect(url, 302);
    },
  );

  // ----- SNS share material (SNS共有用素材生成)
  app.get('/sns-assets', { schema: { tags, summary: 'SNS素材一覧', querystring: listSnsAssetsSchema } }, (req) => req.tx((ctx) => sns.listSnsAssets(ctx, req.query)));
  app.post(
    '/sns-assets',
    { config: { idempotent: true }, schema: { tags, summary: 'SNS素材生成(SVG 1080x1080)。顧客写真は掲載同意必須', body: createSnsAssetSchema } },
    async (req, reply) => reply.status(201).send(await req.tx((ctx) => sns.createSnsAsset(ctx, req.body))),
  );
  app.get('/sns-assets/:id', { schema: { tags, summary: 'SNS素材(ダウンロードURL付き)', params: idParam } }, (req) => req.tx((ctx) => sns.getSnsAsset(ctx, req.params.id)));
  app.delete('/sns-assets/:id', { schema: { tags, params: idParam } }, async (req, reply) => {
    await req.tx((ctx) => sns.deleteSnsAsset(ctx, req.params.id));
    return reply.status(204).send();
  });
};

export default plugin;
