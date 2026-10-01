import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { config } from '../../config.js';
import { withSystem } from '../../db/tenant.js';
import { AppError, Errors } from '../../lib/errors.js';
import { booleanQuery, idParam } from '../../lib/schemas.js';
import { storage, verifyLocalBlobToken } from '../../lib/storage.js';
import './jobs.js';
import { baseContentType, FILE_PURPOSES, matchesSignature, MAX_UPLOAD_BYTES, PURPOSE_POLICIES, type FilePurpose } from './policy.js';
import * as svc from './service.js';

const tags = ['files'];

const presignBody = z.object({
  purpose: z.enum(FILE_PURPOSES),
  contentType: z.string().min(3).max(100),
  sizeBytes: z.number().int().min(1),
  fileName: z.string().max(255).nullable().optional(),
});

// Wildcard instead of ':token' — signed tokens exceed Fastify's maxParamLength (100) for parametric segments
const blobParams = z.object({ '*': z.string().min(10).max(4096) });

function verifyBlobToken(token: string, op: 'put' | 'get') {
  let claims: ReturnType<typeof verifyLocalBlobToken>;
  try {
    claims = verifyLocalBlobToken(token);
  } catch {
    claims = null;
  }
  if (!claims || typeof claims.k !== 'string') {
    throw Errors.unauthenticated('URLが無効か有効期限が切れています', 'INVALID_BLOB_TOKEN');
  }
  if (claims.op !== op) throw Errors.forbidden('このURLではこの操作はできません', 'BLOB_OPERATION_FORBIDDEN');
  return claims;
}

function contentDisposition(downloadName: string | null | undefined): string {
  if (!downloadName) return 'inline';
  const ascii = downloadName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(downloadName)}`;
}

const plugin: FastifyPluginAsyncZod = async (app) => {
  // Raw bytes for the local-driver blob PUT. Registered inside this plugin's encapsulation scope only:
  // JSON keeps using the global parser; every other content type arrives as a Buffer.
  app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: MAX_UPLOAD_BYTES }, (_req, body, done) => done(null, body));

  app.post('/files/presign', { schema: { tags, summary: 'アップロード用署名付きURL発行', description: '用途ごとに形式・サイズを検証し pending のファイルを作成。返却URLへ PUT 後 /files/:id/complete を呼ぶ', body: presignBody } }, async (req, reply) =>
    reply.status(201).send(await req.tx((ctx) => svc.presignUpload(ctx, req.body))),
  );

  app.post(
    '/files/:id/complete',
    { schema: { tags, summary: 'アップロード完了(サイズ・形式・チェックサム確認)', params: idParam, body: z.object({ checksumSha256: z.string().regex(/^[0-9a-fA-F]{64}$/).optional() }).optional() } },
    (req) => req.tx((ctx) => svc.completeUpload(ctx, req.params.id, req.body ?? {})),
  );

  app.get('/files/:id', { schema: { tags, summary: 'ファイル情報', params: idParam } }, (req) => req.tx((ctx) => svc.getFile(ctx, req.params.id)));

  app.get(
    '/files/:id/url',
    { schema: { tags, summary: 'ダウンロード用の短期署名付きURL(用途別に認可・個人情報は監査)', params: idParam, querystring: z.object({ download: booleanQuery }) } },
    (req) => req.tx((ctx) => svc.getDownloadUrl(ctx, req.params.id, { download: req.query.download })),
  );

  app.delete('/files/:id', { schema: { tags, summary: 'ファイル削除(論理削除+ストレージ削除ジョブ)', params: idParam } }, async (req, reply) => {
    await req.tx((ctx) => svc.deleteFile(ctx, req.params.id));
    return reply.status(204).send();
  });

  // ---------------------------------------------------------------- local storage driver endpoints
  // The signed token IS the authorization (issued by presign / download URL generation).
  app.put(
    '/files/blob/*',
    { bodyLimit: MAX_UPLOAD_BYTES, config: { auth: 'public' }, schema: { tags, summary: 'ローカルストレージへのアップロード(署名付きURL)', params: blobParams } },
    async (req, reply) => {
      if (config.STORAGE_DRIVER !== 'local') throw Errors.notFound('URL');
      const claims = verifyBlobToken(req.params['*'], 'put');
      const ct = baseContentType(req.headers['content-type']);
      if (!claims.ct || ct !== baseContentType(claims.ct)) {
        throw new AppError('validation', 'UNSUPPORTED_MEDIA_TYPE', 'Content-Typeが署名と一致しません', { expected: claims.ct }, 415);
      }
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) throw Errors.validation('ファイルが空です');

      const file = await withSystem((trx) =>
        trx.selectFrom('files').select(['id', 'purpose', 'status', 'size_bytes']).where('object_key', '=', claims.k).executeTakeFirst(),
      );
      if (!file) throw Errors.notFound('ファイル');
      if (file.status !== 'pending') throw Errors.conflict('FILE_NOT_PENDING', 'このファイルは既にアップロード済みか削除されています');
      const policy = PURPOSE_POLICIES[file.purpose as FilePurpose];
      const limit = Math.min(file.size_bytes ?? policy.maxBytes, policy.maxBytes);
      if (body.length > limit) throw svc.tooLarge(limit);
      if (!matchesSignature(ct, body)) throw svc.unsupportedType('ファイルの内容が形式と一致しません');

      await storage.put(claims.k, body, ct);
      return reply.status(204).send();
    },
  );

  app.get('/files/blob/*', { config: { auth: 'public' }, schema: { tags, summary: 'ローカルストレージからのダウンロード(署名付きURL)', params: blobParams } }, async (req, reply) => {
    if (config.STORAGE_DRIVER !== 'local') throw Errors.notFound('URL');
    const claims = verifyBlobToken(req.params['*'], 'get');
    const file = await withSystem((trx) =>
      trx.selectFrom('files').select(['id', 'status', 'content_type']).where('object_key', '=', claims.k).executeTakeFirst(),
    );
    if (!file || file.status !== 'uploaded') throw Errors.notFound('ファイル');
    let body: Buffer;
    try {
      body = await storage.get(claims.k);
    } catch {
      throw Errors.notFound('ファイル');
    }
    return reply
      .header('content-type', file.content_type)
      .header('content-length', body.length)
      .header('content-disposition', contentDisposition(claims.dn))
      .header('cache-control', 'private, max-age=300')
      .header('x-content-type-options', 'nosniff')
      .send(body);
  });
};

export default plugin;
