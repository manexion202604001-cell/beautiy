import { api } from '../lib/api';
import type { LoginResult, Me, TokenPair } from './types';

export interface SignupInput {
  organizationName: string;
  organizationSlug: string;
  shopName: string;
  shopSlug: string;
  ownerName: string;
  email: string;
  password: string;
  phone?: string;
}

export const authApi = {
  login: (email: string, password: string, organizationId?: string) =>
    api.post<LoginResult>(
      '/auth/login',
      { email, password, ...(organizationId ? { organizationId } : {}) },
      { auth: 'none' },
    ),
  verifyOtp: (challengeId: string, code: string) =>
    api.post<TokenPair>('/auth/otp/verify', { challengeId, code }, { auth: 'none' }),
  signup: (input: SignupInput) =>
    api.post<{
      organizationId: string;
      shopId: string;
      userId: string;
      staffId: string;
      auth: LoginResult;
    }>('/auth/signup', input, { auth: 'none' }),
  acceptInvite: (token: string, password: string) =>
    api.post<TokenPair>('/auth/accept-invite', { token, password }, { auth: 'none' }),
  logout: (refreshToken: string) =>
    api.post<void>('/auth/logout', { refreshToken }, { auth: 'none' }),
  switchOrganization: (organizationId: string) =>
    api.post<TokenPair>('/auth/switch-organization', { organizationId }),
  changePassword: (currentPassword: string, newPassword: string) =>
    api.post<void>('/auth/password', { currentPassword, newPassword }),
  setMfa: (enabled: boolean) => api.put<{ enabled: boolean }>('/auth/mfa', { enabled }),
  me: () => api.get<Me>('/me'),
};
