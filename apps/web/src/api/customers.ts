import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api, downloadFile, newIdempotencyKey } from '../lib/api';
import type {
  CustomerDetail,
  CustomerInput,
  CustomerListItem,
  CustomerVisit,
  DuplicateCandidate,
  DuplicatePair,
  LegacyVisit,
  Memo,
  MergeLog,
  Page,
  Tag,
  TimelineEntry,
} from './types';

export interface CustomerSearch {
  q?: string;
  tagId?: string;
  shopId?: string;
  staffId?: string;
  lastVisitBefore?: string;
  lastVisitAfter?: string;
  hasFutureAppointment?: boolean;
  birthdayMonth?: number;
  sort?: 'last_visit' | 'created' | 'name' | 'total_sales';
  limit?: number;
}

export const customersApi = {
  search: (q: CustomerSearch & { cursor?: string }) =>
    api.get<Page<CustomerListItem>>('/customers', { ...q }),
  get: (id: string) => api.get<CustomerDetail>(`/customers/${id}`),
  create: (input: CustomerInput, idempotencyKey = newIdempotencyKey()) =>
    api.post<{ customer: CustomerDetail; duplicateCandidates: DuplicateCandidate[] }>(
      '/customers',
      input,
      { idempotencyKey },
    ),
  update: (id: string, input: CustomerInput) =>
    api.patch<CustomerDetail>(`/customers/${id}`, input),
  remove: (id: string) => api.delete(`/customers/${id}`),
  exportCsv: (q: CustomerSearch) =>
    downloadFile('/customers/export.csv', { ...q, limit: undefined }, 'customers.csv'),
  duplicatesFor: (id: string) => api.get<DuplicateCandidate[]>(`/customers/${id}/duplicates`),
  duplicatePairs: (limit = 100) => api.get<DuplicatePair[]>('/customers/duplicates', { limit }),
  dismissDuplicate: (a: string, b: string) =>
    api.post<void>('/customers/duplicates/dismiss', { customerIdA: a, customerIdB: b }),
  merge: (
    targetId: string,
    sourceCustomerId: string,
    reason?: string,
    idempotencyKey = newIdempotencyKey(),
  ) =>
    api.post<{
      mergeLogId: string;
      targetId: string;
      sourceId: string;
      moved: Record<string, number>;
    }>(
      `/customers/${targetId}/merge`,
      { sourceCustomerId, ...(reason ? { reason } : {}) },
      { idempotencyKey },
    ),
  mergeLogs: (id: string) => api.get<MergeLog[]>(`/customers/${id}/merge-logs`),
  undoMerge: (logId: string) =>
    api.post<{ mergeLogId: string; sourceId: string; targetId: string }>(
      `/customer-merges/${logId}/undo`,
    ),
  visits: (id: string) => api.get<CustomerVisit[]>(`/customers/${id}/visits`),
  legacyVisits: (id: string) => api.get<LegacyVisit[]>(`/customers/${id}/legacy-visits`),
  timeline: (id: string) => api.get<TimelineEntry[]>(`/customers/${id}/timeline`),
  setTags: (id: string, tagIds: string[]) => api.put<Tag[]>(`/customers/${id}/tags`, { tagIds }),
  memos: (id: string) => api.get<Memo[]>(`/customers/${id}/memos`),
  createMemo: (
    id: string,
    input: { body: string; visibility: 'shared' | 'private'; pinned?: boolean },
  ) => api.post<Memo>(`/customers/${id}/memos`, input),
  updateMemo: (
    memoId: string,
    input: { body?: string; visibility?: 'shared' | 'private'; pinned?: boolean },
  ) => api.patch<Memo>(`/customer-memos/${memoId}`, input),
  deleteMemo: (memoId: string) => api.delete(`/customer-memos/${memoId}`),
  tags: () => api.get<Tag[]>('/tags'),
  createTag: (input: { name: string; color?: string }) => api.post<Tag>('/tags', input),
  updateTag: (id: string, input: { name?: string; color?: string }) =>
    api.patch<Tag>(`/tags/${id}`, input),
  deleteTag: (id: string) => api.delete(`/tags/${id}`),
};

export const customerKeys = {
  all: ['customers'] as const,
  search: (q: CustomerSearch) => ['customers', 'search', q] as const,
  detail: (id: string) => ['customers', 'detail', id] as const,
  visits: (id: string) => ['customers', 'visits', id] as const,
  legacyVisits: (id: string) => ['customers', 'legacy-visits', id] as const,
  timeline: (id: string) => ['customers', 'timeline', id] as const,
  memos: (id: string) => ['customers', 'memos', id] as const,
  duplicates: (id: string) => ['customers', 'duplicates', id] as const,
  mergeLogs: (id: string) => ['customers', 'merge-logs', id] as const,
  pairs: ['customers', 'pairs'] as const,
  tags: ['tags'] as const,
};

export function useCustomerSearch(q: CustomerSearch, enabled = true) {
  return useInfiniteQuery({
    queryKey: customerKeys.search(q),
    queryFn: ({ pageParam }) => customersApi.search({ ...q, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled,
  });
}

export function useCustomer(id: string | null | undefined) {
  return useQuery({
    queryKey: customerKeys.detail(id ?? ''),
    queryFn: () => customersApi.get(id!),
    enabled: !!id,
  });
}

export function useTags() {
  return useQuery({ queryKey: customerKeys.tags, queryFn: customersApi.tags, staleTime: 60_000 });
}
