import { randomUUID } from 'node:crypto';
import type { Selectable } from 'kysely';
import { auditUserId, can, requireAnyPermission, requirePermission, type Ctx } from '../../auth/actor.js';
import { config } from '../../config.js';
import type { Files } from '../../db/types.js';
import { enqueue } from '../../jobs/queue.js';
import { audit } from '../../lib/audit.js';
import { sha256 } from '../../lib/crypto.js';
import { AppError, Errors } from '../../lib/errors.js';
import { storage, type PresignedUpload } from '../../lib/storage.js';
import { assertCustomerAccess } from '../customers/access.js';
import { assertKarteReadable } from '../kartes/access.js';
import {
  baseContentType,
  EXTENSIONS,
  matchesSignature,
  PURPOSE_POLICIES,
  sanitizeFileName,
  SENSITIVE_PURPOSES,
  type FilePurpose,
} from './policy.js';

export type FileRow = Selectable<Files>;

export const UPLOAD_URL_TTL_SEC = 15 * 60;
export const DOWNLOAD_URL_TTL_SEC = 10 * 60;
const MB = 1024 * 1024;

/** Response shape for file metadata (object key and checksum are internal) */
export function fileView(f: FileRow) {
  return {
    id: f.id,
    purpose: f.purpose,
    contentType: f.content_type,
    sizeBytes: f.size_bytes,
    fileName: f.file_name,
    status: f.status,
    uploadedBy: f.uploaded_by,
    createdAt: f.created_at,
    uploadedAt: f.uploaded_at,
  };
}

export function objectKeyFor(organizationId: string, purpose: FilePurpose, contentType: string, now = new Date()): string {
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `org/${organizationId}/${purpose}/${yyyy}/${mm}/${randomUUID()}.${EXTENSIONS[contentType] ?? 'bin'}`;
}

export function tooLarge(maxBytes: number) {
  return new AppError('validation', 'FILE_TOO_LARGE', `ファイルサイズが上限(${Math.round((maxBytes / MB) * 10) / 10}MB)を超えています`, { maxBytes }, 413);
}

export function unsupportedType(message: string, details?: unknown) {
  return new AppError('validation', 'UNSUPPORTED_MEDIA_TYPE', message, details, 415);
}

/** Validate content type + size for a purpose; returns the normalized content type */
export function validateUpload(purpose: FilePurpose, contentType: string, sizeBytes: number): string {
  const policy = PURPOSE_POLICIES[purpose];
  const ct = baseContentType(contentType);
  if (!policy.contentTypes.includes(ct)) {
    throw unsupportedType(`${policy.label}にはこの形式のファイルは使用できません (${ct || '不明'})`, { allowed: policy.contentTypes });
  }
  if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) throw Errors.validation('ファイルが空です');
  if (sizeBytes > policy.maxBytes) throw tooLarge(policy.maxBytes);
  return ct;
}

function assertUploadPermission(ctx: Ctx, purpose: string) {
  const policy = PURPOSE_POLICIES[purpose as FilePurpose];
  if (!policy) throw Errors.validation('不正なファイル用途です');
  requireAnyPermission(ctx.actor, ...policy.writePermissions);
}

async function loadFile(ctx: Ctx, fileId: string, opts: { forUpdate?: boolean } = {}) {
  let q = ctx.trx.selectFrom('files').selectAll().where('id', '=', fileId).where('status', '<>', 'deleted');
  if (opts.forUpdate) q = q.forUpdate();
  const row = await q.executeTakeFirst();
  if (!row) throw Errors.notFound('ファイル', fileId);
  return row;
}

// ---------------------------------------------------------------- upload (presigned PUT)

export interface PresignInput {
  purpose: FilePurpose;
  contentType: string;
  sizeBytes: number;
  fileName?: string | null;
}

export async function presignUpload(ctx: Ctx, input: PresignInput): Promise<{ fileId: string; file: ReturnType<typeof fileView>; upload: PresignedUpload }> {
  assertUploadPermission(ctx, input.purpose);
  const ct = validateUpload(input.purpose, input.contentType, input.sizeBytes);
  const objectKey = objectKeyFor(ctx.actor.organizationId, input.purpose, ct);
  const row = await ctx.trx
    .insertInto('files')
    .values({
      organization_id: ctx.actor.organizationId,
      object_key: objectKey,
      purpose: input.purpose,
      content_type: ct,
      // declared size: the local blob endpoint refuses larger bodies; replaced by the actual size on complete
      size_bytes: input.sizeBytes,
      file_name: sanitizeFileName(input.fileName),
      status: 'pending',
      uploaded_by: auditUserId(ctx.actor),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  const upload = await storage.presignUpload(objectKey, ct, UPLOAD_URL_TTL_SEC);
  return { fileId: row.id, file: fileView(row), upload };
}

export async function completeUpload(ctx: Ctx, fileId: string, input: { checksumSha256?: string }) {
  const row = await loadFile(ctx, fileId, { forUpdate: true });
  assertUploadPermission(ctx, row.purpose);
  if (ctx.actor.kind === 'staff' && row.uploaded_by && row.uploaded_by !== ctx.actor.staffId) {
    throw Errors.forbidden('アップロードを開始したスタッフのみ完了できます');
  }
  if (row.status === 'uploaded') return fileView(row);

  const head = await storage.head(row.object_key);
  if (!head) throw Errors.business('FILE_NOT_UPLOADED', 'ファイルがまだアップロードされていません');
  const policy = PURPOSE_POLICIES[row.purpose as FilePurpose];
  if (head.size <= 0) throw Errors.business('FILE_EMPTY', 'ファイルが空です');
  if (head.size > policy.maxBytes) throw tooLarge(policy.maxBytes);

  let checksum: string | null = null;
  if (input.checksumSha256 || config.STORAGE_DRIVER === 'local') {
    const body = await storage.get(row.object_key);
    if (!matchesSignature(row.content_type, body)) throw unsupportedType('ファイルの内容が形式と一致しません');
    checksum = sha256(body);
    if (input.checksumSha256 && input.checksumSha256.toLowerCase() !== checksum) {
      throw Errors.business('CHECKSUM_MISMATCH', 'ファイルのチェックサムが一致しません。再アップロードしてください');
    }
  }
  const updated = await ctx.trx
    .updateTable('files')
    .set({ status: 'uploaded', size_bytes: head.size, checksum_sha256: checksum, uploaded_at: new Date() })
    .where('id', '=', fileId)
    .returningAll()
    .executeTakeFirstOrThrow();
  await audit(ctx, {
    action: 'file.upload',
    resourceType: 'file',
    resourceId: fileId,
    after: { purpose: updated.purpose, content_type: updated.content_type, size_bytes: updated.size_bytes },
  });
  return fileView(updated);
}

/**
 * Server-side upload (signatures, generated exports...): validates type/size/magic bytes,
 * writes to object storage and records an already-uploaded file. Caller is responsible for authorization.
 */
export async function createFileRecord(
  ctx: Ctx,
  input: { purpose: FilePurpose; contentType: string; body: Buffer; fileName?: string | null },
): Promise<FileRow> {
  const ct = validateUpload(input.purpose, input.contentType, input.body.length);
  if (!matchesSignature(ct, input.body)) throw unsupportedType('ファイルの内容が形式と一致しません');
  const objectKey = objectKeyFor(ctx.actor.organizationId, input.purpose, ct);
  await storage.put(objectKey, input.body, ct);
  return ctx.trx
    .insertInto('files')
    .values({
      organization_id: ctx.actor.organizationId,
      object_key: objectKey,
      purpose: input.purpose,
      content_type: ct,
      size_bytes: input.body.length,
      checksum_sha256: sha256(input.body),
      file_name: sanitizeFileName(input.fileName),
      status: 'uploaded',
      uploaded_by: auditUserId(ctx.actor),
      uploaded_at: new Date(),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

// ---------------------------------------------------------------- download

/**
 * Resource authorization for reading a file, by purpose:
 *  - karte_photo / sketch / document attached to a karte: karte.read + shop + customer access
 *  - signature attached to a form response: karte.read + customer access
 *  - not yet attached: only the uploader
 *  - product_image / staff_photo: any staff of the organization
 *  - sns_asset: marketing.manage or uploader
 *  - export: export.data AND the requester who generated it
 */
export async function assertFileReadable(ctx: Ctx, file: FileRow): Promise<void> {
  if (ctx.actor.kind === 'system') return;
  if (ctx.actor.kind !== 'staff') throw Errors.notFound('ファイル', file.id);
  const isUploader = !!file.uploaded_by && file.uploaded_by === ctx.actor.staffId;
  switch (file.purpose) {
    case 'product_image':
    case 'staff_photo':
      return;
    case 'karte_photo':
    case 'sketch':
    case 'document': {
      const owner = await ctx.trx
        .selectFrom('karte_assets')
        .innerJoin('kartes', 'kartes.id', 'karte_assets.karte_id')
        .select(['kartes.id', 'kartes.shop_id', 'kartes.customer_id'])
        .where('karte_assets.file_id', '=', file.id)
        .where('karte_assets.deleted_at', 'is', null)
        .where('kartes.deleted_at', 'is', null)
        .executeTakeFirst();
      if (owner) return assertKarteReadable(ctx, owner);
      if (isUploader) return;
      throw Errors.notFound('ファイル', file.id);
    }
    case 'signature': {
      const resp = await ctx.trx.selectFrom('form_responses').select(['id', 'customer_id']).where('signature_file_id', '=', file.id).executeTakeFirst();
      if (resp) {
        requirePermission(ctx.actor, 'karte.read');
        await assertCustomerAccess(ctx, resp.customer_id, { allowMerged: true });
        return;
      }
      if (isUploader) return;
      throw Errors.notFound('ファイル', file.id);
    }
    case 'sns_asset':
      if (isUploader || can(ctx.actor, 'marketing.manage')) return;
      throw Errors.notFound('ファイル', file.id);
    case 'export':
      requirePermission(ctx.actor, 'export.data');
      if (!isUploader) throw Errors.notFound('ファイル', file.id);
      return;
    default:
      throw Errors.notFound('ファイル', file.id);
  }
}

/** Signed short-lived URL for an object WITHOUT authorization (callers must have checked access) */
export async function signedUrlFor(file: Pick<FileRow, 'object_key' | 'file_name'>, opts: { ttlSec?: number; download?: boolean } = {}) {
  const ttl = opts.ttlSec ?? DOWNLOAD_URL_TTL_SEC;
  const url = await storage.presignDownload(file.object_key, ttl, opts.download ? (file.file_name ?? 'download') : undefined);
  return { url, expiresAt: new Date(Date.now() + ttl * 1000).toISOString() };
}

/** Raw object bytes (no authorization) */
export async function readFileBytes(file: Pick<FileRow, 'object_key'>): Promise<Buffer | null> {
  try {
    return await storage.get(file.object_key);
  } catch {
    return null;
  }
}

export async function getDownloadUrl(ctx: Ctx, fileId: string, opts: { ttlSec?: number; download?: boolean } = {}) {
  const file = await loadFile(ctx, fileId);
  if (file.status !== 'uploaded') throw Errors.business('FILE_NOT_UPLOADED', 'ファイルのアップロードが完了していません');
  await assertFileReadable(ctx, file);
  const signed = await signedUrlFor(file, opts);
  if (SENSITIVE_PURPOSES.has(file.purpose)) {
    await audit(ctx, { action: 'file.download', resourceType: 'file', resourceId: file.id, metadata: { purpose: file.purpose } });
  }
  return { ...signed, contentType: file.content_type, fileName: file.file_name, sizeBytes: file.size_bytes };
}

export async function getFile(ctx: Ctx, fileId: string) {
  const file = await loadFile(ctx, fileId);
  await assertFileReadable(ctx, file);
  return fileView(file);
}

/**
 * Validate that a file can be attached to a resource: uploaded, same organization (RLS), allowed purpose.
 */
export async function getAttachableFile(ctx: Ctx, fileId: string, purposes: readonly FilePurpose[]): Promise<FileRow> {
  const file = await ctx.trx.selectFrom('files').selectAll().where('id', '=', fileId).where('status', '<>', 'deleted').executeTakeFirst();
  if (!file) throw Errors.notFound('ファイル', fileId);
  if (file.status !== 'uploaded') throw Errors.business('FILE_NOT_UPLOADED', 'ファイルのアップロードが完了していません');
  if (!purposes.includes(file.purpose as FilePurpose)) {
    throw Errors.validation(`このファイルは添付できません (用途: ${file.purpose})`, { allowed: purposes });
  }
  return file;
}

// ---------------------------------------------------------------- delete

/** Soft delete + enqueue object deletion. No authorization: internal use by owning modules. */
export async function markFileDeleted(ctx: Ctx, fileId: string) {
  const res = await ctx.trx
    .updateTable('files')
    .set({ status: 'deleted', deleted_at: new Date(), deleted_by: auditUserId(ctx.actor) })
    .where('id', '=', fileId)
    .where('status', '<>', 'deleted')
    .executeTakeFirst();
  if (Number(res.numUpdatedRows) > 0) {
    await enqueue(ctx, { type: 'files.delete_object', payload: { fileId }, dedupeKey: `file-delete:${fileId}` });
  }
}

export async function deleteFile(ctx: Ctx, fileId: string) {
  const file = await loadFile(ctx, fileId, { forUpdate: true });
  assertUploadPermission(ctx, file.purpose);
  const isUploader = ctx.actor.kind === 'staff' && file.uploaded_by === ctx.actor.staffId;
  if (file.purpose === 'export' && ctx.actor.kind !== 'system' && !isUploader) throw Errors.notFound('ファイル', fileId);

  const asset = await ctx.trx.selectFrom('karte_assets').select('id').where('file_id', '=', fileId).where('deleted_at', 'is', null).executeTakeFirst();
  if (asset) throw Errors.conflict('FILE_IN_USE', 'カルテに添付されているファイルは削除できません。先にカルテから削除してください');
  const signature = await ctx.trx.selectFrom('form_responses').select('id').where('signature_file_id', '=', fileId).executeTakeFirst();
  if (signature) throw Errors.conflict('FILE_IN_USE', '署名済み書類のファイルは削除できません');

  await markFileDeleted(ctx, fileId);
  await audit(ctx, { action: 'file.delete', resourceType: 'file', resourceId: fileId, before: { purpose: file.purpose, status: file.status } });
}
