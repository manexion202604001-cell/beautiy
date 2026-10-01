import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api, newIdempotencyKey } from '../lib/api';
import type { Page } from './types';

export type ReviewStatus = 'pending' | 'published' | 'hidden';
export type ReviewSource = 'internal' | 'google' | 'external';

export interface Review {
  id: string;
  shop_id: string;
  customer_id: string | null;
  customer_name: string | null;
  staff_id: string | null;
  staff_name: string | null;
  appointment_id: string | null;
  review_request_id: string | null;
  source: ReviewSource;
  external_review_id: string | null;
  rating: number;
  staff_rating: number | null;
  title: string | null;
  body: string | null;
  reviewer_name: string | null;
  status: ReviewStatus;
  reply_body: string | null;
  replied_at: string | null;
  replied_by: string | null;
  reply_synced_at: string | null;
  reply_sync_error: string | null;
  posted_at: string;
  created_at: string;
}

export interface RatingSummary {
  count: number;
  average: number | null;
  distribution: Record<'1' | '2' | '3' | '4' | '5', number>;
}

export interface ReviewSummary extends RatingSummary {
  pendingCount: number;
  hiddenCount: number;
  unrepliedCount: number;
  staffRatingAverage: number | null;
}

export interface ReviewQuery {
  shopId?: string;
  staffId?: string;
  rating?: number;
  status?: ReviewStatus;
  source?: ReviewSource;
  replied?: 'true' | 'false';
  limit?: number;
}

export interface ReviewRequest {
  id: string;
  shop_id: string;
  customer_id: string;
  customer_name?: string;
  staff_name?: string | null;
  appointment_id: string | null;
  status: 'created' | 'sent' | 'opened' | 'submitted' | 'expired';
  opened_at: string | null;
  submitted_at: string | null;
  created_at: string;
  expires_at: string | null;
  url?: string;
}

export interface PublicReview {
  id: string;
  rating: number;
  title: string | null;
  body: string | null;
  nickname: string;
  source: ReviewSource;
  staff_id: string | null;
  staff_name: string | null;
  posted_at: string;
  reply_body: string | null;
  replied_at: string | null;
}

export interface PublicStaffProfile {
  id: string;
  displayName: string;
  title: string | null;
  publicSlug: string | null;
  nominationFee: number;
  bookable: boolean;
  profile: {
    bio?: string;
    specialties?: string[];
    yearsOfExperience?: number;
    instagram?: string;
    photoUrl?: string | null;
    [k: string]: unknown;
  };
  rating: RatingSummary;
  recentReviews: PublicReview[];
}

export interface PublicReviewRequest {
  shop: { name: string; slug: string };
  staff: { id: string; displayName: string; title: string | null; photoUrl: string | null } | null;
  visit: { date: string | null; menus: string[] };
}

export const reviewsApi = {
  list: (q: ReviewQuery & { cursor?: string }) => api.get<Page<Review>>('/reviews', { ...q }),
  summary: (q: { shopId?: string; staffId?: string }) =>
    api.get<ReviewSummary>('/reviews/summary', { ...q }),
  moderate: (id: string, status: ReviewStatus) => api.patch<Review>(`/reviews/${id}`, { status }),
  reply: (id: string, body: string, key = newIdempotencyKey()) =>
    api.post<Review>(`/reviews/${id}/reply`, { body }, { idempotencyKey: key }),
  googleImport: (integrationAccountId?: string) =>
    api.post<{ queued: number; accounts: number }>(
      '/reviews/google/import',
      integrationAccountId ? { integrationAccountId } : {},
    ),
  requests: (q: {
    shopId?: string;
    customerId?: string;
    status?: string;
    cursor?: string;
    limit?: number;
  }) => api.get<Page<ReviewRequest>>('/review-requests', { ...q }),
  createRequest: (
    input: {
      customerId: string;
      appointmentId?: string;
      shopId?: string;
      staffId?: string;
      send: boolean;
    },
    key = newIdempotencyKey(),
  ) =>
    api.post<ReviewRequest & { url: string }>('/review-requests', input, { idempotencyKey: key }),
  // public
  publicRequest: (token: string) =>
    api.get<PublicReviewRequest>(
      `/public/reviews/request/${encodeURIComponent(token)}`,
      undefined,
      { auth: 'none' },
    ),
  publicSubmit: (
    token: string,
    input: {
      rating: number;
      title?: string;
      body?: string;
      reviewerName?: string;
      staffRating?: number;
    },
  ) =>
    api.post<{ reviewId: string; status: string; message: string; googleReviewUrl: string | null }>(
      `/public/reviews/request/${encodeURIComponent(token)}`,
      input,
      { auth: 'none' },
    ),
  shopReviews: (slug: string, q: { staffId?: string; cursor?: string; limit?: number } = {}) =>
    api.get<{ summary?: RatingSummary; items: PublicReview[]; nextCursor: string | null }>(
      `/public/shops/${encodeURIComponent(slug)}/reviews`,
      { ...q },
      { auth: 'none' },
    ),
  staffProfile: (slug: string, staffId: string) =>
    api.get<PublicStaffProfile>(
      `/public/shops/${encodeURIComponent(slug)}/staff/${staffId}/profile`,
      undefined,
      {
        auth: 'none',
      },
    ),
};

export const reviewKeys = {
  all: ['reviews'] as const,
  list: (q: ReviewQuery) => ['reviews', 'list', q] as const,
  summary: (q: object) => ['reviews', 'summary', q] as const,
  requests: (q: object) => ['reviews', 'requests', q] as const,
};

export function useReviews(q: ReviewQuery) {
  return useInfiniteQuery({
    queryKey: reviewKeys.list(q),
    queryFn: ({ pageParam }) => reviewsApi.list({ ...q, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export function useReviewSummary(q: { shopId?: string; staffId?: string }) {
  return useQuery({ queryKey: reviewKeys.summary(q), queryFn: () => reviewsApi.summary(q) });
}

export const REVIEW_STATUS_LABEL: Record<ReviewStatus, string> = {
  pending: '承認待ち',
  published: '公開中',
  hidden: '非表示',
};

export const REVIEW_SOURCE_LABEL: Record<ReviewSource, string> = {
  internal: '自社',
  google: 'Google',
  external: '外部',
};

export const REQUEST_STATUS_LABEL: Record<ReviewRequest['status'], string> = {
  created: '発行済',
  sent: '送信済',
  opened: '開封済',
  submitted: '投稿済',
  expired: '期限切れ',
};
