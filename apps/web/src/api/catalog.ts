import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import type {
  Coupon,
  CouponInput,
  EffectiveMenu,
  MenuCategory,
  MenuDetail,
  MenuInput,
  Resource,
} from './types';

export const catalogApi = {
  categories: (shopId?: string) => api.get<MenuCategory[]>('/menu-categories', { shopId }),
  createCategory: (input: { shopId?: string | null; name: string; sortOrder?: number }) =>
    api.post<MenuCategory>('/menu-categories', input),
  updateCategory: (id: string, input: { name?: string; sortOrder?: number }) =>
    api.patch<MenuCategory>(`/menu-categories/${id}`, input),
  deleteCategory: (id: string) => api.delete(`/menu-categories/${id}`),
  menus: (shopId: string, includeInactive = false) =>
    api.get<EffectiveMenu[]>('/menus', { shopId, includeInactive }),
  menu: (id: string) => api.get<MenuDetail>(`/menus/${id}`),
  createMenu: (input: MenuInput) => api.post<MenuDetail>('/menus', input),
  updateMenu: (id: string, input: MenuInput) => api.patch<MenuDetail>(`/menus/${id}`, input),
  deleteMenu: (id: string) => api.delete(`/menus/${id}`),
  setOverride: (
    id: string,
    shopId: string,
    input: { price?: number | null; durationMin?: number | null; isAvailable?: boolean },
  ) => api.put(`/menus/${id}/shops/${shopId}`, input),
  deleteOverride: (id: string, shopId: string) => api.delete(`/menus/${id}/shops/${shopId}`),
  setStaffMenus: (
    staffId: string,
    menus: { menuId: string; durationMin?: number | null; price?: number | null }[],
  ) =>
    api.put<{ menu_id: string; duration_min: number | null; price: number | null }[]>(
      `/staff/${staffId}/menus`,
      { menus },
    ),
  resources: (shopId: string) => api.get<Resource[]>('/resources', { shopId }),
  createResource: (input: {
    shopId: string;
    name: string;
    resourceType: string;
    sortOrder?: number;
  }) => api.post<Resource>('/resources', input),
  updateResource: (
    id: string,
    input: {
      name?: string;
      resourceType?: string;
      sortOrder?: number;
      status?: 'active' | 'inactive';
    },
  ) => api.patch<Resource>(`/resources/${id}`, input),
  deleteResource: (id: string) => api.delete(`/resources/${id}`),
  coupons: (shopId?: string) => api.get<Coupon[]>('/coupons', { shopId }),
  createCoupon: (input: CouponInput) => api.post<Coupon>('/coupons', input),
  updateCoupon: (id: string, input: CouponInput) => api.patch<Coupon>(`/coupons/${id}`, input),
  deleteCoupon: (id: string) => api.delete(`/coupons/${id}`),
  evaluateCoupon: (input: {
    couponId: string;
    shopId: string;
    customerId?: string | null;
    lines: { menuId?: string | null; amount: number }[];
  }) =>
    api.post<{
      couponId: string;
      name: string;
      valid: boolean;
      reason?: string;
      discountAmount: number;
    }>('/coupons/evaluate', input),
};

export const catalogKeys = {
  all: ['catalog'] as const,
  categories: (shopId?: string) => ['catalog', 'categories', shopId ?? null] as const,
  menus: (shopId: string, includeInactive: boolean) =>
    ['catalog', 'menus', shopId, includeInactive] as const,
  menu: (id: string) => ['catalog', 'menu', id] as const,
  resources: (shopId: string) => ['catalog', 'resources', shopId] as const,
  coupons: (shopId?: string) => ['catalog', 'coupons', shopId ?? null] as const,
};

export function useMenus(shopId: string | null | undefined, includeInactive = false) {
  return useQuery({
    queryKey: catalogKeys.menus(shopId ?? '', includeInactive),
    queryFn: () => catalogApi.menus(shopId!, includeInactive),
    enabled: !!shopId,
    staleTime: 60_000,
  });
}

export function useCategories(shopId?: string) {
  return useQuery({
    queryKey: catalogKeys.categories(shopId),
    queryFn: () => catalogApi.categories(shopId),
    staleTime: 60_000,
  });
}

export function useResources(shopId: string | null | undefined) {
  return useQuery({
    queryKey: catalogKeys.resources(shopId ?? ''),
    queryFn: () => catalogApi.resources(shopId!),
    enabled: !!shopId,
  });
}

export function useCoupons(shopId?: string | null) {
  return useQuery({
    queryKey: catalogKeys.coupons(shopId ?? undefined),
    queryFn: () => catalogApi.coupons(shopId ?? undefined),
    staleTime: 60_000,
  });
}
