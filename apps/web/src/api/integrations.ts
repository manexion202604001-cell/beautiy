import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api, newIdempotencyKey } from '../lib/api';
import type { Page } from './types';

/** Integration Hub (external booking media) — /v1/integrations, /v1/sync-conflicts */

export type ConflictPolicy = 'manual' | 'external_wins' | 'internal_wins';
export type IntegrationStatus = 'active' | 'error' | 'degraded' | 'disabled' | string;

export interface IntegrationConfig {
  staffMap: Record<string, string>;
  menuMap: Record<string, string>;
  conflictPolicy: ConflictPolicy;
  pushBlocks: boolean;
}

export interface Integration {
  id: string;
  shop_id: string | null;
  provider: string;
  display_name: string;
  status: IntegrationStatus;
  config: IntegrationConfig;
  sync_cursor: string | null;
  last_synced_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
  consecutive_failures: number;
  created_at: string;
  updated_at: string;
  hasCredentials: boolean;
  webhookUrl: string;
}

export interface IntegrationInput {
  provider?: string;
  shopId?: string;
  displayName?: string;
  credentials?: Record<string, unknown>;
  config?: Partial<IntegrationConfig>;
  status?: 'active' | 'disabled';
}

export interface SyncJob {
  id: string;
  mode: 'delta' | 'full' | string;
  resource: string;
  state: 'queued' | 'running' | 'succeeded' | 'failed' | string;
  stats: Record<string, number> | null;
  error: string | null;
  retry_count: number;
  triggered_by: string;
  cursor_before: string | null;
  cursor_after: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

export interface SyncStatusAccount {
  integrationAccountId: string;
  provider: string;
  displayName: string;
  status: IntegrationStatus;
  degraded: boolean;
  pushBlocks: boolean;
  lastSuccessAt: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  consecutiveFailures: number;
  openConflicts: number;
  unsyncedBlocks: number;
  lastJob: {
    state: string;
    mode: string;
    triggeredBy: string;
    stats: Record<string, number> | null;
    error: string | null;
    finishedAt: string | null;
    createdAt: string;
  } | null;
}

export interface SyncStatus {
  shops: {
    shopId: string | null;
    shopName: string | null;
    degraded: boolean;
    openConflicts: number;
    lastSuccessAt: string | null;
    accounts: SyncStatusAccount[];
  }[];
  checkedAt: string;
}

export type ConflictType =
  | 'overlap'
  | 'duplicate'
  | 'unknown_staff'
  | 'unknown_menu'
  | 'unknown_customer'
  | 'stale_update'
  | 'push_failed';

export const CONFLICT_TYPE_LABEL: Record<ConflictType, string> = {
  overlap: '時間の重複',
  duplicate: '重複予約',
  unknown_staff: 'スタッフ未対応',
  unknown_menu: 'メニュー未対応',
  unknown_customer: '顧客不明',
  stale_update: '古い更新',
  push_failed: '枠反映の失敗',
};

export type Resolution = 'keep_internal' | 'accept_external' | 'ignore' | 'manual';
export const RESOLUTION_LABEL: Record<Resolution, string> = {
  keep_internal: '自社の予約を優先',
  accept_external: '外部の予約を反映',
  ignore: '無視して閉じる',
  manual: '手動で対応済み',
};

export interface SyncConflict {
  id: string;
  conflict_type: ConflictType;
  state: 'open' | 'resolved' | 'ignored';
  resolution: Resolution | null;
  details: Record<string, unknown> | null;
  appointment_id: string | null;
  external_booking_id: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
  external_id: string | null;
  external_status: string | null;
  external_sync_state: string | null;
  external_booking: {
    externalId?: string;
    status?: string;
    start?: string;
    end?: string;
    staffExternalId?: string | null;
    menuExternalIds?: string[];
    customer?: { name?: string | null; kana?: string | null; phone?: string | null };
    note?: string | null;
  } | null;
  integration_account_id: string | null;
  provider: string | null;
  integration_name: string | null;
  shop_id: string | null;
}

/** Providers the API registers adapters for (no listing endpoint — see README) */
export const PROVIDERS: { value: string; label: string; description: string }[] = [
  {
    value: 'mock_booking',
    label: '予約媒体（モック）',
    description: 'HotPepper 型の予約媒体シミュレーター。同期エンジンの動作確認用です。',
  },
];

export const integrationsApi = {
  list: () => api.get<Integration[]>('/integrations'),
  get: (id: string) => api.get<Integration>(`/integrations/${id}`),
  create: (input: IntegrationInput, idempotencyKey = newIdempotencyKey()) =>
    api.post<Integration>('/integrations', input, { idempotencyKey }),
  update: (id: string, input: IntegrationInput) => api.patch<Integration>(`/integrations/${id}`, input),
  disable: (id: string) => api.delete(`/integrations/${id}`),
  test: (id: string) =>
    api.post<{ ok: boolean; message?: string; latencyMs?: number; checkedAt: string }>(
      `/integrations/${id}/test`,
    ),
  resync: (id: string, mode: 'delta' | 'full') =>
    api.post<{ jobId: string | null; mode: string; queued: boolean }>(`/integrations/${id}/resync`, {
      mode,
    }),
  syncJobs: (id: string, cursor?: string) =>
    api.get<Page<SyncJob>>(`/integrations/${id}/sync-jobs`, { cursor, limit: 20 }),
  status: (shopId?: string) => api.get<SyncStatus>('/integrations/status', { shopId }),
  conflicts: (q: {
    state?: 'open' | 'resolved' | 'ignored';
    type?: ConflictType;
    integrationAccountId?: string;
    cursor?: string;
  }) => api.get<Page<SyncConflict>>('/sync-conflicts', { ...q, limit: 30 }),
  resolve: (
    id: string,
    input: { resolution: Resolution; note?: string; appointmentId?: string },
    idempotencyKey = newIdempotencyKey(),
  ) => api.post<SyncConflict>(`/sync-conflicts/${id}/resolve`, input, { idempotencyKey }),
};

export const integrationKeys = {
  all: ['integrations'] as const,
  list: ['integrations', 'list'] as const,
  status: ['integrations', 'status'] as const,
  jobs: (id: string) => ['integrations', 'jobs', id] as const,
  conflicts: (q: object) => ['integrations', 'conflicts', q] as const,
};

export function useIntegrations(enabled = true) {
  return useQuery({ queryKey: integrationKeys.list, queryFn: integrationsApi.list, enabled });
}

export function useSyncStatus(enabled = true) {
  return useQuery({
    queryKey: integrationKeys.status,
    queryFn: () => integrationsApi.status(),
    enabled,
    refetchInterval: 30_000,
  });
}

export function useConflicts(q: { state?: 'open' | 'resolved' | 'ignored'; type?: ConflictType }, enabled = true) {
  return useInfiniteQuery({
    queryKey: integrationKeys.conflicts(q),
    queryFn: ({ pageParam }) => integrationsApi.conflicts({ ...q, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled,
  });
}

export function useSyncJobs(id: string | null) {
  return useInfiniteQuery({
    queryKey: integrationKeys.jobs(id ?? ''),
    queryFn: ({ pageParam }) => integrationsApi.syncJobs(id!, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: !!id,
    refetchInterval: (query) =>
      query.state.data?.pages[0]?.items.some((j) => j.state === 'queued' || j.state === 'running')
        ? 3_000
        : false,
  });
}
