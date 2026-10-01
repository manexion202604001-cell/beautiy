import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { Errors } from '../../lib/errors.js';
import { idParam, uuid } from '../../lib/schemas.js';
import * as forms from './forms.js';
import {
  createAssetSchema,
  createFormResponseSchema,
  createFormTemplateSchema,
  createKarteSchema,
  createKarteTemplateSchema,
  duplicateKarteSchema,
  formLinkSchema,
  listFormResponsesSchema,
  listFormTemplatesSchema,
  listKarteTemplatesSchema,
  listKartesSchema,
  publicFormSubmitSchema,
  shareKarteSchema,
  updateAssetSchema,
  updateFormTemplateSchema,
  updateKarteSchema,
  updateKarteTemplateSchema,
  voidFormResponseSchema,
} from './schemas.js';
import './seed.js';
import * as svc from './service.js';
import * as templates from './templates.js';

const tags = ['kartes'];
const formTags = ['forms'];
const publicTags = ['public'];
const assetParams = z.object({ id: uuid, assetId: uuid });
const tokenParam = z.object({ token: z.string().min(10).max(200) });
const publicRate = { auth: 'public' as const, rateLimit: { max: 60, timeWindow: '1 minute' } };

const plugin: FastifyPluginAsyncZod = async (app) => {
  // ---------------------------------------------------------------- karte templates
  app.get('/karte-templates', { schema: { tags, summary: 'カルテテンプレート一覧', querystring: listKarteTemplatesSchema } }, (req) =>
    req.tx((ctx) => templates.listKarteTemplates(ctx, { shopId: req.query.shopId, includeInactive: req.query.includeInactive === 'true' })),
  );
  app.get('/karte-templates/:id', { schema: { tags, params: idParam } }, (req) => req.tx((ctx) => templates.getKarteTemplate(ctx, req.params.id)));
  app.post('/karte-templates', { schema: { tags, summary: 'カルテテンプレート作成(form.manage)', body: createKarteTemplateSchema } }, async (req, reply) =>
    reply.status(201).send(await req.tx((ctx) => templates.createKarteTemplate(ctx, req.body))),
  );
  app.patch('/karte-templates/:id', { schema: { tags, params: idParam, body: updateKarteTemplateSchema } }, (req) =>
    req.tx((ctx) => templates.updateKarteTemplate(ctx, req.params.id, req.body)),
  );
  app.delete('/karte-templates/:id', { schema: { tags, summary: 'カルテテンプレート無効化', params: idParam } }, async (req, reply) => {
    await req.tx((ctx) => templates.deactivateKarteTemplate(ctx, req.params.id));
    return reply.status(204).send();
  });

  // ---------------------------------------------------------------- kartes
  app.get('/kartes', { schema: { tags, summary: 'カルテ一覧(cursor)', querystring: listKartesSchema } }, (req) => req.tx((ctx) => svc.listKartes(ctx, req.query)));
  app.post('/kartes', { config: { idempotent: true }, schema: { tags, summary: 'カルテ作成(テンプレート項目を検証)', body: createKarteSchema } }, async (req, reply) =>
    reply.status(201).send(await req.tx((ctx) => svc.createKarte(ctx, req.body))),
  );
  app.get('/kartes/:id', { schema: { tags, summary: 'カルテ詳細(閲覧は監査対象)', params: idParam } }, (req) => req.tx((ctx) => svc.getKarte(ctx, req.params.id)));
  app.patch('/kartes/:id', { schema: { tags, summary: 'カルテ更新(楽観ロック: version必須)', params: idParam, body: updateKarteSchema } }, (req) =>
    req.tx((ctx) => svc.updateKarte(ctx, req.params.id, req.body)),
  );
  app.delete('/kartes/:id', { schema: { tags, summary: 'カルテ削除(論理削除・共有リンク失効)', params: idParam } }, async (req, reply) => {
    await req.tx((ctx) => svc.deleteKarte(ctx, req.params.id));
    return reply.status(204).send();
  });
  app.post('/kartes/:id/duplicate', { schema: { tags, summary: '前回カルテ複製', params: idParam, body: duplicateKarteSchema.optional() } }, async (req, reply) =>
    reply.status(201).send(await req.tx((ctx) => svc.duplicateKarte(ctx, req.params.id, duplicateKarteSchema.parse(req.body ?? {})))),
  );
  app.get(
    '/customers/:id/kartes/latest',
    { schema: { tags, summary: '前回カルテ(最新)', params: idParam, querystring: z.object({ templateId: uuid.optional(), shopId: uuid.optional() }) } },
    (req) => req.tx((ctx) => svc.latestKarte(ctx, req.params.id, req.query)),
  );

  // assets (photos / sketches / documents)
  app.get('/kartes/:id/assets', { schema: { tags, summary: 'カルテ画像一覧(署名付きURL)', params: idParam } }, (req) => req.tx((ctx) => svc.listAssets(ctx, req.params.id)));
  app.post('/kartes/:id/assets', { schema: { tags, summary: 'カルテに画像/書類を添付(/files/presign → complete 済みのファイル)', params: idParam, body: createAssetSchema } }, async (req, reply) =>
    reply.status(201).send(await req.tx((ctx) => svc.addAsset(ctx, req.params.id, req.body))),
  );
  app.patch('/kartes/:id/assets/:assetId', { schema: { tags, params: assetParams, body: updateAssetSchema } }, (req) =>
    req.tx((ctx) => svc.updateAsset(ctx, req.params.id, req.params.assetId, req.body)),
  );
  app.delete('/kartes/:id/assets/:assetId', { schema: { tags, params: assetParams } }, async (req, reply) => {
    await req.tx((ctx) => svc.deleteAsset(ctx, req.params.id, req.params.assetId));
    return reply.status(204).send();
  });

  // sharing with the customer
  app.post('/kartes/:id/share', { schema: { tags, summary: '施術写真・ホームケアを顧客へ共有(リンク発行/通知)', params: idParam, body: shareKarteSchema.optional() } }, (req) =>
    req.tx((ctx) => svc.shareKarte(ctx, req.params.id, shareKarteSchema.parse(req.body ?? {}))),
  );
  app.delete('/kartes/:id/share', { schema: { tags, summary: '共有の取り消し(リンク失効)', params: idParam } }, async (req, reply) => {
    await req.tx((ctx) => svc.unshareKarte(ctx, req.params.id));
    return reply.status(204).send();
  });
  app.get('/public/karte-shares/:token', { config: publicRate, schema: { tags: publicTags, summary: '共有カルテ(顧客向け・安全な項目のみ)', params: tokenParam } }, (req) =>
    svc.karteShareView(req.params.token, req.meta),
  );
  app.get('/public/me/kartes', { config: { auth: 'customer' }, schema: { tags: publicTags, summary: '共有されたカルテ一覧(顧客)' } }, (req) =>
    req.tx((ctx) => svc.listCustomerKartes(ctx, req.customer().customerId)),
  );
  app.get('/public/me/kartes/:id', { config: { auth: 'customer' }, schema: { tags: publicTags, summary: '共有されたカルテ(顧客)', params: idParam } }, (req) =>
    req.tx((ctx) => svc.getCustomerKarte(ctx, req.customer().customerId, req.params.id)),
  );

  // ---------------------------------------------------------------- form templates (versioned)
  app.get('/form-templates', { schema: { tags: formTags, summary: 'カウンセリング/同意書/事前アンケート テンプレート一覧', querystring: listFormTemplatesSchema } }, (req) =>
    req.tx((ctx) => forms.listFormTemplates(ctx, { kind: req.query.kind, shopId: req.query.shopId, includeArchived: req.query.includeArchived === 'true' })),
  );
  app.get('/form-templates/:id', { schema: { tags: formTags, params: idParam } }, (req) => req.tx((ctx) => forms.getFormTemplate(ctx, req.params.id)));
  app.get('/form-templates/:id/versions', { schema: { tags: formTags, summary: '版の履歴', params: idParam } }, (req) => req.tx((ctx) => forms.listFormTemplateVersions(ctx, req.params.id)));
  app.post('/form-templates', { schema: { tags: formTags, summary: 'テンプレート作成(form.manage)', body: createFormTemplateSchema } }, async (req, reply) =>
    reply.status(201).send(await req.tx((ctx) => forms.createFormTemplate(ctx, req.body))),
  );
  app.patch(
    '/form-templates/:id',
    { schema: { tags: formTags, summary: 'テンプレート編集(回答済みの版は新しい版を作成)', params: idParam, body: updateFormTemplateSchema } },
    (req) => req.tx((ctx) => forms.updateFormTemplate(ctx, req.params.id, req.body)),
  );
  app.delete('/form-templates/:id', { schema: { tags: formTags, summary: 'テンプレートのアーカイブ', params: idParam } }, async (req, reply) => {
    await req.tx((ctx) => forms.archiveFormTemplate(ctx, req.params.id));
    return reply.status(204).send();
  });

  // ---------------------------------------------------------------- form responses
  app.get('/form-responses', { schema: { tags: formTags, summary: 'フォーム回答一覧(顧客別)', querystring: listFormResponsesSchema } }, (req) =>
    req.tx((ctx) => forms.listFormResponses(ctx, req.query)),
  );
  app.post('/form-responses', { config: { idempotent: true }, schema: { tags: formTags, summary: '店頭での回答・署名(提出後は変更不可)', body: createFormResponseSchema } }, async (req, reply) =>
    reply.status(201).send(await req.tx((ctx) => forms.createFormResponse(ctx, req.body))),
  );
  app.get('/form-responses/:id', { schema: { tags: formTags, summary: 'フォーム回答詳細(閲覧は監査対象)', params: idParam } }, (req) => req.tx((ctx) => forms.getFormResponse(ctx, req.params.id)));
  app.patch('/form-responses/:id', { schema: { tags: formTags, summary: '提出済み書類は変更不可(無効化のみ)', params: idParam } }, async () => {
    throw Errors.conflict('FORM_RESPONSE_IMMUTABLE', '提出済みの書類は変更できません。必要な場合は無効化して再提出してください');
  });
  app.post('/form-responses/:id/void', { schema: { tags: formTags, summary: '書類の無効化(理由必須・監査)', params: idParam, body: voidFormResponseSchema } }, (req) =>
    req.tx((ctx) => forms.voidFormResponse(ctx, req.params.id, req.body.reason)),
  );
  app.get('/form-responses/:id/verify', { schema: { tags: formTags, summary: '文書ハッシュ・署名の改ざん検証', params: idParam } }, (req) =>
    req.tx((ctx) => forms.verifyFormResponse(ctx, req.params.id)),
  );
  app.get('/form-responses/:id/html', { schema: { tags: formTags, summary: '印刷用HTML', params: idParam } }, async (req, reply) => {
    const html = await req.tx((ctx) => forms.formResponseHtml(ctx, req.params.id));
    return reply.header('content-type', 'text/html; charset=utf-8').header('cache-control', 'no-store').send(html);
  });

  // customer links (事前入力・署名依頼)
  app.post('/appointments/:id/pre-visit-form', { schema: { tags: formTags, summary: '予約に事前入力フォームのリンクを発行(任意で送信)', params: idParam, body: formLinkSchema } }, async (req, reply) =>
    reply.status(201).send(await req.tx((ctx) => forms.createPreVisitFormLink(ctx, req.params.id, req.body))),
  );
  app.post('/customers/:id/form-links', { schema: { tags: formTags, summary: '顧客にフォームのリンクを発行(任意で送信)', params: idParam, body: formLinkSchema } }, async (req, reply) =>
    reply.status(201).send(await req.tx((ctx) => forms.createCustomerFormLink(ctx, req.params.id, req.body))),
  );
  app.get('/public/forms/:token', { config: publicRate, schema: { tags: publicTags, summary: 'フォーム表示(顧客リンク)', params: tokenParam } }, (req) =>
    forms.publicFormView(req.params.token, req.meta),
  );
  app.post(
    '/public/forms/:token',
    { config: { auth: 'public', rateLimit: { max: 20, timeWindow: '1 minute' } }, schema: { tags: publicTags, summary: 'フォーム提出(1回限り)', params: tokenParam, body: publicFormSubmitSchema } },
    async (req, reply) => reply.status(201).send(await forms.submitPublicForm(req.params.token, req.body, req.meta)),
  );
};

export default plugin;
