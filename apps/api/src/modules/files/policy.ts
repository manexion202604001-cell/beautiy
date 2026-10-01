import type { Permission } from '../../auth/permissions.js';

/**
 * File purposes, allowed content types and size limits (要件 21: object storage, DB keeps metadata only).
 */
export const FILE_PURPOSES = ['karte_photo', 'sketch', 'signature', 'product_image', 'staff_photo', 'document', 'sns_asset', 'export'] as const;
export type FilePurpose = (typeof FILE_PURPOSES)[number];

const MB = 1024 * 1024;

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'] as const;

/** content type → file extension used in object keys */
export const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'application/pdf': 'pdf',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'text/csv': 'csv',
  'application/zip': 'zip',
};

export interface PurposePolicy {
  contentTypes: readonly string[];
  maxBytes: number;
  /** any of these permissions allows uploading (presign/complete/delete) */
  writePermissions: Permission[];
  /** label for messages */
  label: string;
}

export const PURPOSE_POLICIES: Record<FilePurpose, PurposePolicy> = {
  karte_photo: { contentTypes: IMAGE_TYPES, maxBytes: 15 * MB, writePermissions: ['karte.write'], label: '施術写真' },
  sketch: { contentTypes: ['image/png', 'image/jpeg', 'image/webp'], maxBytes: 10 * MB, writePermissions: ['karte.write'], label: 'スケッチ' },
  signature: { contentTypes: ['image/png'], maxBytes: 1 * MB, writePermissions: ['karte.write', 'form.manage'], label: '署名' },
  product_image: { contentTypes: IMAGE_TYPES, maxBytes: 10 * MB, writePermissions: ['product.manage'], label: '商品画像' },
  staff_photo: { contentTypes: IMAGE_TYPES, maxBytes: 10 * MB, writePermissions: ['staff.manage'], label: 'スタッフ写真' },
  document: { contentTypes: ['application/pdf', ...IMAGE_TYPES], maxBytes: 20 * MB, writePermissions: ['karte.write', 'form.manage'], label: '書類' },
  sns_asset: { contentTypes: [...IMAGE_TYPES, 'video/mp4', 'video/quicktime'], maxBytes: 100 * MB, writePermissions: ['marketing.manage'], label: 'SNS素材' },
  export: { contentTypes: ['text/csv', 'application/zip', 'application/pdf'], maxBytes: 200 * MB, writePermissions: ['export.data'], label: 'エクスポート' },
};

/** Largest accepted upload (body limit of the local blob PUT route) */
export const MAX_UPLOAD_BYTES = Math.max(...Object.values(PURPOSE_POLICIES).map((p) => p.maxBytes));

/** Purposes whose content is customer personal data: downloads are audited */
export const SENSITIVE_PURPOSES: ReadonlySet<string> = new Set(['karte_photo', 'sketch', 'signature', 'document', 'export']);

/** Strip parameters (charset etc.) and lowercase */
export function baseContentType(ct: string | undefined | null): string {
  return (ct ?? '').split(';')[0]!.trim().toLowerCase();
}

/**
 * Magic-byte sniffing: returns false when the bytes clearly do not match the declared type.
 * Types without a reliable signature (csv) always pass.
 */
export function matchesSignature(contentType: string, buf: Buffer): boolean {
  const ct = baseContentType(contentType);
  const startsWith = (bytes: number[], offset = 0) => bytes.every((b, i) => buf[offset + i] === b);
  switch (ct) {
    case 'image/jpeg':
      return startsWith([0xff, 0xd8, 0xff]);
    case 'image/png':
      return startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'image/webp':
      return buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP';
    case 'image/heic':
    case 'image/heif':
    case 'video/mp4':
    case 'video/quicktime':
      return buf.subarray(4, 8).toString('latin1') === 'ftyp';
    case 'application/pdf':
      return buf.subarray(0, 5).toString('latin1') === '%PDF-';
    case 'application/zip':
      return startsWith([0x50, 0x4b]);
    default:
      return true;
  }
}

/** Sanitize a user supplied file name for storage / Content-Disposition */
export function sanitizeFileName(name: string | null | undefined): string | null {
  if (!name) return null;
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\u0000-\u001f\u007f"\\/<>:|?*]/g, '_').trim().slice(0, 200);
  return cleaned || null;
}
