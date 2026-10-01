import { api } from '../lib/api';
import type {
  AvailabilityResult,
  CustomerAuthResult,
  CustomerProfile,
  PublicAppointment,
  PublicBookingInput,
  PublicBookingResult,
  PublicShopInfo,
} from './types';

const none = { auth: 'none' as const };
const cust = (token: string | null | undefined) => ({
  auth: 'customer' as const,
  token: token ?? null,
});

/** Customer-facing endpoints (no staff auth). */
export const publicApi = {
  shop: (slug: string) =>
    api.get<PublicShopInfo>(`/public/shops/${encodeURIComponent(slug)}`, undefined, none),
  availability: (
    slug: string,
    q: { menuIds: string[]; staffId?: string; from: string; to: string },
  ) =>
    api.get<AvailabilityResult>(
      `/public/shops/${encodeURIComponent(slug)}/availability`,
      { ...q },
      none,
    ),
  loginLine: (slug: string, idToken: string) =>
    api.post<CustomerAuthResult>(
      `/public/shops/${encodeURIComponent(slug)}/auth/line`,
      { idToken },
      none,
    ),
  requestOtp: (slug: string, destination: string) =>
    api.post<{ challengeId: string; channel: 'sms' | 'email'; devCode?: string }>(
      `/public/shops/${encodeURIComponent(slug)}/auth/otp/request`,
      { destination },
      none,
    ),
  verifyOtp: (
    challengeId: string,
    code: string,
    profile?: {
      lastName?: string;
      firstName?: string;
      lastNameKana?: string;
      firstNameKana?: string;
    },
  ) =>
    api.post<CustomerAuthResult>(
      '/public/auth/otp/verify',
      { challengeId, code, ...(profile ? { profile } : {}) },
      none,
    ),
  book: (slug: string, input: PublicBookingInput, token?: string | null) =>
    api.post<PublicBookingResult>(
      `/public/shops/${encodeURIComponent(slug)}/appointments`,
      input,
      token ? cust(token) : none,
    ),
  me: (token: string) => api.get<CustomerProfile>('/public/me', undefined, cust(token)),
  updateMe: (
    token: string,
    input: Partial<{
      lastName: string;
      firstName: string;
      lastNameKana: string;
      firstNameKana: string;
      phone: string;
      email: string | null;
      birthday: string | null;
      marketingOptIn: boolean;
    }>,
  ) => api.patch<CustomerProfile>('/public/me', input, cust(token)),
  myAppointments: (token: string, scope: 'upcoming' | 'past') =>
    api.get<PublicAppointment[]>('/public/me/appointments', { scope }, cust(token)),
  cancelMine: (token: string, id: string, reason?: string) =>
    api.post<PublicAppointment>(
      `/public/me/appointments/${id}/cancel`,
      reason ? { reason } : {},
      cust(token),
    ),
  rescheduleMine: (
    token: string,
    id: string,
    input: { startAt: string; staffId?: string | null; version: number },
  ) => api.patch<PublicAppointment>(`/public/me/appointments/${id}`, input, cust(token)),
  booking: (token: string) =>
    api.get<PublicAppointment>(`/public/bookings/${encodeURIComponent(token)}`, undefined, none),
  cancelBooking: (token: string, reason?: string) =>
    api.post<PublicAppointment>(
      `/public/bookings/${encodeURIComponent(token)}/cancel`,
      reason ? { reason } : {},
      none,
    ),
};

/** The API returns an absolute manageUrl (WEB_BASE_URL); keep only the in-app path so it works on any host. */
export function manageUrlToPath(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url, window.location.origin);
    return u.pathname;
  } catch {
    return null;
  }
}
