import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api, newIdempotencyKey } from '../lib/api';
import type { Page } from './types';

/** 運用・監査 (/v1/ops/*, /v1/audit-logs, /v1/exports, /v1/feature-flags) */

export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'dead' | 'cancelled';
export type WebhookStatus = 'received' | 'processing' | 'processed' | 'failed' | 'ignored' | 'dead';
export type ExportKind = 'customers' | 'appointments' | 'transactions' | 'transaction_items' | 'staff_sales';

export const JOB_STATE_LABEL: Record<JobState, string> = {
  queued: '待機中',
  running: '実行中',
  succeeded: '成功',
  failed: '失敗(再試行待ち)',
  dead: 'DLQ',
  cancelled: '取消',
};
export const WEBHOOK_STATUS_LABEL: Record<WebhookStatus, string> = {
  received: '受信',
  processing: '処理中',
  processed: '処理済み',
  failed: '失敗',
  ignored: '無視',
  dead: 'DLQ',
};
export const EXPORT_KIND_LABEL: Record<ExportKind, string> = {
  customers: '顧客',
  appointments: '予約',
  transactions: '売上',
  transaction_items: '売上明細',
  staff_sales: 'スタッフ別売上',
};
/** permission each export kind needs in addition to export.data (apps/api ops/exports.ts) */
export const EXPORT_KIND_PERMISSION: Record<ExportKind, string> = {
  customers: 'customer.read',
  appointments: 'appointment.read',
  transactions: 'sales.read',
  transaction_items: 'sales.read',
  staff_sales: 'sales.read',
};

export interface OpsDashboard {
  webhookEvents: {
    failed: number;
    dead: number;
    recent: {
      id: string;
      provider: string;
      event_type: string | null;
      status: WebhookStatus;
      attempts: number;
      last_error: string | null;
      received_at: string;
    }[];
  };
  jobs: {
    failed: number;
    dead: number;
    recent: {
      id: string;
      type: string;
      state: JobState;
      attempts: number;
      max_attempts: number;
      last_error: string | null;
      created_at: string;
      finished_at: string | null;
    }[];
  };
  integrations: {
    failing: number;
    degraded: number;
    accounts: {
      id: string;
      shop_id: string | null;
      provider: string;
      display_name: string;
      status: string;
      last_error: string | null;
      last_error_at: string | null;
      last_success_at: string | null;
      consecutive_failures: number;
    }[];
  };
  syncConflicts: {
    open: number;
    recent: { id: string; conflict_type: string; details: unknown; appointment_id: string | null; created_at: string }[];
  };
  messages: {
    failed: number;
    recent: {
      id: string;
      shop_id: string | null;
      customer_id: string | null;
      channel: string;
      category: string;
      error: string | null;
      attempts: number;
      updated_at: string;
    }[];
  };
  generatedAt: string;
}

export interface Health {
  status: 'ok' | 'degraded';
  db: { ok: boolean; latencyMs: number };
  queue: { queued: number; ready: number; running: number; failed: number; dead: number };
  oldestQueuedAgeSec: number;
  orgWorkerLagSec: number;
  workerLagSec: number;
  clusterReadyJobs: number;
  checkedAt: string;
}

export interface Job {
  id: string;
  type: string;
  queue: string;
  state: JobState;
  payload: unknown;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  dedupe_key: string | null;
  run_at: string;
  created_at: string;
  finished_at: string | null;
}

export interface WebhookEvent {
  id: string;
  provider: string;
  event_id: string | null;
  event_type: string | null;
  signature_valid: boolean;
  status: WebhookStatus;
  attempts: number;
  last_error: string | null;
  payload: unknown;
  received_at: string;
  processed_at: string | null;
}

export interface AuditLog {
  id: string;
  created_at: string;
  actor_type: string;
  actor_id: string | null;
  actor_name: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  shop_id: string | null;
  shop_name: string | null;
  before: unknown;
  after: unknown;
  metadata: unknown;
  ip: string | null;
  user_agent: string | null;
  request_id: string | null;
  trace_id: string | null;
}

export interface AuditQuery {
  actorId?: string;
  action?: string;
  resourceType?: string;
  resourceId?: string;
  shopId?: string;
  from?: string;
  to?: string;
}

export interface DataExport {
  id: string;
  kind: ExportKind;
  params: { from?: string; to?: string; shopId?: string };
  status: 'queued' | 'running' | 'completed' | 'failed' | 'expired' | string;
  file_id: string | null;
  row_count: number | null;
  error: string | null;
  requested_by: string | null;
  created_at: string;
  completed_at: string | null;
  expires_at: string | null;
}

export interface FeatureFlag {
  key: string;
  description: string | null;
  enabled: boolean;
  global: { enabled: boolean; rollout: unknown } | null;
  override: { enabled: boolean; rollout: unknown; updatedAt: string } | null;
}

export const opsApi = {
  dashboard: () => api.get<OpsDashboard>('/ops/dashboard'),
  health: () => api.get<Health>('/ops/health'),
  jobs: (q: { state?: JobState; type?: string; cursor?: string }) =>
    api.get<Page<Job>>('/ops/jobs', { ...q, limit: 50 }),
  retryJob: (id: string) => api.post<Job>(`/ops/jobs/${id}/retry`),
  cancelJob: (id: string) => api.post<Job>(`/ops/jobs/${id}/cancel`),
  webhookEvents: (q: { status?: WebhookStatus; provider?: string; cursor?: string }) =>
    api.get<Page<WebhookEvent>>('/ops/webhook-events', { ...q, limit: 50 }),
  reprocess: (id: string) => api.post<WebhookEvent & { jobId: string | null }>(`/ops/webhook-events/${id}/reprocess`),
  audit: (q: AuditQuery & { cursor?: string }) =>
    api.get<Page<AuditLog>>('/audit-logs', { ...q, limit: 50 }),
  exports: (cursor?: string) => api.get<Page<DataExport>>('/exports', { cursor, limit: 50 }),
  createExport: (
    input: { kind: ExportKind; params: { from?: string; to?: string; shopId?: string } },
    idempotencyKey = newIdempotencyKey(),
  ) => api.post<DataExport>('/exports', input, { idempotencyKey }),
  exportDownload: (id: string) =>
    api.get<{ url: string; fileName: string; expiresAt: string }>(`/exports/${id}/download`),
  flags: () => api.get<FeatureFlag[]>('/feature-flags'),
  setFlag: (key: string, enabled: boolean) => api.put<FeatureFlag>(`/feature-flags/${key}`, { enabled }),
  clearFlag: (key: string) => api.delete<FeatureFlag>(`/feature-flags/${key}`),
};

export function useOpsDashboard(enabled = true) {
  return useQuery({ queryKey: ['ops', 'dashboard'], queryFn: opsApi.dashboard, enabled, refetchInterval: 60_000 });
}

export function useHealth(enabled = true) {
  return useQuery({ queryKey: ['ops', 'health'], queryFn: opsApi.health, enabled, refetchInterval: 30_000 });
}

export function useJobs(q: { state?: JobState; type?: string }) {
  return useInfiniteQuery({
    queryKey: ['ops', 'jobs', q],
    queryFn: ({ pageParam }) => opsApi.jobs({ ...q, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export function useWebhookEvents(q: { status?: WebhookStatus; provider?: string }) {
  return useInfiniteQuery({
    queryKey: ['ops', 'webhooks', q],
    queryFn: ({ pageParam }) => opsApi.webhookEvents({ ...q, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export function useAuditLogs(q: AuditQuery, enabled = true) {
  return useInfiniteQuery({
    queryKey: ['ops', 'audit', q],
    queryFn: ({ pageParam }) => opsApi.audit({ ...q, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled,
  });
}

export function useExports(enabled = true) {
  return useQuery({
    queryKey: ['ops', 'exports'],
    queryFn: () => opsApi.exports(),
    enabled,
    // poll while an export is still being generated
    refetchInterval: (query) =>
      query.state.data?.items.some((e) => e.status === 'queued' || e.status === 'running') ? 2_000 : false,
  });
}

export function useFlags(enabled = true) {
  return useQuery({ queryKey: ['ops', 'flags'], queryFn: opsApi.flags, enabled });
}
