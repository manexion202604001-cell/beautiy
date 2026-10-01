import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api, newIdempotencyKey } from '../lib/api';
import type { Page } from './types';

/** Referral / tracking links and SNS share material (/v1/referral-links, /v1/sns-assets) */

export type ReferralTarget = 'booking' | 'product' | 'profile' | 'review';
export const TARGET_LABEL: Record<ReferralTarget, string> = {
  booking: '予約ページ',
  product: '商品ページ',
  profile: 'スタッフプロフィール',
  review: '口コミ',
};

export interface Utm {
  source?: string;
  medium?: string;
  campaign?: string;
}

export interface ReferralLink {
  id: string;
  code: string;
  name: string;
  shop_id: string | null;
  staff_id: string | null;
  customer_id: string | null;
  target: ReferralTarget;
  target_id: string | null;
  utm: Utm;
  is_active: boolean;
  click_count: number;
  created_at: string;
  url: string;
  booking_count?: number;
  purchase_count?: number;
}

export interface ReferralLinkInput {
  name?: string;
  shopId?: string | null;
  staffId?: string | null;
  customerId?: string | null;
  target?: ReferralTarget;
  targetId?: string | null;
  utm?: Utm;
  isActive?: boolean;
}

export interface ReferralStats {
  linkId: string;
  code: string;
  from: string | null;
  to: string | null;
  clicks: number;
  bookings: number;
  signups: number;
  completedVisits: number;
  visitRevenue: number;
  purchases: number;
  purchaseRevenue: number;
  revenue: number;
  conversionRate: number | null;
}

export type SnsTemplate = 'square_style' | 'before_after' | 'review_quote';
export const SNS_TEMPLATE_LABEL: Record<SnsTemplate, string> = {
  square_style: 'スタイル写真（正方形）',
  before_after: 'ビフォー・アフター',
  review_quote: '口コミ引用',
};

export interface SnsAsset {
  id: string;
  shop_id: string | null;
  staff_id: string | null;
  karte_asset_id: string | null;
  review_id: string | null;
  template: SnsTemplate;
  caption: string;
  hashtags: string[];
  file_id: string | null;
  content: { width: number; height: number; format: string; photoCount: number } | null;
  customer_consent: boolean;
  created_by: string | null;
  created_at: string;
  size_bytes?: number | null;
  downloadUrl?: string | null;
}

export interface SnsAssetInput {
  template: SnsTemplate;
  caption?: string;
  hashtags?: string[];
  karteAssetId?: string;
  reviewId?: string;
  customerConsent?: boolean;
  shopId?: string;
  staffId?: string;
}

/** Minimal shapes of other modules' lists used by the SNS picker (kartes/reviews screens are owned elsewhere) */
export interface KarteListItem {
  id: string;
  customer_id: string;
  visit_date: string;
  staff_name?: string | null;
}
export interface KarteAsset {
  id: string;
  karte_id: string;
  asset_type: string;
  caption: string | null;
  url: string;
}
export interface ReviewListItem {
  id: string;
  rating: number;
  title: string | null;
  body: string | null;
  reviewer_name: string | null;
  status: string;
  posted_at: string;
}

export const marketingApi = {
  links: (q: { shopId?: string; staffId?: string; active?: boolean; cursor?: string }) =>
    api.get<Page<ReferralLink>>('/referral-links', { ...q, limit: 50 }),
  createLink: (input: ReferralLinkInput, idempotencyKey = newIdempotencyKey()) =>
    api.post<ReferralLink>('/referral-links', input, { idempotencyKey }),
  updateLink: (id: string, input: ReferralLinkInput) =>
    api.patch<ReferralLink>(`/referral-links/${id}`, input),
  deleteLink: (id: string) => api.delete(`/referral-links/${id}`),
  stats: (id: string, q: { from?: string; to?: string } = {}) =>
    api.get<ReferralStats>(`/referral-links/${id}/stats`, q),
  customerLink: (customerId: string) =>
    api.post<ReferralLink>(`/customers/${customerId}/referral-link`),

  snsAssets: (q: { template?: SnsTemplate; cursor?: string }) =>
    api.get<Page<SnsAsset>>('/sns-assets', { ...q, limit: 30 }),
  snsAsset: (id: string) => api.get<SnsAsset>(`/sns-assets/${id}`),
  createSnsAsset: (input: SnsAssetInput, idempotencyKey = newIdempotencyKey()) =>
    api.post<SnsAsset>('/sns-assets', input, { idempotencyKey }),
  deleteSnsAsset: (id: string) => api.delete(`/sns-assets/${id}`),

  kartes: (customerId: string) =>
    api.get<Page<KarteListItem>>('/kartes', { customerId, limit: 20 }),
  karteAssets: (karteId: string) => api.get<KarteAsset[]>(`/kartes/${karteId}/assets`),
  publishedReviews: () =>
    api.get<Page<ReviewListItem>>('/reviews', { status: 'published', limit: 50 }),
};

export function useReferralLinks(q: { active?: boolean }, enabled = true) {
  return useInfiniteQuery({
    queryKey: ['marketing', 'links', q],
    queryFn: ({ pageParam }) => marketingApi.links({ ...q, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled,
  });
}

export function useReferralStats(id: string | null) {
  return useQuery({
    queryKey: ['marketing', 'stats', id],
    queryFn: () => marketingApi.stats(id!),
    enabled: !!id,
  });
}

export function useSnsAssets(q: { template?: SnsTemplate }, enabled = true) {
  return useInfiniteQuery({
    queryKey: ['marketing', 'sns', q],
    queryFn: ({ pageParam }) => marketingApi.snsAssets({ ...q, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled,
  });
}
