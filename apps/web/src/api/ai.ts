import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import type { Page } from './types';

/** AI assist (/v1/ai/*). Every generated text is a proposal; nothing is ever sent automatically. */

export type ChurnLevel = 'low' | 'medium' | 'high';
export type DraftPurpose = 'followup' | 'dormant' | 'birthday' | 'review_thanks';
export type Tone = 'polite' | 'friendly' | 'casual';

export const PURPOSE_LABEL: Record<DraftPurpose, string> = {
  followup: '再来店のフォロー',
  dormant: '休眠顧客へのご案内',
  birthday: 'お誕生日メッセージ',
  review_thanks: '口コミのお礼',
};
export const TONE_LABEL: Record<Tone, string> = {
  polite: '丁寧',
  friendly: '親しみやすく',
  casual: 'カジュアル',
};
export const LEVEL_LABEL: Record<ChurnLevel, string> = { high: '高', medium: '中', low: '低' };

export interface AtRiskCustomer {
  customerId: string;
  customerName: string;
  primaryShopId: string | null;
  primaryStaffId: string | null;
  lastVisitAt: string | null;
  visitCount: number;
  marketingOptIn: boolean;
  churnRisk: number;
  level: ChurnLevel;
  predictedNextVisit: string | null;
  expectedLtv12m: number | null;
  recommendedAction: string | null;
  features: Record<string, unknown> | null;
  modelVersion: string;
  computedAt: string;
}

export interface ForecastDay {
  date: string;
  weekday: number;
  baseline: number;
  sigma: number;
  bookedAmount: number;
  bookedAppointments: number;
  forecast: number;
  lower: number;
  upper: number;
  sampleDays: number;
}

export interface Forecast {
  shopId: string;
  shopName: string;
  generatedAt: string;
  today: string;
  method: string;
  history: { from: string; to: string; weeks: number; daysWithData: number };
  days: ForecastDay[];
  total: { forecast: number; lower: number; upper: number; booked: number };
}

export interface Suggestion {
  id: string;
  kind: 'message_draft' | 'review_reply' | 'karte_summary' | 'sales_forecast' | 'next_action';
  subjectType: string | null;
  subjectId: string | null;
  status: 'proposed' | 'accepted' | 'rejected' | 'applied';
  provider: string;
  model: string | null;
  text: string | null;
  output: { text?: string; fallbackReason?: string; purpose?: string; tone?: string } | null;
  input: unknown;
  decidedBy: string | null;
  decidedAt: string | null;
  createdBy: string | null;
  createdAt: string;
}

export interface NextAction {
  type: 'churn_risk' | 'second_visit' | 'birthday';
  priority: number;
  customerId: string;
  customerName: string;
  reason: string;
  suggestedPurpose: DraftPurpose;
  score: number | null;
  lastVisitAt: string | null;
}

export interface NextActions {
  date: string;
  shopId: string | null;
  counts: { churnRisk: number; secondVisit: number; birthday: number };
  items: NextAction[];
  note: string;
}

export const aiApi = {
  atRisk: (q: { shopId?: string; level?: ChurnLevel; cursor?: string; limit?: number }) =>
    api.get<Page<AtRiskCustomer>>('/ai/at-risk-customers', { ...q }),
  forecast: (q: { shopId: string; days?: number }) => api.get<Forecast>('/ai/forecast', { ...q }),
  messageDraft: (input: { customerId: string; purpose: DraftPurpose; tone?: Tone }) =>
    api.post<Suggestion>('/ai/message-draft', input),
  karteSummary: (customerId: string) => api.post<Suggestion>('/ai/karte-summary', { customerId }),
  accept: (id: string, editedText?: string) =>
    api.post<{ suggestion: Suggestion; text: string | null; delivery: 'manual'; note: string | null }>(
      `/ai/suggestions/${id}/accept`,
      editedText ? { editedText } : {},
    ),
  reject: (id: string, reason?: string) =>
    api.post<{ suggestion: Suggestion }>(`/ai/suggestions/${id}/reject`, reason ? { reason } : {}),
  nextActions: (q: { shopId?: string; limit?: number }) =>
    api.get<NextActions>('/ai/next-actions', { ...q }),
  recompute: () => api.post<{ queued: boolean; jobId: string | null }>('/ai/scores/recompute'),
};

export function useAtRisk(q: { shopId?: string; level?: ChurnLevel }, enabled = true) {
  return useInfiniteQuery({
    queryKey: ['ai', 'at-risk', q],
    queryFn: ({ pageParam }) => aiApi.atRisk({ ...q, cursor: pageParam, limit: 30 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled,
  });
}

export function useForecast(shopId: string | null | undefined, days: number, enabled = true) {
  return useQuery({
    queryKey: ['ai', 'forecast', shopId, days],
    queryFn: () => aiApi.forecast({ shopId: shopId!, days }),
    enabled: enabled && !!shopId,
    staleTime: 5 * 60_000,
  });
}

export function useNextActions(shopId: string | null | undefined, limit = 20, enabled = true) {
  return useQuery({
    queryKey: ['ai', 'next-actions', shopId, limit],
    queryFn: () => aiApi.nextActions({ shopId: shopId ?? undefined, limit }),
    enabled,
    staleTime: 5 * 60_000,
  });
}
