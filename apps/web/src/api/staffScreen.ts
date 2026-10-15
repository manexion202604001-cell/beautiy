import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import type { Staff } from './types';

/** One row of the スタッフ screen: the staff member plus what the row shows */
export interface StaffDirectoryRow extends Staff {
  nickname: string | null;
  /** address the staff member logs in with (null = no login yet) */
  login_email: string | null;
  /** false = 未認証: cannot log in yet */
  login_ready: boolean;
  notify_line: boolean;
  line_user_id: string | null;
  is_visible_to_customer: boolean;
  customer_count: number;
}

export interface StaffDayHours {
  weekday: number;
  openTime: string;
  closeTime: string;
  isClosed: boolean;
}

export interface StaffReservationSettings {
  advanceBookingDays: number;
  sameDayCutoffHours: number;
  maxConcurrent: number;
  acceptSameStartTime: boolean;
  acceptOutsideHours: boolean;
}

export interface StaffHoursResult {
  /** false = nothing saved for this staff member: the shop's hours apply */
  configured: boolean;
  hours: StaffDayHours[];
}

export interface StaffReservationResult {
  /** false = nothing saved: the shop's 予約設定 apply */
  individual: boolean;
  settings: StaffReservationSettings;
}

export const staffScreenApi = {
  directory: (shopId: string) => api.get<StaffDirectoryRow[]>(`/shops/${shopId}/staff-directory`),
  /** staff fields incl. status / retiredOn / roleId (PATCH /staff/:id) */
  update: (staffId: string, input: Record<string, unknown>) =>
    api.patch<Staff>(`/staff/${staffId}`, input),
  reorder: (shopId: string, staffIds: string[]) =>
    api.put<{ staffIds: string[] }>('/staff/reorder', { shopId, staffIds }),
  extras: (
    staffId: string,
    input: {
      nickname?: string | null;
      photoFileId?: string | null;
      notifyLine?: boolean;
      lineUserId?: string | null;
    },
  ) => api.put<Staff>(`/staff/${staffId}/extras`, input),
  credentials: (staffId: string, input: { email: string; password?: string }) =>
    api.put<Staff>(`/staff/${staffId}/credentials`, input),
  businessHours: (staffId: string, shopId: string) =>
    api.get<StaffHoursResult>(`/staff/${staffId}/business-hours`, { shopId }),
  saveBusinessHours: (staffId: string, shopId: string, hours: StaffDayHours[]) =>
    api.put<StaffHoursResult>(`/staff/${staffId}/business-hours`, { shopId, hours }),
  copyShopHours: (staffId: string, shopId: string) =>
    api.post<StaffHoursResult>(`/staff/${staffId}/business-hours/copy-shop`, { shopId }),
  reservationSettings: (staffId: string, shopId: string) =>
    api.get<StaffReservationResult>(`/staff/${staffId}/reservation-settings`, { shopId }),
  saveReservationSettings: (staffId: string, shopId: string, settings: StaffReservationSettings) =>
    api.put<StaffReservationResult>(`/staff/${staffId}/reservation-settings`, {
      shopId,
      ...settings,
    }),
  resetReservationSettings: (staffId: string, shopId: string) =>
    api.delete<StaffReservationResult>(`/staff/${staffId}/reservation-settings?shopId=${shopId}`),
  /** staff ids with their own 営業時間 / 予約設定 at the shop */
  settingsOverview: (shopId: string) =>
    api.get<{ hours: string[]; reservation: string[] }>(`/shops/${shopId}/staff-settings`),
};

export const staffScreenKeys = {
  directory: (shopId: string) => ['staff', 'directory', shopId] as const,
  overview: (shopId: string) => ['staff', 'settings-overview', shopId] as const,
};

export function useStaffDirectory(shopId: string | null | undefined) {
  return useQuery({
    queryKey: staffScreenKeys.directory(shopId ?? ''),
    queryFn: () => staffScreenApi.directory(shopId!),
    enabled: !!shopId,
  });
}
