import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api, newIdempotencyKey } from '../lib/api';
import type { Page } from './types';

export type FieldType =
  'text' | 'textarea' | 'number' | 'select' | 'multiselect' | 'checkbox' | 'date' | 'color_formula';

export const ATTRIBUTE_KEYS = [
  'allergies',
  'hair_concerns',
  'scalp_condition',
  'skin_type',
  'medical_notes',
  'preferred_style',
  'pregnancy',
  'medications',
] as const;
export type AttributeKey = (typeof ATTRIBUTE_KEYS)[number];

export const ATTRIBUTE_LABEL: Record<AttributeKey, string> = {
  allergies: 'アレルギー',
  hair_concerns: '髪のお悩み',
  scalp_condition: '頭皮の状態',
  skin_type: '肌質',
  medical_notes: '既往歴・医療メモ',
  preferred_style: '好みのスタイル',
  pregnancy: '妊娠・授乳',
  medications: '服薬',
};

/** Dynamic field definition shared by karte templates and form templates */
export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  options?: string[];
  required?: boolean;
  helpText?: string;
  min?: number;
  max?: number;
  maxLength?: number;
  /** karte templates: shown on the customer share page */
  customerVisible?: boolean;
  /** form templates: copied into customers.attributes on submission */
  mapsTo?: AttributeKey;
}

export type FieldValue = string | number | boolean | string[] | null;
export type FieldValues = Record<string, FieldValue>;

export interface KarteTemplate {
  id: string;
  shop_id: string | null;
  name: string;
  category: string | null;
  fields: FieldDef[];
  is_default: boolean;
  status: 'active' | 'inactive';
}

export interface Chemical {
  name: string;
  brand?: string | null;
  ratio?: string | null;
  processingMin?: number | null;
  note?: string | null;
}

export type AssetType = 'photo_before' | 'photo_after' | 'photo' | 'sketch' | 'document';

export interface KarteAsset {
  id: string;
  karte_id: string;
  file_id: string;
  asset_type: AssetType;
  caption: string | null;
  share_with_customer: boolean;
  sort_order: number;
  created_at: string;
  content_type: string;
  file_name: string | null;
  url: string;
  url_expires_at: string;
}

export interface KarteListItem {
  id: string;
  shop_id: string;
  customer_id: string;
  appointment_id: string | null;
  staff_id: string;
  staff_name: string | null;
  template_id: string | null;
  template_name: string | null;
  visit_date: string;
  fields: FieldValues;
  note: string | null;
  shared_with_customer: boolean;
  shared_at: string | null;
  asset_count: number;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface KarteDetail {
  id: string;
  shop_id: string;
  customer_id: string;
  appointment_id: string | null;
  staff_id: string;
  staff_name: string | null;
  template_id: string | null;
  template: {
    id: string;
    name: string;
    category: string | null;
    fields: FieldDef[];
    status: string;
  } | null;
  visit_date: string;
  fields: FieldValues;
  /** stored with snake_case keys (processing_min) */
  chemicals: {
    name: string;
    brand: string | null;
    ratio: string | null;
    processing_min: number | null;
    note: string | null;
  }[];
  homecare: { advice: string | null; product_ids: string[] };
  homecare_products: {
    id: string;
    name: string;
    brand: string | null;
    price: number;
    price_tax_included: boolean;
  }[];
  note: string | null;
  shared_with_customer: boolean;
  shared_at: string | null;
  assets: KarteAsset[];
  version: number;
  created_at: string;
  updated_at: string;
  duplicated_from?: string;
}

export interface KarteInput {
  customerId?: string;
  shopId?: string;
  appointmentId?: string | null;
  staffId?: string | null;
  templateId?: string | null;
  visitDate?: string;
  fields?: FieldValues;
  chemicals?: Chemical[];
  note?: string | null;
  homecare?: { advice?: string | null; productIds?: string[] };
}

/** Customer-safe karte (share page / my page) */
export interface SharedKarte {
  id: string;
  visitDate: string;
  sharedAt: string | null;
  shop: { id: string; name: string };
  staff: { displayName: string | null };
  title: string | null;
  fields: { key: string; label: string; value: FieldValue; display: string }[];
  assets: {
    id: string;
    assetType: AssetType;
    caption: string | null;
    contentType: string;
    url: string;
    urlExpiresAt: string;
  }[];
  homecare: {
    advice: string | null;
    products: {
      id: string;
      name: string;
      brand: string | null;
      price: number;
      priceTaxIncluded: boolean;
    }[];
  };
}

export interface KarteQuery {
  customerId?: string;
  shopId?: string;
  staffId?: string;
  appointmentId?: string;
  from?: string;
  to?: string;
  limit?: number;
}

export const kartesApi = {
  templates: (shopId?: string, includeInactive = false) =>
    api.get<KarteTemplate[]>('/karte-templates', {
      shopId,
      includeInactive: includeInactive ? 'true' : undefined,
    }),
  list: (q: KarteQuery & { cursor?: string }) => api.get<Page<KarteListItem>>('/kartes', { ...q }),
  get: (id: string) => api.get<KarteDetail>(`/kartes/${id}`),
  create: (input: KarteInput, key = newIdempotencyKey()) =>
    api.post<KarteDetail>('/kartes', input, { idempotencyKey: key }),
  update: (id: string, input: KarteInput & { version: number }) =>
    api.patch<KarteDetail>(`/kartes/${id}`, input),
  remove: (id: string) => api.delete(`/kartes/${id}`),
  duplicate: (
    id: string,
    input: {
      shopId?: string;
      appointmentId?: string | null;
      staffId?: string | null;
      visitDate?: string;
      includeNote?: boolean;
    } = {},
  ) => api.post<KarteDetail>(`/kartes/${id}/duplicate`, input),
  latest: (customerId: string, q: { templateId?: string; shopId?: string } = {}) =>
    api.get<{ karte: KarteDetail | null }>(`/customers/${customerId}/kartes/latest`, { ...q }),
  addAsset: (
    id: string,
    input: {
      fileId: string;
      assetType: AssetType;
      caption?: string | null;
      shareWithCustomer?: boolean;
    },
  ) => api.post<KarteAsset>(`/kartes/${id}/assets`, input),
  updateAsset: (
    id: string,
    assetId: string,
    input: {
      caption?: string | null;
      shareWithCustomer?: boolean;
      assetType?: AssetType;
      sortOrder?: number;
    },
  ) => api.patch<KarteAsset>(`/kartes/${id}/assets/${assetId}`, input),
  removeAsset: (id: string, assetId: string) => api.delete(`/kartes/${id}/assets/${assetId}`),
  share: (
    id: string,
    input: { expiresInDays: number; notify: boolean; channel?: 'line' | 'email' | 'sms' },
  ) =>
    api.post<{ url: string; expiresAt: string; sharedAt: string; messageId: string | null }>(
      `/kartes/${id}/share`,
      input,
    ),
  unshare: (id: string) => api.delete(`/kartes/${id}/share`),
  publicShare: (token: string) =>
    api.get<SharedKarte>(`/public/karte-shares/${encodeURIComponent(token)}`, undefined, {
      auth: 'none',
    }),
  myKartes: (token: string) =>
    api.get<SharedKarte[]>('/public/me/kartes', undefined, { auth: 'customer', token }),
};

export const karteKeys = {
  all: ['kartes'] as const,
  templates: (shopId?: string) => ['kartes', 'templates', shopId ?? null] as const,
  list: (q: KarteQuery) => ['kartes', 'list', q] as const,
  detail: (id: string) => ['kartes', 'detail', id] as const,
};

export function useKarteTemplates(shopId?: string | null) {
  return useQuery({
    queryKey: karteKeys.templates(shopId ?? undefined),
    queryFn: () => kartesApi.templates(shopId ?? undefined),
    staleTime: 5 * 60_000,
  });
}

export function useKartes(q: KarteQuery, enabled = true) {
  return useInfiniteQuery({
    queryKey: karteKeys.list(q),
    queryFn: ({ pageParam }) => kartesApi.list({ ...q, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled,
  });
}

export function useKarte(id: string | null | undefined) {
  return useQuery({
    queryKey: karteKeys.detail(id ?? ''),
    queryFn: () => kartesApi.get(id!),
    enabled: !!id,
  });
}

export const ASSET_TYPE_LABEL: Record<AssetType, string> = {
  photo_before: 'ビフォー',
  photo_after: 'アフター',
  photo: '写真',
  sketch: 'スケッチ',
  document: '書類',
};

export const FIELD_TYPE_LABEL: Record<FieldType, string> = {
  text: '1行テキスト',
  textarea: '複数行テキスト',
  number: '数値',
  select: '選択（1つ）',
  multiselect: '選択（複数）',
  checkbox: 'チェック',
  date: '日付',
  color_formula: 'カラー配合',
};

/** DB chemicals (snake_case) → API input (camelCase) */
export function chemicalsToInput(list: KarteDetail['chemicals']): Chemical[] {
  return (list ?? []).map((c) => ({
    name: c.name,
    brand: c.brand ?? null,
    ratio: c.ratio ?? null,
    processingMin: c.processing_min ?? null,
    note: c.note ?? null,
  }));
}

/** Human readable value for lists */
export function displayFieldValue(v: FieldValue | undefined): string {
  if (v === null || v === undefined || v === '') return '—';
  if (Array.isArray(v)) return v.length ? v.join('、') : '—';
  if (typeof v === 'boolean') return v ? 'はい' : 'いいえ';
  return String(v);
}
