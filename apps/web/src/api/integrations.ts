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
  mail?: MailConfig;
}

/** e-mail connectors (Hot Pepper / LiME booking-notification mails) */
export interface MailConfig {
  inboundToken?: string;
  labels?: Partial<Record<string, string[]>>;
  subjectIncludes?: string[];
  defaultMenuId?: string;
  autoMatchNames?: boolean;
  notifyEmails?: string[];
  mailgunSigningKey?: string;
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
  /** 'manual' = the medium has no write API; slot blocks become staff tasks */
  pushMode: 'api' | 'manual';
  inboundEmail: { webhookUrl: string } | null;
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
  manualActionRequired?: number;
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

/** null = could not be matched */
export type MatchVia = 'map' | 'auto' | 'default' | null;
export const MATCH_VIA_LABEL: Record<NonNullable<MatchVia> | 'none', string> = {
  map: '対応表',
  auto: '名前で自動判定',
  default: '既定メニュー',
  none: '未対応',
};

export interface MailParseResult {
  kind: 'booked' | 'changed' | 'cancelled' | 'unknown';
  externalId: string;
  start: string | null;
  end: string | null;
  durationMin: number | null;
  customer: { name: string | null; kana: string | null; phone: string | null; email: string | null };
  staff: { name: string | null; staffId: string | null; staffName: string | null; via: MatchVia };
  menus: { name: string; menuId: string | null; menuName: string | null; via: MatchVia }[];
  amount: number | null;
  note: string | null;
  fields: Record<string, string>;
  warnings: string[];
  ready: boolean;
}

export const MAIL_KIND_LABEL: Record<MailParseResult['kind'], string> = {
  booked: '新規予約',
  changed: '予約変更',
  cancelled: 'キャンセル',
  unknown: '予約メールではない',
};

export interface CsvImportRow {
  row: number;
  externalId: string;
  status: 'booked' | 'cancelled' | 'error';
  start: string | null;
  customerName: string | null;
  staff: MailParseResult['staff'] | null;
  menus: MailParseResult['menus'];
  outcome?: string;
  error?: string;
}

export interface CsvImportResult {
  dryRun: boolean;
  total: number;
  summary: Record<string, number>;
  results: CsvImportRow[];
}

export const OUTCOME_LABEL: Record<string, string> = {
  preview: '取り込み予定',
  created: '作成',
  updated: '更新',
  cancelled: '取消',
  linked: '紐付け',
  conflict: '競合キューへ',
  skipped: 'スキップ（変更なし）',
  error: 'エラー',
};

export interface ManualBlock {
  id: string;
  state: 'action_required' | 'remove_required' | 'pushed' | 'removed' | string;
  block_start_at: string;
  block_end_at: string;
  message: string | null;
  notified_at: string | null;
  done_at: string | null;
  created_at: string;
  updated_at: string;
  integration_account_id: string;
  provider: string;
  providerLabel: string;
  integration_name: string;
  shop_id: string | null;
  appointment_id: string;
  booking_reference: string | null;
  source: string;
  appointment_status: string;
  staff_name: string | null;
  customer_name: string;
}

/** Providers the API registers adapters for (no listing endpoint — see README) */
export const PROVIDERS: { value: string; label: string; description: string }[] = [
  {
    value: 'hotpepper_mail',
    label: 'ホットペッパービューティー（予約通知メール連携）',
    description:
      'SALON BOARD の予約通知メールを専用アドレスへ転送すると、数秒〜数十秒で予約台帳へ反映します。自社側の予約は「媒体で枠を止める」依頼として通知します。',
  },
  {
    value: 'lime_mail',
    label: 'LiME（予約通知メール連携）',
    description:
      'LiME の予約通知メールを専用アドレスへ転送すると、予約台帳へ反映します。既存の予約はCSVで一括取り込みできます。',
  },
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
  parseTest: (id: string, input: { subject: string; text?: string; html?: string }) =>
    api.post<MailParseResult>(`/integrations/${id}/parse-test`, input),
  importCsv: (id: string, input: { csv: string; dryRun: boolean }, idempotencyKey?: string) =>
    api.post<CsvImportResult>(`/integrations/${id}/import-csv`, input, idempotencyKey ? { idempotencyKey } : undefined),
  manualBlocks: (q: { shopId?: string; state?: 'open' | 'all' }) =>
    api.get<ManualBlock[]>('/integrations/manual-blocks', q),
  completeManualBlock: (id: string) =>
    api.post<{ id: string; state: string }>(`/integrations/manual-blocks/${id}/done`),
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
  manualBlocks: (q: object) => ['integrations', 'manual-blocks', q] as const,
};

export function isMailProvider(provider: string) {
  return provider === 'hotpepper_mail' || provider === 'lime_mail';
}

export function useManualBlocks(q: { shopId?: string; state?: 'open' | 'all' }, enabled = true) {
  return useQuery({
    queryKey: integrationKeys.manualBlocks(q),
    queryFn: () => integrationsApi.manualBlocks(q),
    enabled,
    refetchInterval: 30_000,
  });
}

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
