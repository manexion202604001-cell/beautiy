import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import type {
  Organization,
  PermissionDef,
  PublicProfile,
  Role,
  Shop,
  ShopSettings,
  Staff,
} from './types';

export interface ShopInput {
  name?: string;
  slug?: string;
  timezone?: string;
  phone?: string | null;
  email?: string | null;
  postalCode?: string | null;
  prefecture?: string | null;
  city?: string | null;
  addressLine?: string | null;
  description?: string | null;
  status?: 'active' | 'inactive' | 'closed';
  publicBookingEnabled?: boolean;
  settings?: { [K in keyof ShopSettings]?: Partial<ShopSettings[K]> };
}

export interface StaffInput {
  displayName?: string;
  displayNameKana?: string;
  email?: string;
  initialPassword?: string;
  phone?: string;
  roleId?: string;
  shopIds?: string[];
  employmentType?: 'full_time' | 'part_time' | 'contractor' | 'owner';
  title?: string;
  color?: string;
  isBookable?: boolean;
  nominationFee?: number;
  publicProfile?: PublicProfile;
  publicSlug?: string;
  sortOrder?: number;
  hiredOn?: string;
  status?: 'invited' | 'active' | 'inactive' | 'retired';
}

export interface TransferInput {
  fromShopId: string;
  toShopId: string;
  effectiveDate?: string;
  customerPolicy: 'keep' | 'reassign' | 'unassign';
  reassignToStaffId?: string;
}

export const orgApi = {
  organization: () => api.get<Organization>('/organization'),
  updateOrganization: (input: {
    name?: string;
    timezone?: string;
    invoiceRegistrationNumber?: string | null;
  }) => api.patch<Organization>('/organization', input),
  shops: () => api.get<Shop[]>('/shops'),
  shop: (id: string) => api.get<Shop>(`/shops/${id}`),
  createShop: (input: ShopInput & { name: string; slug: string }) =>
    api.post<Shop>('/shops', input),
  updateShop: (id: string, input: ShopInput) => api.patch<Shop>(`/shops/${id}`, input),
  staff: (q: { shopId?: string; includeInactive?: boolean; bookableOnly?: boolean } = {}) =>
    api.get<Staff[]>('/staff', q),
  staffMember: (id: string) => api.get<Staff>(`/staff/${id}`),
  createStaff: (input: StaffInput & { displayName: string; roleId: string }) =>
    api.post<{ staff: Staff; inviteUrl: string | null }>('/staff', input),
  updateStaff: (id: string, input: StaffInput) => api.patch<Staff>(`/staff/${id}`, input),
  changeRole: (id: string, roleId: string) => api.put<Staff>(`/staff/${id}/role`, { roleId }),
  setShops: (id: string, shopIds: string[]) => api.put<Staff>(`/staff/${id}/shops`, { shopIds }),
  transfer: (id: string, input: TransferInput) =>
    api.post<{ staff: Staff; affectedCustomers: number }>(`/staff/${id}/transfer`, input),
  roles: () => api.get<Role[]>('/roles'),
  permissions: () => api.get<PermissionDef[]>('/permissions'),
  createRole: (input: { key: string; name: string; description?: string; permissions: string[] }) =>
    api.post<Role>('/roles', input),
  updateRole: (
    id: string,
    input: { name?: string; description?: string; permissions?: string[] },
  ) => api.patch<Role>(`/roles/${id}`, input),
  deleteRole: (id: string) => api.delete(`/roles/${id}`),
};

export const orgKeys = {
  org: ['organization'] as const,
  shops: ['shops'] as const,
  shop: (id: string) => ['shops', id] as const,
  staffAll: ['staff'] as const,
  staff: (q: object) => ['staff', 'list', q] as const,
  staffMember: (id: string) => ['staff', 'detail', id] as const,
  roles: ['roles'] as const,
  permissions: ['permissions'] as const,
};

export function useOrganization() {
  return useQuery({ queryKey: orgKeys.org, queryFn: orgApi.organization });
}

export function useShops(enabled = true) {
  return useQuery({ queryKey: orgKeys.shops, queryFn: orgApi.shops, enabled, staleTime: 60_000 });
}

export function useShop(id: string | null | undefined) {
  return useQuery({
    queryKey: orgKeys.shop(id ?? ''),
    queryFn: () => orgApi.shop(id!),
    enabled: !!id,
  });
}

export function useStaffList(
  q: { shopId?: string; includeInactive?: boolean; bookableOnly?: boolean } = {},
  enabled = true,
) {
  return useQuery({
    queryKey: orgKeys.staff(q),
    queryFn: () => orgApi.staff(q),
    enabled,
    staleTime: 30_000,
  });
}

export function useStaffMember(id: string | undefined) {
  return useQuery({
    queryKey: orgKeys.staffMember(id ?? ''),
    queryFn: () => orgApi.staffMember(id!),
    enabled: !!id,
  });
}

export function useRoles(enabled = true) {
  return useQuery({ queryKey: orgKeys.roles, queryFn: orgApi.roles, enabled, staleTime: 60_000 });
}

export function usePermissionCatalog() {
  return useQuery({
    queryKey: orgKeys.permissions,
    queryFn: orgApi.permissions,
    staleTime: Infinity,
  });
}

export function useUpdateShop() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: ShopInput }) => orgApi.updateShop(id, input),
    onSuccess: (shop) => {
      qc.setQueryData(orgKeys.shop(shop.id), shop);
      void qc.invalidateQueries({ queryKey: orgKeys.shops });
    },
  });
}

export function useInvalidateStaff() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: orgKeys.staffAll });
}
