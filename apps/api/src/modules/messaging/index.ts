import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requirePermission } from '../../auth/actor.js';
import { idParam } from '../../lib/schemas.js';
import * as automations from './automations.js';
import * as campaigns from './campaigns.js';
import * as channels from './channels.js';
import * as conversations from './conversations.js';
import { issueLineLinkToken, linkLineAccount } from './line-link.js';
import * as prefs from './preferences.js';
import {
  createAutomationSchema,
  createCampaignSchema,
  createLineChannelSchema,
  createSegmentSchema,
  createTemplateSchema,
  inboxSchema,
  lineLinkTokenSchema,
  listCampaignsSchema,
  listMessagesSchema,
  listTemplatesSchema,
  previewSegmentSchema,
  previewTemplateSchema,
  publicLineLinkSchema,
  scheduleCampaignSchema,
  sendMessageSchema,
  unsubscribeSchema,
  updateAutomationSchema,
  updateCampaignSchema,
  updateLineChannelSchema,
  updatePreferencesSchema,
  updateSegmentSchema,
  updateTemplateSchema,
} from './schemas.js';
import * as segments from './segments.js';
import * as templates from './templates.js';
import { paginationQuery } from '../../lib/pagination.js';

// side-effect registrations: jobs, event subscribers, webhook provider, periodic tasks, org seeders
import './delivery.js';
import './notifications.js';
import './webhook.js';

const tags = ['messaging'];
const publicRate = { auth: 'public' as const, rateLimit: { max: 30, timeWindow: '1 minute' } };

const plugin: FastifyPluginAsyncZod = async (app) => {
  // ------------------------------------------------------------ LINE channels (integration.manage)
  app.get('/line-channels', { schema: { tags, summary: 'LINE公式アカウント一覧(シークレットはマスク)' } }, (req) => req.tx((ctx) => channels.listLineChannels(ctx)));
  app.post('/line-channels', { config: { idempotent: true }, schema: { tags, summary: 'LINE公式アカウント登録(法人/店舗単位)', body: createLineChannelSchema } }, async (req, reply) => {
    requirePermission(req.staff(), 'integration.manage');
    const verified = await channels.prepareLineChannelCreate(req.body);
    return reply.status(201).send(await req.tx((ctx) => channels.createLineChannel(ctx, req.body, verified)));
  });
  app.get('/line-channels/:id', { schema: { tags, params: idParam } }, (req) => req.tx((ctx) => channels.getLineChannel(ctx, req.params.id)));
  app.patch('/line-channels/:id', { schema: { tags, params: idParam, body: updateLineChannelSchema } }, (req) => req.tx((ctx) => channels.updateLineChannel(ctx, req.params.id, req.body)));
  app.delete('/line-channels/:id', { schema: { tags, params: idParam } }, async (req, reply) => {
    await req.tx((ctx) => channels.deleteLineChannel(ctx, req.params.id));
    return reply.status(204).send();
  });
  app.post('/line-channels/:id/verify', { schema: { tags, summary: 'LINE認証情報の検証(bot userId取得)', params: idParam } }, async (req) => {
    const token = await req.tx((ctx) => channels.channelTokenForVerify(ctx, req.params.id));
    const info = await channels.verifyLineChannelCredentials(token);
    return req.tx((ctx) => channels.recordVerification(ctx, req.params.id, info));
  });

  // ------------------------------------------------------------ templates
  app.get('/message-templates', { schema: { tags, summary: 'メッセージテンプレート一覧', querystring: listTemplatesSchema } }, (req) => req.tx((ctx) => templates.listTemplates(ctx, req.query)));
  app.post('/message-templates', { schema: { tags, body: createTemplateSchema } }, async (req, reply) => reply.status(201).send(await req.tx((ctx) => templates.createTemplate(ctx, req.body))));
  app.post('/message-templates/preview', { schema: { tags, summary: 'テンプレートのプレビュー(サンプル/実顧客の変数で描画)', body: previewTemplateSchema } }, (req) =>
    req.tx((ctx) => templates.previewTemplate(ctx, req.body)),
  );
  app.get('/message-templates/:id', { schema: { tags, params: idParam } }, (req) => req.tx((ctx) => templates.getTemplate(ctx, req.params.id)));
  app.patch('/message-templates/:id', { schema: { tags, params: idParam, body: updateTemplateSchema } }, (req) => req.tx((ctx) => templates.updateTemplate(ctx, req.params.id, req.body)));
  app.delete('/message-templates/:id', { schema: { tags, params: idParam } }, async (req, reply) => {
    await req.tx((ctx) => templates.deleteTemplate(ctx, req.params.id));
    return reply.status(204).send();
  });

  // ------------------------------------------------------------ 1:1 messages / delivery log
  app.post('/messages/send', { config: { idempotent: true }, schema: { tags, summary: '個別メッセージ送信(非同期配信)', body: sendMessageSchema } }, async (req, reply) =>
    reply.status(201).send(await req.tx((ctx) => conversations.sendMessage(ctx, req.body))),
  );
  app.get('/messages', { schema: { tags, summary: '顧客とのメッセージ履歴(配信ログ)', querystring: listMessagesSchema } }, (req) => req.tx((ctx) => conversations.listConversation(ctx, req.query)));
  app.get('/messages/inbox', { schema: { tags, summary: '受信箱(顧客ごとの最新メッセージ・未読数)', querystring: inboxSchema } }, (req) => req.tx((ctx) => conversations.inbox(ctx, req.query)));
  app.get('/messages/:id', { schema: { tags, params: idParam } }, (req) => req.tx((ctx) => conversations.getMessage(ctx, req.params.id)));
  app.post('/messages/:id/read', { schema: { tags, summary: '既読にする', params: idParam } }, (req) => req.tx((ctx) => conversations.markRead(ctx, req.params.id)));
  app.post('/messages/:id/retry', { config: { idempotent: true }, schema: { tags, summary: '送信失敗メッセージの再送', params: idParam } }, (req) =>
    req.tx((ctx) => conversations.retryMessage(ctx, req.params.id)),
  );

  // ------------------------------------------------------------ segments (要件 13.1)
  app.get('/segments', { schema: { tags, querystring: paginationQuery } }, (req) => req.tx((ctx) => segments.listSegments(ctx, req.query)));
  app.post('/segments', { schema: { tags, body: createSegmentSchema } }, async (req, reply) => reply.status(201).send(await req.tx((ctx) => segments.createSegment(ctx, req.body))));
  app.post('/segments/preview', { schema: { tags, summary: 'セグメント条件の対象人数・サンプル', body: previewSegmentSchema } }, (req) => req.tx((ctx) => segments.previewSegment(ctx, req.body)));
  app.get('/segments/:id', { schema: { tags, params: idParam } }, (req) => req.tx((ctx) => segments.getSegment(ctx, req.params.id)));
  app.patch('/segments/:id', { schema: { tags, params: idParam, body: updateSegmentSchema } }, (req) => req.tx((ctx) => segments.updateSegment(ctx, req.params.id, req.body)));
  app.delete('/segments/:id', { schema: { tags, params: idParam } }, async (req, reply) => {
    await req.tx((ctx) => segments.deleteSegment(ctx, req.params.id));
    return reply.status(204).send();
  });

  // ------------------------------------------------------------ campaigns (一括配信)
  app.get('/campaigns', { schema: { tags, querystring: listCampaignsSchema } }, (req) => req.tx((ctx) => campaigns.listCampaigns(ctx, req.query)));
  app.post('/campaigns', { config: { idempotent: true }, schema: { tags, summary: 'キャンペーン(下書き)作成', body: createCampaignSchema } }, async (req, reply) =>
    reply.status(201).send(await req.tx((ctx) => campaigns.createCampaign(ctx, req.body))),
  );
  app.get('/campaigns/:id', { schema: { tags, summary: 'キャンペーン詳細(配信統計)', params: idParam } }, (req) => req.tx((ctx) => campaigns.getCampaign(ctx, req.params.id)));
  app.patch('/campaigns/:id', { schema: { tags, params: idParam, body: updateCampaignSchema } }, (req) => req.tx((ctx) => campaigns.updateCampaign(ctx, req.params.id, req.body)));
  app.delete('/campaigns/:id', { schema: { tags, params: idParam } }, async (req, reply) => {
    await req.tx((ctx) => campaigns.deleteCampaign(ctx, req.params.id));
    return reply.status(204).send();
  });
  app.post('/campaigns/:id/approve', { schema: { tags, summary: '配信承認', params: idParam } }, (req) => req.tx((ctx) => campaigns.approveCampaign(ctx, req.params.id)));
  app.post('/campaigns/:id/schedule', { config: { idempotent: true }, schema: { tags, summary: '配信予約(スタッフの明示操作でのみ送信)', params: idParam, body: scheduleCampaignSchema } }, (req) =>
    req.tx((ctx) => campaigns.scheduleCampaign(ctx, req.params.id, req.body)),
  );
  app.post('/campaigns/:id/cancel', { schema: { tags, summary: '配信キャンセル(未送信分を取消)', params: idParam } }, (req) => req.tx((ctx) => campaigns.cancelCampaign(ctx, req.params.id)));

  // ------------------------------------------------------------ automations (来店周期・休眠)
  app.get('/automations', { schema: { tags } }, (req) => req.tx((ctx) => automations.listAutomations(ctx)));
  app.post('/automations', { schema: { tags, body: createAutomationSchema } }, async (req, reply) => reply.status(201).send(await req.tx((ctx) => automations.createAutomation(ctx, req.body))));
  app.get('/automations/:id', { schema: { tags, params: idParam } }, (req) => req.tx((ctx) => automations.getAutomation(ctx, req.params.id)));
  app.patch('/automations/:id', { schema: { tags, params: idParam, body: updateAutomationSchema } }, (req) => req.tx((ctx) => automations.updateAutomation(ctx, req.params.id, req.body)));
  app.delete('/automations/:id', { schema: { tags, params: idParam } }, (req) => req.tx((ctx) => automations.deleteAutomation(ctx, req.params.id)));
  app.post('/automations/:id/dry-run', { schema: { tags, summary: '対象者数の試算(送信しない)', params: idParam } }, (req) => req.tx((ctx) => automations.dryRunAutomation(ctx, req.params.id)));

  // ------------------------------------------------------------ opt-out / preferences
  app.get('/customers/:id/channel-preferences', { schema: { tags, summary: '配信設定(チャネル別同意)', params: idParam } }, (req) => req.tx((ctx) => prefs.getCustomerPreferences(ctx, req.params.id)));
  app.put('/customers/:id/channel-preferences', { schema: { tags, summary: '配信設定の変更(スタッフ)', params: idParam, body: updatePreferencesSchema } }, (req) =>
    req.tx((ctx) => prefs.updateCustomerPreferences(ctx, req.params.id, req.body)),
  );
  app.get('/public/me/notification-preferences', { config: { auth: 'customer' }, schema: { tags, summary: '通知設定(顧客本人)' } }, (req) =>
    req.tx((ctx) => prefs.getMyPreferences(ctx, req.customer().customerId)),
  );
  app.put('/public/me/notification-preferences', { config: { auth: 'customer' }, schema: { tags, summary: '通知設定の変更(顧客本人)', body: updatePreferencesSchema } }, (req) =>
    req.tx((ctx) => prefs.updateMyPreferences(ctx, req.customer().customerId, req.body)),
  );
  app.get('/public/unsubscribe', { config: publicRate, schema: { tags, summary: '配信停止リンクの確認', querystring: z.object({ token: z.string().min(10).max(2000) }) } }, (req) =>
    prefs.unsubscribeInfo(req.query.token, req.meta),
  );
  app.post('/public/unsubscribe', { config: publicRate, schema: { tags, summary: '配信停止(メールのリンク)', body: unsubscribeSchema } }, (req) => prefs.unsubscribe(req.body.token, req.body.scope, req.meta));

  // ------------------------------------------------------------ LINE account linking
  app.post('/customers/:id/line-link-token', { schema: { tags, summary: '既存顧客のLINE連携用リンク(QR)発行', params: idParam, body: lineLinkTokenSchema } }, async (req, reply) =>
    reply.status(201).send(await req.tx((ctx) => issueLineLinkToken(ctx, req.params.id, req.body))),
  );
  app.post('/public/line-link', { config: publicRate, schema: { tags, summary: 'LINEアカウント連携(LIFF idToken + 連携トークン)', body: publicLineLinkSchema } }, (req) => linkLineAccount(req.body, req.meta));
};

export default plugin;
