/** API calls of the 店舗設定 and 設定 screens (equipment, shop removal, owner profile, staff × shop, invitations) */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { orgKeys } from './org';
import type { Organization, Shop, Staff } from './types';

// ---------------------------------------------------------------- 設備

export interface Equipment {
  shopId: string;
  name: string;
  quantity: number;
  isActive: boolean;
}

export const equipmentApi = {
  list: (shopId: string, includeInactive = false) =>
    api.get<Equipment[]>('/equipment', { shopId, includeInactive: includeInactive || undefined }),
  create: (input: { shopId: string; name: string; quantity: number }) =>
    api.post<Equipment>('/equipment', input),
  update: (input: {
    shopId: string;
    name: string;
    newName?: string;
    quantity?: number;
    isActive?: boolean;
  }) => api.patch<Equipment>('/equipment', input),
  delete: (shopId: string, name: string) => api.delete('/equipment', { query: { shopId, name } }),
};

export const equipmentKeys = {
  all: ['equipment'] as const,
  list: (shopId: string, includeInactive: boolean) =>
    ['equipment', shopId, { includeInactive }] as const,
};

/** Equipment of the shop; `enabled` lets the tab load it on first open, as the original screen does */
export function useEquipment(shopId: string | null, includeInactive: boolean, enabled = true) {
  return useQuery({
    queryKey: equipmentKeys.list(shopId ?? '', includeInactive),
    queryFn: () => equipmentApi.list(shopId!, includeInactive),
    enabled: !!shopId && enabled,
  });
}

// ---------------------------------------------------------------- 店舗

export interface NewShopInput {
  name: string;
  addressLine?: string | null;
  phone?: string | null;
  email?: string | null;
}

export const shopAdminApi = {
  create: (input: NewShopInput) => api.post<Shop>('/shops', input),
  delete: (id: string) => api.delete(`/shops/${id}`),
};

export function useInvalidateShops() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: orgKeys.shops });
}

// ---------------------------------------------------------------- オーナー情報

export type OwnerType = 'individual' | 'company';

export interface OwnerProfile {
  ownerType: OwnerType;
  companyName?: string | null;
  companyPostalCode?: string | null;
  companyPhone?: string | null;
  companyAddress?: string | null;
  companyEmail?: string | null;
}

/** organizations.settings.ownerProfile, when the owner has saved it */
export function ownerProfileOf(org: Organization | undefined): OwnerProfile | null {
  const raw = org?.settings?.ownerProfile as Partial<OwnerProfile> | undefined;
  if (!raw || (raw.ownerType !== 'individual' && raw.ownerType !== 'company')) return null;
  return raw as OwnerProfile;
}

export function useSaveOwnerProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ownerProfile: OwnerProfile) =>
      api.patch<Organization>('/organization', { ownerProfile }),
    onSuccess: (org) => qc.setQueryData(orgKeys.org, org),
  });
}

// ---------------------------------------------------------------- スタッフ管理

export type InvitationStatus = 'pending' | 'accepted' | 'cancelled';

export interface StaffInvitation {
  id: string;
  staff_id: string;
  shop_id: string;
  email: string;
  accepted_at: string | null;
  created_at: string;
  staff_name: string;
  shop_name: string;
  role_key: string;
  role_name: string;
  invited_by_name: string | null;
  status: InvitationStatus;
}

export type InviteRoleKey = 'stylist' | 'manager';

export const staffAdminApi = {
  setShops: (staffId: string, shopIds: string[], primaryShopId?: string) =>
    api.put<Staff>(`/staff/${staffId}/shops`, { shopIds, primaryShopId }),
  setVisibility: (staffId: string, shopId: string, visible: boolean) =>
    api.put<Staff>(`/staff/${staffId}/shops/${shopId}/visibility`, { visible }),
  invitations: () => api.get<StaffInvitation[]>('/staff-invitations'),
  invite: (input: { email: string; displayName: string; roleKey: InviteRoleKey; shopId: string }) =>
    api.post<{ invitationId: string; staffId: string; inviteUrl: string; emailSent: boolean }>(
      '/staff-invitations',
      input,
    ),
};

export const staffAdminKeys = {
  invitations: ['staff-invitations'] as const,
};

export function useStaffInvitations(enabled = true) {
  return useQuery({
    queryKey: staffAdminKeys.invitations,
    queryFn: staffAdminApi.invitations,
    enabled,
  });
}
