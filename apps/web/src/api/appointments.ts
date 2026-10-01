import { useQuery } from '@tanstack/react-query';
import { api, newIdempotencyKey } from '../lib/api';
import type {
  AppointmentDetail,
  AppointmentEvent,
  AppointmentListItem,
  AppointmentStatus,
  AttentionItem,
  AvailabilityResult,
  CreateAppointmentInput,
  UpdateAppointmentInput,
} from './types';

export interface AppointmentQuery {
  shopId?: string;
  date?: string;
  from?: string;
  to?: string;
  staffId?: string;
  customerId?: string;
  status?: AppointmentStatus | AppointmentStatus[];
  limit?: number;
}

export type TransitionAction =
  'confirm' | 'check-in' | 'start' | 'complete' | 'cancel' | 'no-show' | 'restore';

export const appointmentsApi = {
  list: (q: AppointmentQuery) => api.get<AppointmentListItem[]>('/appointments', { ...q }),
  get: (id: string) => api.get<AppointmentDetail>(`/appointments/${id}`),
  history: (id: string) => api.get<AppointmentEvent[]>(`/appointments/${id}/history`),
  attention: (shopId: string) =>
    api.get<{ tentative: AttentionItem[]; noShowCandidates: AttentionItem[] }>(
      '/appointments/attention',
      { shopId },
    ),
  create: (input: CreateAppointmentInput, idempotencyKey = newIdempotencyKey()) =>
    api.post<AppointmentDetail>('/appointments', input, { idempotencyKey }),
  update: (id: string, input: UpdateAppointmentInput, idempotencyKey = newIdempotencyKey()) =>
    api.patch<AppointmentDetail>(`/appointments/${id}`, input, { idempotencyKey }),
  transition: (
    id: string,
    action: TransitionAction,
    body: { version?: number; reason?: string } = {},
    idempotencyKey = newIdempotencyKey(),
  ) => api.post<AppointmentDetail>(`/appointments/${id}/${action}`, body, { idempotencyKey }),
  availability: (q: {
    shopId: string;
    menuIds: string[];
    staffId?: string;
    from: string;
    to: string;
  }) => api.get<AvailabilityResult>('/availability', { ...q }),
};

export const appointmentKeys = {
  all: ['appointments'] as const,
  list: (q: AppointmentQuery) => ['appointments', 'list', q] as const,
  detail: (id: string) => ['appointments', 'detail', id] as const,
  history: (id: string) => ['appointments', 'history', id] as const,
  attention: (shopId: string) => ['appointments', 'attention', shopId] as const,
  availability: (q: object) => ['appointments', 'availability', q] as const,
};

export function useAppointments(q: AppointmentQuery, enabled = true) {
  return useQuery({
    queryKey: appointmentKeys.list(q),
    queryFn: () => appointmentsApi.list(q),
    enabled,
    refetchInterval: 60_000,
  });
}

export function useAppointment(id: string | null | undefined) {
  return useQuery({
    queryKey: appointmentKeys.detail(id ?? ''),
    queryFn: () => appointmentsApi.get(id!),
    enabled: !!id,
  });
}

export function useAvailability(
  q: { shopId: string; menuIds: string[]; staffId?: string; from: string; to: string } | null,
) {
  return useQuery({
    queryKey: appointmentKeys.availability(q ?? {}),
    queryFn: () => appointmentsApi.availability(q!),
    enabled: !!q && q.menuIds.length > 0,
  });
}

export const STATUS_LABEL: Record<AppointmentStatus, string> = {
  tentative: '仮予約',
  confirmed: '確定',
  checked_in: '来店',
  in_service: '施術中',
  completed: '完了',
  cancelled: 'キャンセル',
  no_show: '無断キャンセル',
};

export const SOURCE_LABEL: Record<string, string> = {
  web: 'Web',
  line: 'LINE',
  external: '外部媒体',
  phone: '電話',
  walk_in: '店頭',
  staff: 'スタッフ',
};

/** Allowed actions per status (mirrors the API state machine) */
export const STATUS_ACTIONS: Record<AppointmentStatus, TransitionAction[]> = {
  tentative: ['confirm', 'cancel'],
  confirmed: ['check-in', 'start', 'complete', 'cancel', 'no-show'],
  checked_in: ['start', 'complete', 'cancel', 'no-show'],
  in_service: ['complete'],
  completed: [],
  cancelled: ['restore'],
  no_show: ['restore'],
};

export const ACTION_LABEL: Record<TransitionAction, string> = {
  confirm: '確定する',
  'check-in': '来店',
  start: '施術開始',
  complete: '完了',
  cancel: 'キャンセル',
  'no-show': '無断キャンセル',
  restore: '復元',
};

export const EVENT_LABEL: Record<string, string> = {
  created: '予約作成',
  rescheduled: '日時・担当変更',
  updated: '内容変更',
  confirmed: '確定',
  checked_in: '来店受付',
  in_service: '施術開始',
  completed: '施術完了',
  cancelled: 'キャンセル',
  no_show: '無断キャンセル',
  restored: '復元',
};
