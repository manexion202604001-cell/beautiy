import { useQuery } from '@tanstack/react-query';
import { api, downloadFile, newIdempotencyKey } from '../lib/api';

/** Data migration from the previous system — /v1/migration */

export type ImportKind = 'customers' | 'visits' | 'reservations';
export type Mapping = Record<string, number[]>;

export const KIND_LABEL: Record<ImportKind, string> = {
  customers: '顧客',
  visits: '来店履歴・カルテ',
  reservations: '今後の予約',
};

export interface FieldDef {
  key: string;
  label: string;
  synonyms: string[];
  multi?: boolean;
  hint?: string;
}

export interface ImportOptions {
  onExisting?: 'fill' | 'skip';
  defaultMarketingOptIn?: boolean;
  createMissingCustomers?: boolean;
  defaultMenuId?: string;
  sendReminders?: boolean;
}

export interface ImportRequest {
  kind: ImportKind;
  csv: string;
  shopId: string;
  mapping?: Mapping;
  options?: ImportOptions;
  fileName?: string;
  sourceLabel?: string;
}

export interface PreviewRow {
  rowNo: number;
  values: Record<string, string>;
  errors: string[];
  warnings: string[];
  match: string | null;
  extraColumns: string[];
}

export interface PreviewResult {
  kind: ImportKind;
  header: string[];
  mapping: Mapping;
  fields: FieldDef[];
  counts: {
    total: number;
    ready: number;
    errors: number;
    warnings: number;
    existing: number;
    newCustomers: number;
    alreadyImported: number;
    duplicateInFile: number;
    unknownStaff: number;
    unknownMenu: number;
    past: number;
  };
  amountTotal: number;
  unmappedColumns: string[];
  unknownStaff: { name: string; rows: number }[];
  unknownMenus: { name: string; rows: number }[];
  sample: PreviewRow[];
  problems: PreviewRow[];
}

export interface ImportJob {
  id: string;
  shop_id: string | null;
  kind: ImportKind;
  source_label: string;
  file_name: string | null;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'undone';
  total_rows: number;
  processed_rows: number;
  summary: Partial<Record<'created' | 'updated' | 'matched' | 'skipped' | 'error', number>>;
  totals: {
    fileRows?: number;
    fileAmount?: number;
    importedRows?: number;
    importedAmount?: number;
  };
  error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  undone_at: string | null;
  problems?: {
    row_no: number;
    outcome: string;
    message: string | null;
    resource_id: string | null;
  }[];
}

export const OUTCOME_LABEL: Record<string, string> = {
  created: '新規登録',
  updated: '既存に補完',
  matched: '既存と一致（変更なし）',
  skipped: '取り込み済み',
  error: '取り込めず',
};

export const migrationApi = {
  preview: (input: ImportRequest) => api.post<PreviewResult>('/migration/preview', input),
  start: (input: ImportRequest, idempotencyKey = newIdempotencyKey()) =>
    api.post<ImportJob>('/migration/imports', input, { idempotencyKey }),
  jobs: () => api.get<ImportJob[]>('/migration/imports'),
  job: (id: string) => api.get<ImportJob>(`/migration/imports/${id}`),
  undo: (id: string) =>
    api.post<{ removed: number; restored: number; kept: { rowNo: number; reason: string }[] }>(
      `/migration/imports/${id}/undo`,
    ),
  errorsCsv: (id: string) =>
    downloadFile(
      `/migration/imports/${id}/errors.csv`,
      undefined,
      `import-errors-${id.slice(0, 8)}.csv`,
    ),
};

export const migrationKeys = {
  jobs: ['migration', 'jobs'] as const,
  job: (id: string) => ['migration', 'job', id] as const,
};

export function useImportJobs() {
  return useQuery({ queryKey: migrationKeys.jobs, queryFn: migrationApi.jobs });
}

export function useImportJob(id: string | null) {
  return useQuery({
    queryKey: migrationKeys.job(id ?? ''),
    queryFn: () => migrationApi.job(id!),
    enabled: !!id,
    refetchInterval: (q) =>
      q.state.data && ['queued', 'running'].includes(q.state.data.status) ? 1500 : false,
  });
}
