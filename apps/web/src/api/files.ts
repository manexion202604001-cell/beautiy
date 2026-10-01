import { API_BASE_URL, ApiError, api, request } from '../lib/api';

export type FilePurpose =
  | 'karte_photo'
  | 'sketch'
  | 'signature'
  | 'product_image'
  | 'staff_photo'
  | 'document'
  | 'sns_asset'
  | 'export';

export interface FileInfo {
  id: string;
  purpose: FilePurpose;
  contentType: string;
  sizeBytes: number | null;
  fileName: string | null;
  status: 'pending' | 'uploaded' | 'deleted';
  uploadedBy: string | null;
  createdAt: string;
  uploadedAt: string | null;
}

export interface PresignResult {
  fileId: string;
  file: FileInfo;
  upload: { url: string; method: 'PUT'; headers: Record<string, string>; expiresAt: string };
}

/** Accepted content types per purpose (mirrors apps/api files/policy.ts) */
export const IMAGE_ACCEPT = 'image/jpeg,image/png,image/webp,image/heic,image/heif';
const MB = 1024 * 1024;
export const MAX_BYTES: Partial<Record<FilePurpose, number>> = {
  karte_photo: 15 * MB,
  sketch: 10 * MB,
  product_image: 10 * MB,
  signature: 1 * MB,
  document: 20 * MB,
};

export const filesApi = {
  presign: (input: {
    purpose: FilePurpose;
    contentType: string;
    sizeBytes: number;
    fileName?: string | null;
  }) => api.post<PresignResult>('/files/presign', input),
  complete: (id: string, checksumSha256?: string) =>
    api.post<FileInfo>(`/files/${id}/complete`, checksumSha256 ? { checksumSha256 } : {}),
  get: (id: string) => api.get<FileInfo>(`/files/${id}`),
  url: (id: string, download = false) =>
    api.get<{ url: string; expiresAt: string; contentType: string; fileName: string | null }>(
      `/files/${id}/url`,
      download ? { download: true } : undefined,
    ),
  remove: (id: string) => api.delete(`/files/${id}`),
};

/**
 * The local storage driver signs absolute URLs with the API's public base URL. When the web app
 * talks to the API through a same-origin proxy (`/v1`), keep only the path so uploads and previews
 * go through that proxy (works with any API_BASE_URL setting). S3 URLs are left untouched.
 */
export function sameOriginBlobUrl(url: string): string {
  try {
    const u = new URL(url, window.location.origin);
    if (u.pathname.startsWith('/v1/files/blob/') && API_BASE_URL.startsWith('/')) {
      return `${API_BASE_URL}${u.pathname.slice(3)}${u.search}`;
    }
    return u.toString();
  } catch {
    return url;
  }
}

async function sha256Hex(blob: Blob): Promise<string | undefined> {
  try {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) return undefined;
    const digest = await subtle.digest('SHA-256', await blob.arrayBuffer());
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return undefined;
  }
}

/**
 * Upload a file: presign (purpose/type/size validated by the API) → PUT to the signed URL →
 * complete (size, magic bytes and checksum verified). Returns the uploaded file metadata.
 */
export async function uploadFile(
  file: Blob & { name?: string },
  purpose: FilePurpose,
  opts: { fileName?: string } = {},
): Promise<FileInfo> {
  const contentType = file.type || 'application/octet-stream';
  const max = MAX_BYTES[purpose];
  if (max && file.size > max) {
    throw new ApiError({
      status: 413,
      code: 'FILE_TOO_LARGE',
      category: 'validation',
      message: `ファイルサイズが上限(${Math.round(max / MB)}MB)を超えています`,
    });
  }
  const presigned = await filesApi.presign({
    purpose,
    contentType,
    sizeBytes: file.size,
    fileName: opts.fileName ?? file.name ?? null,
  });
  let res: Response;
  try {
    res = await fetch(sameOriginBlobUrl(presigned.upload.url), {
      method: 'PUT',
      headers: { 'content-type': contentType, ...presigned.upload.headers },
      body: file,
    });
  } catch {
    throw new ApiError({
      status: 0,
      code: 'NETWORK_ERROR',
      category: 'network',
      message: 'アップロード中に通信エラーが発生しました',
    });
  }
  if (!res.ok) {
    let message = `アップロードに失敗しました (${res.status})`;
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      if (body.error?.message) message = body.error.message;
    } catch {
      /* non-JSON (S3) */
    }
    throw new ApiError({
      status: res.status,
      code: 'UPLOAD_FAILED',
      category: 'validation',
      message,
    });
  }
  return filesApi.complete(presigned.fileId, await sha256Hex(file));
}

/**
 * Open printable HTML from an authenticated endpoint (e.g. /receipts/:id/html) in a new tab via a
 * blob URL. The tab is opened synchronously (inside the click) so popup blockers allow it.
 */
export async function openAuthenticatedHtml(path: string, title = '印刷用ページ'): Promise<void> {
  const win = window.open('', '_blank');
  if (win) {
    try {
      win.document.title = title;
      win.document.body.textContent = '読み込み中…';
    } catch {
      /* cross-origin / closed */
    }
  }
  try {
    const res = await request<Response>(path, { raw: true, headers: { accept: 'text/html' } });
    const html = await res.text();
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
    if (win && !win.closed) win.location.href = url;
    else {
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (e) {
    win?.close();
    throw e;
  }
}

/** Read a File as an image preview URL (object URL; revoke when done) */
export function previewUrl(file: Blob): string {
  return URL.createObjectURL(file);
}
