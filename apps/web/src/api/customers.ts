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
  /** customers with no staff in charge */
  unassigned?: boolean;
  lastVisitBefore?: string;
  lastVisitAfter?: string;
  hasFutureAppointment?: boolean;
  birthdayMonth?: number;
  sort?: 'last_visit' | 'created' | 'name' | 'total_sales';
  limit?: number;
}

/** 名前重複: records sharing one normalized full name (the first is the one recommended to keep) */
export interface NameDuplicateCustomer {
  id: string;
  name: string;
  name_kana: string | null;
  phone: string | null;
  store_name: string | null;
  staff_name: string | null;
  visit_count: number;
  member_no: string | null;
}
export interface NameDuplicateGroup {
  normalized_name: string;
  customers: NameDuplicateCustomer[];
}

export interface AssignedStaff {
  staff_id: string;
  staff_name: string;
  is_primary: boolean;
  visit_count: number;
}
export interface LinkedCustomer {
  id: string;
  store_name: string | null;
  staff_name: string | null;
  visit_count: number;
  last_visit_at: string | null;
  last_reservation_at: string | null;
}
/** What the customer screen shows beside the profile */
export interface CustomerOverview {
  name_source: 'line' | null;
  member_no: string | null;
  line: { display_name: string | null; picture_url: string | null } | null;
  assigned_staff: AssignedStaff[];
  linked_customers: LinkedCustomer[];
}

export const customersApi = {
  search: (q: CustomerSearch & { cursor?: string }) =>
    api.get<Page<CustomerListItem> & { total: number }>('/customers', { ...q }),
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
  nameDuplicates: (q: { search?: string; limit?: number; offset?: number } = {}) =>
    api.get<{ groups: NameDuplicateGroup[]; total: number }>('/customers/name-duplicates', { ...q }),
  dismissNameDuplicate: (normalizedName: string) =>
    api.post<{ dismissed: number }>('/customers/name-duplicates/dismiss', { normalizedName }),
  linkMaster: (customerIds: string[]) =>
    api.post<{ member_no: string; customerIds: string[] }>('/customers/link-master', {
      customerIds,
    }),
  overview: (id: string) => api.get<CustomerOverview>(`/customers/${id}/overview`),
  mergeLogs: (id: string) => api.get<MergeLog[]>(`/customers/${id}/merge-logs`),
  undoMerge: (logId: string) =>
    api.post<{ mergeLogId: string; sourceId: string; targetId: string }>(
      `/customer-merges/${logId}/undo`,
    ),
  visits: (id: string, limit?: number) =>
    api.get<CustomerVisit[]>(`/customers/${id}/visits`, limit ? { limit } : undefined),
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
  overview: (id: string) => ['customers', 'overview', id] as const,
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
