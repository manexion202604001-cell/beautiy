// Object storage: S3-compatible when configured, otherwise Postgres blob fallback.
import { randomToken } from '@salonos/core/crypto';
import { prisma } from './db';
import { env } from './env';
import { AppError } from './errors';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/gif', 'application/pdf']);

let s3Client: any = null;
async function s3() {
  const cfg = env.s3;
  if (!cfg) return null;
  if (!s3Client) {
    const { S3Client } = await import('@aws-sdk/client-s3');
    s3Client = new S3Client({
      region: cfg.region, endpoint: cfg.endpoint, forcePathStyle: !!cfg.endpoint,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    });
  }
  return { client: s3Client, bucket: cfg.bucket };
}

export function objectKey(orgId: string, area: string, ext: string) {
  return `org/${orgId}/${area}/${Date.now()}-${randomToken(9)}.${ext.replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'bin'}`;
}

export async function putObject(orgId: string, key: string, data: Uint8Array, contentType: string) {
  if (!ALLOWED.has(contentType)) throw new AppError('対応していないファイル形式です');
  if (data.byteLength > MAX_UPLOAD_BYTES) throw new AppError('ファイルサイズは10MBまでです');
  if (!key.startsWith(`org/${orgId}/`)) throw new AppError('invalid key');
  const s = await s3();
  if (s) {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    await s.client.send(new PutObjectCommand({ Bucket: s.bucket, Key: key, Body: data, ContentType: contentType }));
  } else {
    await prisma.storedFile.create({ data: { organizationId: orgId, key, contentType, size: data.byteLength, data: Buffer.from(data) } });
  }
  return { key, size: data.byteLength, contentType };
}

export async function getObject(key: string): Promise<{ data: Uint8Array; contentType: string } | null> {
  const s = await s3();
  if (s) {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    try {
      const r = await s.client.send(new GetObjectCommand({ Bucket: s.bucket, Key: key }));
      return { data: await r.Body.transformToByteArray(), contentType: r.ContentType ?? 'application/octet-stream' };
    } catch { return null; }
  }
  const f = await prisma.storedFile.findUnique({ where: { key } });
  return f ? { data: new Uint8Array(f.data), contentType: f.contentType } : null;
}

export async function deleteObject(key: string) {
  const s = await s3();
  if (s) {
    const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
    await s.client.send(new DeleteObjectCommand({ Bucket: s.bucket, Key: key }));
  } else {
    await prisma.storedFile.deleteMany({ where: { key } });
  }
}

/** Parse a File from FormData into bytes with validation. */
export async function readUpload(file: File | null): Promise<{ data: Uint8Array; contentType: string; ext: string } | null> {
  if (!file || typeof file === 'string' || file.size === 0) return null;
  if (file.size > MAX_UPLOAD_BYTES) throw new AppError('ファイルサイズは10MBまでです');
  const contentType = file.type || 'application/octet-stream';
  if (!ALLOWED.has(contentType)) throw new AppError('JPEG/PNG/WebP/HEIC/GIF/PDF のみアップロードできます');
  const ext = (file.name.split('.').pop() ?? 'bin').toLowerCase();
  return { data: new Uint8Array(await file.arrayBuffer()), contentType, ext };
}

/** URL served by app/api/files/[...key]/route.ts (access-checked). */
export function fileUrl(key: string, shareToken?: string) {
  return `/api/files/${key}${shareToken ? `?t=${encodeURIComponent(shareToken)}` : ''}`;
}
