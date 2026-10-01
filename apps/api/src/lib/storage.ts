import { createHash, createHmac } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { signPayload, verifySignedPayload } from './crypto.js';

/**
 * Object storage abstraction (要件 21: files go to object storage, DB keeps metadata only).
 *  - local: files under STORAGE_LOCAL_DIR, signed URLs served by the API (/v1/files/blob/:token)
 *  - s3:    AWS SigV4 presigned URLs (S3 / R2 / MinIO compatible), no SDK dependency
 */
export interface PresignedUpload {
  url: string;
  method: 'PUT';
  headers: Record<string, string>;
  expiresAt: string;
}

export interface StorageDriver {
  presignUpload(objectKey: string, contentType: string, ttlSec?: number): Promise<PresignedUpload>;
  presignDownload(objectKey: string, ttlSec?: number, downloadName?: string): Promise<string>;
  put(objectKey: string, body: Buffer, contentType: string): Promise<void>;
  get(objectKey: string): Promise<Buffer>;
  head(objectKey: string): Promise<{ size: number } | null>;
  delete(objectKey: string): Promise<void>;
}

function safeLocalPath(objectKey: string): string {
  const root = path.resolve(config.STORAGE_LOCAL_DIR);
  const full = path.resolve(root, objectKey);
  if (!full.startsWith(root + path.sep)) throw new Error('Invalid object key');
  return full;
}

export const localDriver: StorageDriver = {
  async presignUpload(objectKey, contentType, ttlSec = 900) {
    const token = signPayload({ k: objectKey, ct: contentType, op: 'put' }, ttlSec);
    return {
      url: `${config.API_BASE_URL}/v1/files/blob/${token}`,
      method: 'PUT',
      headers: { 'content-type': contentType },
      expiresAt: new Date(Date.now() + ttlSec * 1000).toISOString(),
    };
  },
  async presignDownload(objectKey, ttlSec = 900, downloadName) {
    const token = signPayload({ k: objectKey, op: 'get', dn: downloadName ?? null }, ttlSec);
    return `${config.API_BASE_URL}/v1/files/blob/${token}`;
  },
  async put(objectKey, body) {
    const p = safeLocalPath(objectKey);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, body);
  },
  async get(objectKey) {
    return readFile(safeLocalPath(objectKey));
  },
  async head(objectKey) {
    try {
      const s = await stat(safeLocalPath(objectKey));
      return { size: s.size };
    } catch {
      return null;
    }
  },
  async delete(objectKey) {
    await rm(safeLocalPath(objectKey), { force: true });
  },
};

export function verifyLocalBlobToken(token: string) {
  return verifySignedPayload<{ k: string; ct?: string; op: 'put' | 'get'; dn?: string | null }>(token);
}

// ---------------- S3 (SigV4 presign) ----------------
function hmac(key: Buffer | string, data: string) {
  return createHmac('sha256', key).update(data).digest();
}

function s3Presign(method: 'GET' | 'PUT' | 'HEAD' | 'DELETE', objectKey: string, ttlSec: number, extraQuery: Record<string, string> = {}) {
  const accessKey = process.env.AWS_ACCESS_KEY_ID;
  const secretKey = process.env.AWS_SECRET_ACCESS_KEY;
  const region = config.S3_REGION ?? 'ap-northeast-1';
  const bucket = config.S3_BUCKET;
  if (!accessKey || !secretKey || !bucket) throw new Error('S3 credentials are not configured');
  const endpoint = config.S3_ENDPOINT ?? `https://s3.${region}.amazonaws.com`;
  const url = new URL(`${endpoint.replace(/\/$/, '')}/${bucket}/${objectKey.split('/').map(encodeURIComponent).join('/')}`);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const query: Record<string, string> = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${accessKey}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(ttlSec),
    'X-Amz-SignedHeaders': 'host',
    ...extraQuery,
  };
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k]!)}`)
    .join('&');
  const canonicalRequest = [method, url.pathname, canonicalQuery, `host:${url.host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');
  const kDate = hmac(`AWS4${secretKey}`, dateStamp);
  const kSigning = hmac(hmac(hmac(kDate, region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  return `${url.origin}${url.pathname}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

export const s3Driver: StorageDriver = {
  async presignUpload(objectKey, contentType, ttlSec = 900) {
    return {
      url: s3Presign('PUT', objectKey, ttlSec),
      method: 'PUT',
      headers: { 'content-type': contentType },
      expiresAt: new Date(Date.now() + ttlSec * 1000).toISOString(),
    };
  },
  async presignDownload(objectKey, ttlSec = 900, downloadName) {
    const extra: Record<string, string> = downloadName
      ? { 'response-content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}` }
      : {};
    return s3Presign('GET', objectKey, ttlSec, extra);
  },
  async put(objectKey, body, contentType) {
    const res = await fetch(s3Presign('PUT', objectKey, 300), { method: 'PUT', body, headers: { 'content-type': contentType } });
    if (!res.ok) throw new Error(`S3 put failed: ${res.status}`);
  },
  async get(objectKey) {
    const res = await fetch(s3Presign('GET', objectKey, 300));
    if (!res.ok) throw new Error(`S3 get failed: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  },
  async head(objectKey) {
    const res = await fetch(s3Presign('HEAD', objectKey, 300), { method: 'HEAD' });
    if (!res.ok) return null;
    return { size: Number(res.headers.get('content-length') ?? 0) };
  },
  async delete(objectKey) {
    await fetch(s3Presign('DELETE', objectKey, 300), { method: 'DELETE' });
  },
};

export const storage: StorageDriver = config.STORAGE_DRIVER === 's3' ? s3Driver : localDriver;
