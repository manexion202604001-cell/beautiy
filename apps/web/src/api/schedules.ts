import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import type {
  BusinessHour,
  CalendarException,
  DayStaffSchedule,
  ScheduleBlock,
  Shift,
  ShiftInput,
  WeeklyScheduleRow,
} from './types';

export const schedulesApi = {
  businessHours: (shopId: string) => api.get<BusinessHour[]>(`/shops/${shopId}/business-hours`),
  replaceBusinessHours: (
    shopId: string,
    hours: { weekday: number; openTime: string; closeTime: string }[],
  ) => api.put<BusinessHour[]>(`/shops/${shopId}/business-hours`, { hours }),
  exceptions: (shopId: string, from: string, to: string) =>
    api.get<CalendarException[]>(`/shops/${shopId}/calendar-exceptions`, { from, to }),
  upsertException: (
    shopId: string,
    date: string,
    input: {
      isClosed: boolean;
      openTime?: string | null;
      closeTime?: string | null;
      note?: string | null;
    },
  ) => api.put<CalendarException>(`/shops/${shopId}/calendar-exceptions/${date}`, input),
  deleteException: (shopId: string, date: string) =>
    api.delete(`/shops/${shopId}/calendar-exceptions/${date}`),
  weekly: (staffId: string, shopId: string) =>
    api.get<WeeklyScheduleRow[]>(`/staff/${staffId}/weekly-schedule`, { shopId }),
  replaceWeekly: (
    staffId: string,
    shopId: string,
    rows: { weekday: number; startTime: string; endTime: string }[],
  ) => api.put<WeeklyScheduleRow[]>(`/staff/${staffId}/weekly-schedule`, { shopId, rows }),
  shifts: (shopId: string, from: string, to: string) =>
    api.get<Shift[]>('/shifts', { shopId, from, to }),
  upsertShifts: (shopId: string, shifts: ShiftInput[]) =>
    api.put<Shift[]>('/shifts', { shopId, shifts }),
  blocks: (shopId: string, from: string, to: string) =>
    api.get<ScheduleBlock[]>('/schedule-blocks', { shopId, from, to }),
  createBlock: (input: {
    shopId: string;
    staffId?: string | null;
    resourceId?: string | null;
    startAt: string;
    endAt: string;
    reason?: string | null;
  }) => api.post<ScheduleBlock>('/schedule-blocks', input),
  deleteBlock: (id: string) => api.delete(`/schedule-blocks/${id}`),
  staffSchedule: (shopId: string, date: string) =>
    api.get<DayStaffSchedule>(`/shops/${shopId}/staff-schedule`, { date }),
};

export const scheduleKeys = {
  all: ['schedules'] as const,
  hours: (shopId: string) => ['schedules', 'hours', shopId] as const,
  exceptions: (shopId: string, from: string, to: string) =>
    ['schedules', 'exceptions', shopId, from, to] as const,
  weekly: (staffId: string, shopId: string) => ['schedules', 'weekly', staffId, shopId] as const,
  shifts: (shopId: string, from: string, to: string) =>
    ['schedules', 'shifts', shopId, from, to] as const,
  blocks: (shopId: string, from: string, to: string) =>
    ['schedules', 'blocks', shopId, from, to] as const,
  staffSchedule: (shopId: string, date: string) =>
    ['schedules', 'staff-schedule', shopId, date] as const,
};

export function useBusinessHours(shopId: string | null | undefined) {
  return useQuery({
    queryKey: scheduleKeys.hours(shopId ?? ''),
    queryFn: () => schedulesApi.businessHours(shopId!),
    enabled: !!shopId,
    staleTime: 5 * 60_000,
  });
}

export function useStaffSchedule(shopId: string | null | undefined, date: string) {
  return useQuery({
    queryKey: scheduleKeys.staffSchedule(shopId ?? '', date),
    queryFn: () => schedulesApi.staffSchedule(shopId!, date),
    enabled: !!shopId,
  });
}

export function useExceptions(shopId: string | null | undefined, from: string, to: string) {
  return useQuery({
    queryKey: scheduleKeys.exceptions(shopId ?? '', from, to),
    queryFn: () => schedulesApi.exceptions(shopId!, from, to),
    enabled: !!shopId,
  });
}

export function useShifts(shopId: string | null | undefined, from: string, to: string) {
  return useQuery({
    queryKey: scheduleKeys.shifts(shopId ?? '', from, to),
    queryFn: () => schedulesApi.shifts(shopId!, from, to),
    enabled: !!shopId,
  });
}

export function useBlocks(shopId: string | null | undefined, from: string, to: string) {
  return useQuery({
    queryKey: scheduleKeys.blocks(shopId ?? '', from, to),
    queryFn: () => schedulesApi.blocks(shopId!, from, to),
    enabled: !!shopId,
  });
}
