const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8787";
const TOKEN_KEY = "admin_token";

// Token management
export const tokenStorage = {
  get: (): string | null => {
    if (typeof window === "undefined") return null;
    return localStorage.getItem(TOKEN_KEY);
  },
  set: (token: string): void => {
    if (typeof window === "undefined") return;
    localStorage.setItem(TOKEN_KEY, token);
  },
  remove: (): void => {
    if (typeof window === "undefined") return;
    localStorage.removeItem(TOKEN_KEY);
  },
};

type FetchOptions = {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  headers?: Record<string, string>;
  timeout?: number;
};

class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function fetchApi<T>(endpoint: string, options: FetchOptions = {}): Promise<T> {
  const { method = "GET", body, headers = {}, timeout = 30000 } = options;
  const token = tokenStorage.get();

  const requestHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    ...headers,
  };

  if (token) {
    requestHeaders["Authorization"] = `Bearer ${token}`;
  }

  // Add timeout for PWA/mobile environments
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(`${API_URL}${endpoint}`, {
      method,
      headers: requestHeaders,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
      credentials: "include",
    });

    clearTimeout(timeoutId);

    // Handle 401 unauthorized - redirect to login
    if (res.status === 401) {
      const data = await res.json().catch(() => ({}));
      tokenStorage.remove();
      if (typeof window !== "undefined" && !endpoint.includes("/auth/")) {
        window.location.href = "/login";
      }
      throw new ApiError(data.error || "Unauthorized", 401);
    }

    const data = await res.json();

    if (!res.ok) {
      throw new ApiError(data.error || "An error occurred", res.status);
    }

    return data;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error && error.name === "AbortError") {
      throw new ApiError("Request timeout", 408);
    }
    throw error;
  }
}

// Auth
export const auth = {
  login: async (email: string, password: string) => {
    const result = await fetchApi<{ staff: Staff; token: string; must_change_password?: boolean; onboarding_completed?: boolean }>("/api/auth/login", {
      method: "POST",
      body: { email, password },
    });
    // Save token to localStorage
    if (result.token) {
      tokenStorage.set(result.token);
    }
    return result;
  },
  logout: async () => {
    tokenStorage.remove();
    return fetchApi("/api/auth/logout", { method: "POST" });
  },
  me: () => fetchApi<{ staff: Staff; store: Store | null; stores: Array<{ id: string; name: string; is_primary: number; line_friend_url: string | null }> }>("/api/auth/me"),
  updateProfile: (data: {
    name?: string;
    owner_type?: 'individual' | 'company';
    company_name?: string | null;
    company_postal_code?: string | null;
    company_phone?: string | null;
    company_address?: string | null;
    company_email?: string | null;
  }) => fetchApi<{ success: boolean }>("/api/auth/profile", { method: "PUT", body: data }),
  forgotPassword: (email: string) =>
    fetchApi<{ message: string; registered?: boolean }>("/api/auth/forgot-password", { method: "POST", body: { email } }),
  resetPassword: (token: string, password: string) =>
    fetchApi<{ message: string }>("/api/auth/reset-password", { method: "POST", body: { token, password } }),
  completeOnboarding: (data: {
    owner_type: "individual" | "company";
    company_name?: string;
    company_postal_code?: string;
    company_phone?: string;
    company_address?: string;
    company_email?: string;
    store_name: string;
    store_postal_code?: string;
    store_address?: string;
    store_phone?: string;
    store_email?: string;
    email: string;
    password: string;
  }) => {
    return fetchApi<{ message: string; token: string; store: { id: string; name: string }; staff_code: string }>("/api/auth/complete-onboarding", {
      method: "POST",
      body: data,
    }).then(result => {
      if (result.token) {
        tokenStorage.set(result.token);
      }
      return result;
    });
  },
};

// Stores
export const stores = {
  list: () => fetchApi<{ stores: Store[] }>("/api/stores"),
  get: (id: string) => fetchApi<{ store: Store; business_hours: BusinessHours[] }>(`/api/stores/${id}`),
  create: (data: Partial<Store>) =>
    fetchApi<{ store: Store }>("/api/stores", { method: "POST", body: data }),
  update: (id: string, data: Partial<Store>) =>
    fetchApi<{ store: Store }>(`/api/stores/${id}`, { method: "PUT", body: data }),
  createOwner: (data: { owner_name: string }) =>
    fetchApi<{ owner: { id: string; name: string; login_id: string; temp_password: string } }>("/api/stores/create-owner", { method: "POST", body: data }),
  delete: (id: string) =>
    fetchApi<{ success: boolean }>(`/api/stores/${id}`, { method: "DELETE" }),
  updateHours: (id: string, hours: { day_of_week: number; open_time: string | null; close_time: string | null; is_closed: boolean; max_concurrent?: number | null }[]) =>
    fetchApi<{ business_hours: BusinessHours[] }>(`/api/stores/${id}/hours`, { method: "PUT", body: { hours } }),
  updateReservationSettings: (id: string, settings: {
    advance_booking_days?: number; advance_booking_months?: number; same_day_cutoff_hours?: number; max_concurrent?: number;
    accept_same_start_time?: boolean; accept_outside_hours?: boolean;
    booking_cutoff_type?: string; booking_cutoff_days_before?: number; booking_cutoff_time?: string | null;
    booking_cutoff_same_day_minutes?: number; booking_calc_method?: string;
    holiday_hours_enabled?: boolean;
  }) =>
    fetchApi<{ settings: Store }>(`/api/stores/${id}/reservation-settings`, { method: "PUT", body: settings }),
  getClosures: (id: string, from?: string, to?: string) => {
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    const query = params.toString() ? `?${params}` : '';
    return fetchApi<{ closures: StoreClosure[] }>(`/api/stores/${id}/closures${query}`);
  },
  addClosure: (id: string, date: string, reason?: string) =>
    fetchApi<{ closure: StoreClosure }>(`/api/stores/${id}/closures`, { method: "POST", body: { date, reason: reason || null } }),
  deleteClosure: (id: string, closureId: string) =>
    fetchApi<{ success: boolean }>(`/api/stores/${id}/closures/${closureId}`, { method: "DELETE" }),
};

// Staff
export type StaffUpdateData = Partial<Omit<Staff, 'notify_line'>> & {
  password?: string;
  notify_line?: boolean;
  line_user_id?: string;
};

export const staff = {
  list: (storeId?: string) =>
    fetchApi<{ staff: Staff[] }>(`/api/staff${storeId ? `?store_id=${storeId}` : ""}`),
  get: (id: string) => fetchApi<{ staff: Staff }>(`/api/staff/${id}`),
  create: (data: Partial<Staff> & { password: string }) =>
    fetchApi<{ staff: Staff }>("/api/staff", { method: "POST", body: data }),
  update: (id: string, data: StaffUpdateData) =>
    fetchApi<{ staff: Staff }>(`/api/staff/${id}`, { method: "PUT", body: data }),
  delete: (id: string) => fetchApi(`/api/staff/${id}`, { method: "DELETE" }),
  uploadAvatar: async (id: string, file: File) => {
    const token = tokenStorage.get();
    const formData = new FormData();
    formData.append("file", file);

    const res = await fetch(`${API_URL}/api/staff/${id}/avatar`, {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: formData,
    });

    const data = await res.json();
    if (!res.ok) {
      throw new ApiError(data.error || "An error occurred", res.status);
    }
    return data as { staff: Staff };
  },
  approveEmail: (staffId: string) =>
    fetchApi<{ success: boolean; message: string }>(`/api/staff/${staffId}/approve-email`, { method: "PUT" }),
  searchByCode: (code: string) =>
    fetchApi<{ staff: { id: string; name: string; email: string; role: string; staff_code: string; avatar_url: string | null; email_verified: number; store_id: string | null } }>(
      `/api/staff/search/code/${code}`
    ),
  linkByCode: (staffCode: string, storeId: string, role?: string) =>
    fetchApi<{ message: string; invitation: { id: string; staff_name: string; status: string } }>(
      "/api/staff/link-by-code",
      { method: "POST", body: { staff_code: staffCode, store_id: storeId, role: role || "staff" } }
    ),
  getStoreAssignments: () =>
    fetchApi<{ staff: { id: string; name: string; nickname: string | null; email: string; role: string; staff_code: string | null; avatar_url: string | null; stores: { id: string; name: string; is_primary: number; is_visible_to_customer: number }[] }[] }>(
      "/api/staff/store-assignments"
    ),
  getInvitations: () =>
    fetchApi<{ invitations: { id: string; staff_id: string; store_id: string; status: string; role: string; created_at: string; responded_at: string | null; store_name: string; staff_name: string; staff_code: string | null; avatar_url: string | null; invited_by_name: string }[] }>(
      "/api/staff/invitations/list"
    ),
  updateStores: (staffId: string, storeIds: string[], primaryStoreId?: string) =>
    fetchApi<{ stores: { id: string; name: string; is_primary: number }[] }>(
      `/api/staff/${staffId}/stores`,
      { method: "PUT", body: { store_ids: storeIds, primary_store_id: primaryStoreId } }
    ),
  updateStoreVisibility: (staffId: string, storeId: string, isVisible: boolean) =>
    fetchApi<{ success: boolean }>(
      "/api/staff/store-visibility",
      { method: "PUT", body: { staff_id: staffId, store_id: storeId, is_visible_to_customer: isVisible } }
    ),
  reorder: (storeId: string, items: { staff_id: string; sort_order: number }[]) =>
    fetchApi<{ success: boolean; updated: number }>(
      "/api/staff/reorder",
      { method: "PUT", body: { store_id: storeId, items } }
    ),
  importFromJson: (storeId: string, staff: { name: string; role: string; avatar_url?: string }[]) =>
    fetchApi<{ success: boolean; message: string; created: number; skipped: number; total: number }>(
      "/api/staff/import/json",
      { method: "POST", body: { store_id: storeId, staff } }
    ),
  bulkUpdateLimeName: (mappings: { staff_id: string; lime_name: string }[]) =>
    fetchApi<{ success: boolean; updated: number }>(
      "/api/staff/bulk-lime-name",
      { method: "PUT", body: { mappings } }
    ),
  importAvatarFromUrl: (staffId: string, url: string) =>
    fetchApi<{ success: boolean; avatar_url: string }>(
      `/api/staff/${staffId}/avatar-from-url`,
      { method: "POST", body: { url } }
    ),
  getBusinessHours: (staffId: string, storeId: string) =>
    fetchApi<{ business_hours: StaffBusinessHours[] }>(
      `/api/staff/${staffId}/business-hours?store_id=${storeId}`
    ),
  updateBusinessHours: (staffId: string, storeId: string, hours: { day_of_week: number; open_time: string | null; close_time: string | null; is_closed: boolean }[]) =>
    fetchApi<{ business_hours: StaffBusinessHours[] }>(
      `/api/staff/${staffId}/business-hours`,
      { method: "PUT", body: { store_id: storeId, hours } }
    ),
  copyStoreHours: (staffId: string, storeId: string) =>
    fetchApi<{ business_hours: StaffBusinessHours[] }>(
      `/api/staff/${staffId}/business-hours/copy-store`,
      { method: "POST", body: { store_id: storeId } }
    ),
  getReservationSettings: (staffId: string, storeId: string) =>
    fetchApi<{ settings: StaffReservationSettings }>(
      `/api/staff/${staffId}/reservation-settings?store_id=${storeId}`
    ),
  updateReservationSettings: (staffId: string, storeId: string, settings: Partial<StaffReservationSettings>) =>
    fetchApi<{ settings: StaffReservationSettings }>(
      `/api/staff/${staffId}/reservation-settings`,
      { method: "PUT", body: { store_id: storeId, ...settings } }
    ),
};

// Customers
export const customers = {
  list: (params?: { store_id?: string; staff_id?: string; search?: string; unassigned?: boolean; limit?: number; offset?: number }) => {
    const searchParams = new URLSearchParams();
    if (params?.store_id) searchParams.set("store_id", params.store_id);
    if (params?.staff_id) searchParams.set("staff_id", params.staff_id);
    if (params?.search) searchParams.set("search", params.search);
    if (params?.unassigned) searchParams.set("unassigned", "true");
    if (params?.limit) searchParams.set("limit", String(params.limit));
    if (params?.offset) searchParams.set("offset", String(params.offset));
    return fetchApi<{ customers: Customer[]; total: number; limit: number; offset: number }>(`/api/customers?${searchParams}`);
  },
  get: (id: string) =>
    fetchApi<{
      customer: Customer;
      assigned_staff: AssignedStaff[];
      line: { display_name: string; picture_url: string } | null;
      reservations: Reservation[];
      karutes: Karute[];
    }>(`/api/customers/${id}`),
  create: (data: Partial<Customer>) =>
    fetchApi<{ customer: Customer }>("/api/customers", { method: "POST", body: data }),
  update: (id: string, data: Partial<Customer>) =>
    fetchApi<{ customer: Customer }>(`/api/customers/${id}`, { method: "PUT", body: data }),
  assignStaff: (id: string, staffId: string | null) =>
    fetchApi<{ customer: Customer }>(`/api/customers/${id}/staff`, {
      method: "PUT",
      body: { staff_id: staffId },
    }),
  assignStaffMultiple: (id: string, staffIds: string[]) =>
    fetchApi<{ customer: Customer }>(`/api/customers/${id}/staff`, {
      method: "PUT",
      body: { staff_ids: staffIds },
    }),
  delete: (id: string) => fetchApi(`/api/customers/${id}`, { method: "DELETE" }),
  importFromJson: (storeId: string, customers: {
    staffName: string;
    customerName: string;
    nameKana?: string;
    gender?: string;
    birthday?: string;
    origin?: string;
    occupation?: string;
    postalCode?: string;
    phone?: string;
    email?: string;
    address?: string;
  }[]) =>
    fetchApi<{
      success: boolean;
      message: string;
      created: number;
      updated: number;
      skipped: number;
      staffNotFound: string[];
      total: number;
    }>("/api/customers/import/json", {
      method: "POST",
      body: { store_id: storeId, customers },
    }),
  deleteAll: (storeId: string) =>
    fetchApi<{ success: boolean; deleted: number }>(
      `/api/customers/all?store_id=${storeId}`,
      { method: "DELETE" }
    ),
  nameDuplicates: (opts?: { store_id?: string; search?: string; limit?: number; offset?: number }) => {
    const params = new URLSearchParams();
    if (opts?.store_id) params.set("store_id", opts.store_id);
    if (opts?.search) params.set("search", opts.search);
    if (opts?.limit) params.set("limit", String(opts.limit));
    if (opts?.offset) params.set("offset", String(opts.offset));
    return fetchApi<{ groups: NameDuplicateGroup[]; total: number }>(`/api/customers/name-duplicates?${params}`);
  },
  dismissNameDuplicate: (storeId: string, normalizedName: string) =>
    fetchApi<{ success: boolean }>("/api/customers/name-duplicates/dismiss", {
      method: "POST",
      body: { store_id: storeId, normalized_name: normalizedName },
    }),
  merge: (keepId: string, mergeId: string) =>
    fetchApi<{ success: boolean }>("/api/customers/merge", {
      method: "POST",
      body: { keep_id: keepId, merge_id: mergeId },
    }),
  linkMaster: (customerIds: string[]) =>
    fetchApi<{ success: boolean; master_id: string; member_no: string }>("/api/customers/link-master", {
      method: "POST",
      body: { customer_ids: customerIds },
    }),
  unlinkMaster: (customerId: string) =>
    fetchApi<{ success: boolean; master_id: string; member_no: string }>("/api/customers/unlink-master", {
      method: "POST",
      body: { customer_id: customerId },
    }),
};

export type NameDuplicateGroup = {
  normalized_name: string;
  customers: (Customer & { store_name?: string })[];
};

export type WalkinIntake = {
  id: string;
  customer_name: string;
  customer_name_kana: string | null;
  customer_phone: string | null;
  customer_birthday: string | null;
  staff_id: string | null;
  staff_name: string | null;
  status: string;
  consent_submitted_at: string | null;
  counseling_submitted_at: string | null;
  has_counseling: number;
};

export const walkinIntakes = {
  list: (storeId: string, opts?: { q?: string; status?: string }) => {
    const params = new URLSearchParams({ store_id: storeId });
    if (opts?.q) params.set("q", opts.q);
    if (opts?.status) params.set("status", opts.status);
    return fetchApi<{ intakes: WalkinIntake[] }>(`/api/walkin-intakes?${params}`);
  },
  get: (id: string) =>
    fetchApi<{ intake: WalkinIntake & { counseling_data: Record<string, Record<string, unknown>> | null; consent_snapshot: { title?: string; version?: string; sections?: { title: string; items?: string[]; content?: string }[]; agreed_at?: string } | null } }>(`/api/walkin-intakes/${id}`),
  link: (id: string, customerId: string) =>
    fetchApi<{ success: boolean; customer_id: string }>(`/api/walkin-intakes/${id}/link`, { method: "POST", body: { customer_id: customerId } }),
  create: (id: string, data?: { name?: string; name_kana?: string; phone?: string; birthday?: string; gender?: string }) =>
    fetchApi<{ success: boolean; customer_id: string }>(`/api/walkin-intakes/${id}/create`, { method: "POST", body: data || {} }),
  discard: (id: string) =>
    fetchApi<{ success: boolean }>(`/api/walkin-intakes/${id}/discard`, { method: "POST" }),
};

// Menu Categories
export const menuCategories = {
  list: (storeId?: string) =>
    fetchApi<{ categories: MenuCategory[] }>(
      `/api/menu-categories${storeId ? `?store_id=${storeId}` : ""}`
    ),
  get: (id: string) => fetchApi<{ category: MenuCategory }>(`/api/menu-categories/${id}`),
  create: (data: Partial<MenuCategory>) =>
    fetchApi<{ category: MenuCategory }>("/api/menu-categories", { method: "POST", body: data }),
  update: (id: string, data: Partial<MenuCategory>) =>
    fetchApi<{ category: MenuCategory }>(`/api/menu-categories/${id}`, { method: "PUT", body: data }),
  delete: (id: string) => fetchApi(`/api/menu-categories/${id}`, { method: "DELETE" }),
  deleteAll: (storeId: string) =>
    fetchApi<{ success: boolean; deleted: number }>(`/api/menu-categories/all?store_id=${storeId}`, { method: "DELETE" }),
};

// Menus
export const menus = {
  list: (storeId?: string, activeOnly = true) => {
    const params = new URLSearchParams();
    if (storeId) params.set("store_id", storeId);
    if (!activeOnly) params.set("active", "false");
    return fetchApi<{ menus: Menu[]; byCategory: Record<string, Menu[]>; categoryColors: Record<string, string> }>(`/api/menus?${params}`);
  },
  get: (id: string) => fetchApi<{ menu: Menu }>(`/api/menus/${id}`),
  create: (data: Partial<Menu>) =>
    fetchApi<{ menu: Menu }>("/api/menus", { method: "POST", body: data }),
  update: (id: string, data: Partial<Menu>) =>
    fetchApi<{ menu: Menu }>(`/api/menus/${id}`, { method: "PUT", body: data }),
  delete: (id: string, force?: boolean) =>
    fetchApi<{ success: boolean; soft_deleted?: boolean; has_reservations?: boolean; reservation_count?: number; message?: string }>(
      `/api/menus/${id}${force ? '?force=true' : ''}`, { method: "DELETE" }
    ),
  reorder: (items: { id: string; sort_order: number }[]) =>
    fetchApi<{ success: boolean; updated: number }>(
      "/api/menus/reorder",
      { method: "PUT", body: { items } }
    ),
  deleteAll: (storeId: string) =>
    fetchApi<{ success: boolean; deleted: number }>("/api/menus/all", { method: "DELETE", body: { store_id: storeId } }),
  importFromJson: (storeId: string, menus: { name: string; category: string; price: number; duration: number }[]) =>
    fetchApi<{ success: boolean; message: string; created: number; skipped: number; total: number }>(
      "/api/menus/import/json",
      { method: "POST", body: { store_id: storeId, menus } }
    ),
  importImageFromUrl: (id: string, url: string) =>
    fetchApi<{ menu: Menu }>(`/api/menus/${id}/image-from-url`, {
      method: "POST",
      body: { url },
    }),
  uploadImage: async (id: string, file: File) => {
    const token = tokenStorage.get();
    const formData = new FormData();
    formData.append("file", file);

    const res = await fetch(`${API_URL}/api/menus/${id}/image`, {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: formData,
    });

    const data = await res.json();
    if (!res.ok) {
      throw new ApiError(data.error || "An error occurred", res.status);
    }
    return data as { menu: Menu };
  },
  getStaff: (menuId: string) =>
    fetchApi<{ staff_ids: string[] }>(`/api/menus/${menuId}/staff`),
  updateStaff: (menuId: string, staffIds: string[]) =>
    fetchApi<{ success: boolean; staff_ids: string[] }>(
      `/api/menus/${menuId}/staff`,
      { method: "PUT", body: { staff_ids: staffIds } }
    ),
  bulkUpdateStaffAssignments: (storeId: string, assignments: { menu_id: string; staff_ids: string[] }[]) =>
    fetchApi<{ success: boolean; updated: number }>(
      "/api/menus/staff-assignments",
      { method: "PUT", body: { store_id: storeId, assignments } }
    ),
  importStaffAssignments: (storeId: string, assignments: { menuName: string; noStaffNeeded: boolean; assignedStaff: string[] }[]) =>
    fetchApi<{ success: boolean; message: string; updated: number; menuNotFound: string[]; staffNotFound: string[] }>(
      "/api/menus/import/staff-assignments",
      { method: "POST", body: { store_id: storeId, assignments } }
    ),
  getEquipment: (menuId: string) =>
    fetchApi<{ equipment_ids: string[] }>(`/api/menus/${menuId}/equipment`),
  updateEquipment: (menuId: string, equipmentIds: string[]) =>
    fetchApi<{ success: boolean; equipment_ids: string[] }>(
      `/api/menus/${menuId}/equipment`,
      { method: "PUT", body: { equipment_ids: equipmentIds } }
    ),
  bulkUpdateEquipmentAssignments: (storeId: string, assignments: { menu_id: string; equipment_ids: string[] }[]) =>
    fetchApi<{ success: boolean; updated: number }>(
      "/api/menus/equipment-assignments",
      { method: "PUT", body: { store_id: storeId, assignments } }
    ),
  importEquipmentAssignments: (storeId: string, assignments: { menuName: string; assignedEquipment: string[] }[]) =>
    fetchApi<{ success: boolean; message: string; updated: number; menuNotFound: string[]; equipNotFound: string[] }>(
      "/api/menus/import/equipment-assignments",
      { method: "POST", body: { store_id: storeId, assignments } }
    ),
};

// Equipment
export const equipment = {
  list: (storeId?: string, activeOnly = true) => {
    const params = new URLSearchParams();
    if (storeId) params.set("store_id", storeId);
    if (!activeOnly) params.set("active", "false");
    return fetchApi<{ equipment: Equipment[] }>(`/api/equipment?${params}`);
  },
  create: (data: { store_id: string; name: string; quantity?: number; sort_order?: number }) =>
    fetchApi<{ equipment: Equipment }>("/api/equipment", { method: "POST", body: data }),
  update: (id: string, data: { name?: string; quantity?: number; is_active?: boolean; sort_order?: number }) =>
    fetchApi<{ equipment: Equipment }>(`/api/equipment/${id}`, { method: "PUT", body: data }),
  delete: (id: string) =>
    fetchApi<{ success: boolean }>(`/api/equipment/${id}`, { method: "DELETE" }),
};

// Reservations
export const reservations = {
  list: (params?: {
    store_id?: string;
    date?: string;
    start_date?: string;
    end_date?: string;
    staff_id?: string;
    status?: string;
    search?: string;
    sort?: string;
    limit?: number;
    offset?: number;
  }) => {
    const searchParams = new URLSearchParams();
    if (params?.store_id) searchParams.set("store_id", params.store_id);
    if (params?.date) searchParams.set("date", params.date);
    if (params?.start_date) searchParams.set("start_date", params.start_date);
    if (params?.end_date) searchParams.set("end_date", params.end_date);
    if (params?.staff_id) searchParams.set("staff_id", params.staff_id);
    if (params?.status) searchParams.set("status", params.status);
    if (params?.search) searchParams.set("search", params.search);
    if (params?.sort) searchParams.set("sort", params.sort);
    if (params?.limit) searchParams.set("limit", String(params.limit));
    if (params?.offset) searchParams.set("offset", String(params.offset));
    return fetchApi<{ reservations: Reservation[]; total: number }>(`/api/reservations?${searchParams}`);
  },
  get: (id: string) => fetchApi<{ reservation: Reservation }>(`/api/reservations/${id}`),
  create: (data: Partial<Reservation>) =>
    fetchApi<{ reservation: Reservation }>("/api/reservations", { method: "POST", body: data }),
  update: (id: string, data: Partial<Reservation>) =>
    fetchApi<{ reservation: Reservation }>(`/api/reservations/${id}`, { method: "PUT", body: data }),
  confirm: (id: string) =>
    fetchApi<{ success: boolean }>(`/api/reservations/${id}/confirm`, { method: "PUT" }),
  complete: (id: string) =>
    fetchApi<{ success: boolean }>(`/api/reservations/${id}/complete`, { method: "PUT" }),
  cancel: (id: string, reason?: string) =>
    fetchApi<{ success: boolean }>(`/api/reservations/${id}/cancel`, {
      method: "PUT",
      body: { cancel_reason: reason },
    }),
  getConsent: (id: string) =>
    fetchApi<{ consent: ConsentRecord }>(`/api/reservations/${id}/consent`),
  syncToSalonboard: (id: string) =>
    fetchApi<{ success: boolean; message: string }>(`/api/reservations/${id}/sync-salonboard`, {
      method: "POST",
    }),
  deleteAll: (storeId: string) =>
    fetchApi<{ success: boolean; deleted: number }>("/api/reservations/all", { method: "DELETE", body: { store_id: storeId } }),
  importCsv: (storeId: string, reservations: CsvReservation[]) =>
    fetchApi<{
      success: boolean;
      results: {
        imported: number;
        skipped: number;
        customers_created: number;
        menus_created: number;
        errors: { row: number; hotpepper_id: string; error: string }[];
      };
    }>("/api/reservations/import", {
      method: "POST",
      body: { store_id: storeId, reservations },
      timeout: 120000,
    }),
  bulkUpdateLime: (storeId: string, items: { date: string; time: string; name: string; menu: string; is_new: boolean }[]) =>
    fetchApi<{
      success: boolean;
      updated: number;
      not_found: { date: string; time: string; name: string }[];
    }>("/api/reservations/bulk-update-lime", {
      method: "PUT",
      body: { store_id: storeId, items },
      timeout: 120000,
    }),
};

// Karutes
export const karutes = {
  list: (params?: { customer_id?: string; staff_id?: string }) => {
    const searchParams = new URLSearchParams();
    if (params?.customer_id) searchParams.set("customer_id", params.customer_id);
    if (params?.staff_id) searchParams.set("staff_id", params.staff_id);
    return fetchApi<{ karutes: Karute[] }>(`/api/karutes?${searchParams}`);
  },
  get: (id: string) => fetchApi<{ karute: Karute; images: KaruteImage[] }>(`/api/karutes/${id}`),
  create: (data: Partial<Karute>) =>
    fetchApi<{ karute: Karute }>("/api/karutes", { method: "POST", body: data }),
  update: (id: string, data: Partial<Karute>) =>
    fetchApi<{ karute: Karute }>(`/api/karutes/${id}`, { method: "PUT", body: data }),
  share: (id: string) => fetchApi<{ success: boolean }>(`/api/karutes/${id}/share`, { method: "POST" }),
};

// Counseling Sheets
export type CounselingSheet = {
  id: string;
  store_id: string;
  customer_id: string;
  data: Record<string, Record<string, string | string[]>>;
  created_at: string;
  updated_at: string;
};

export const counselingSheets = {
  get: (customerId: string, storeId?: string) => {
    const params = storeId ? `?store_id=${storeId}` : '';
    return fetchApi<{ counseling_sheet: CounselingSheet | null }>(`/api/counseling-sheets/${customerId}${params}`);
  },
  save: (customerId: string, data: Record<string, Record<string, string | string[]>>, storeId?: string) => {
    const params = storeId ? `?store_id=${storeId}` : '';
    return fetchApi<{ counseling_sheet: CounselingSheet }>(`/api/counseling-sheets/${customerId}${params}`, {
      method: "PUT",
      body: { data },
    });
  },
};

// Messages
// Merge Candidates
export const mergeCandidates = {
  list: (storeId: string) =>
    fetchApi<{ candidates: MergeCandidate[] }>(`/api/merge-candidates?store_id=${storeId}`),
  listByCustomer: (customerId: string, storeId: string) =>
    fetchApi<{ candidates: MergeCandidate[] }>(`/api/merge-candidates?store_id=${storeId}&customer_id=${customerId}`),
  count: (storeId: string) =>
    fetchApi<{ count: number }>(`/api/merge-candidates/count?store_id=${storeId}`),
  merge: (id: string) =>
    fetchApi<{ success: boolean }>(`/api/merge-candidates/${id}/merge`, { method: "POST" }),
  skip: (id: string) =>
    fetchApi<{ success: boolean }>(`/api/merge-candidates/${id}/skip`, { method: "POST" }),
};

export const messages = {
  conversations: (unreadOnly = false, mineOnly = false, storeId?: string) => {
    const params = new URLSearchParams();
    if (unreadOnly) params.set('unread', 'true');
    if (mineOnly) params.set('mine', 'true');
    if (storeId) params.set('store_id', storeId);
    return fetchApi<{ conversations: Conversation[] }>(`/api/messages?${params}`);
  },
  get: (customerId: string, storeId?: string) => {
    const params = new URLSearchParams();
    if (storeId) params.set('store_id', storeId);
    return fetchApi<{ messages: Message[]; customer: Customer; line: { display_name: string; picture_url: string } | null }>(
      `/api/messages/${customerId}?${params}`
    );
  },
  send: (customerId: string, content: string, sendToLine = false, storeId?: string) =>
    fetchApi<{ message: Message }>(`/api/messages/${customerId}`, {
      method: "POST",
      body: { content, send_to_line: sendToLine, store_id: storeId },
    }),
  markRead: (customerId: string, storeId?: string) => {
    const params = new URLSearchParams();
    if (storeId) params.set('store_id', storeId);
    return fetchApi<{ success: boolean }>(`/api/messages/${customerId}/read?${params}`, { method: "PUT" });
  },
  unreadCount: () => fetchApi<{ count: number }>("/api/messages/unread/count"),
};

// Types
export type Staff = {
  id: string;
  store_id: string | null;
  name: string;
  nickname?: string | null;
  email: string;
  role: "system_admin" | "owner" | "manager" | "staff";
  avatar_url: string | null;
  is_active: number;
  is_visible_to_customer: number;
  email_verified: number;
  notify_line?: number;
  line_user_id?: string;
  salonboard_staff_id?: string | null;
  salonboard_name?: string | null;
  lime_name?: string | null;
  staff_line_channel_id?: string | null;
  staff_line_channel_secret?: string | null;
  staff_line_access_token?: string | null;
  login_id?: string | null;
  onboarding_completed?: number;
  staff_code?: string | null;
  owner_type?: 'individual' | 'company' | null;
  company_name?: string | null;
  company_postal_code?: string | null;
  company_phone?: string | null;
  company_address?: string | null;
  company_email?: string | null;
  retired_at: string | null;
  created_at: string;
};

export type Store = {
  id: string;
  name: string;
  postal_code: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  line_channel_id: string | null;
  line_channel_secret: string | null;
  line_access_token: string | null;
  line_liff_id: string | null;
  line_friend_url: string | null;
  // Hot Pepper Beauty (Salonboard) integration
  salonboard_id: string | null;
  salonboard_password: string | null;
  salonboard_enabled: number;
  hpb_email: string | null;
  // LiME integration
  lime_id: string | null;
  lime_password: string | null;
  // Seat capacity
  seat_limit: number;
  enable_seat_alert: number;
  // Reservation settings (store-level defaults)
  advance_booking_days: number;
  advance_booking_months: number;
  same_day_cutoff_hours: number;
  max_concurrent: number;
  accept_same_start_time: number;
  accept_outside_hours: number;
  // Booking period settings (受付期間設定)
  booking_cutoff_type: string;
  booking_cutoff_days_before: number;
  booking_cutoff_time: string | null;
  booking_cutoff_same_day_minutes: number;
  booking_calc_method: string;
  holiday_hours_enabled: number;
};

export type BusinessHours = {
  day_of_week: number;
  open_time: string | null;
  close_time: string | null;
  is_closed: number;
  max_concurrent: number | null;
};

export type StoreClosure = {
  id: string;
  store_id: string;
  date: string;
  reason: string | null;
  created_at: string;
};

export type StaffBusinessHours = {
  day_of_week: number;
  open_time: string | null;
  close_time: string | null;
  is_closed: number;
};

export type StaffReservationSettings = {
  staff_id?: string;
  advance_booking_days: number;
  same_day_cutoff_hours: number;
  max_concurrent: number;
  accept_same_start_time: number;
  accept_outside_hours: number;
  // Booking period settings (NULL = store fallback)
  booking_cutoff_type?: string | null;
  booking_cutoff_days_before?: number | null;
  booking_cutoff_time?: string | null;
  booking_cutoff_same_day_minutes?: number | null;
  booking_calc_method?: string | null;
};

export type Customer = {
  id: string;
  store_id: string;
  staff_id: string | null;
  staff_name?: string | null;
  staff_names?: string | null;
  name: string;
  name_kana: string | null;
  phone: string | null;
  email: string | null;
  gender: "male" | "female" | "other" | null;
  birthday: string | null;
  occupation: string | null;
  postal_code: string | null;
  address: string | null;
  memo: string | null;
  visit_count: number;
  origin: "staff" | "store";
  last_visit_at: string | null;
  created_at: string;
  has_line?: number;
  master_id?: string | null;
  member_no?: string | null;
};

export type AssignedStaff = {
  staff_id: string;
  is_primary: number;
  staff_name: string;
};

export type MenuCategory = {
  id: string;
  store_id: string;
  name: string;
  color: string;
  sort_order: number;
  parent_id: string | null;
  salonboard_equipment_id: string | null;
  created_at: string;
  updated_at: string;
};

export type Menu = {
  id: string;
  store_id: string;
  category: string;
  name: string;
  description: string | null;
  image_url: string | null;
  duration: number;
  price: number;
  price_new: number | null;
  sort_order: number;
  coupon_type: 'new' | 'repeat' | 'all' | null;
  is_active: number;
  menu_type: 'regular' | 'coupon';
  presentation_condition: string | null;
  usage_condition: string | null;
  expiry_date: string | null;
  sub_categories: string | null;
  price_tilde: number;
  assigned_staff_ids?: string[];
  assigned_equipment_ids?: string[];
};

export type CsvReservation = {
  status: string;
  hotpepper_id: string;
  staff_name: string;
  equipment_name?: string | null;
  visit_date: string;
  start_time: string;
  end_time: string;
  duration: number;
  source: string;
  menu_category?: string | null;
  menu_name?: string | null;
  coupon_name?: string | null;
  nomination_type?: string | null;
  customer_name: string;
  customer_name_kana?: string | null;
  customer_phone?: string | null;
  customer_number?: string | null;
  amount?: number;
  memo?: string | null;
};

export type Reservation = {
  id: string;
  store_id: string;
  customer_id: string;
  customer_name?: string;
  customer_phone?: string;
  staff_id: string;
  staff_name?: string;
  menu_id: string;
  menu_ids?: string[];
  menu_data?: { id?: string | null; name?: string; duration?: number; price?: number }[];
  menu_name?: string;
  duration?: number;
  price?: number;
  menus?: { id: string; name: string; duration: number; price: number }[];
  total_duration?: number;
  total_price?: number;
  start_at: string;
  end_at: string;
  status: "pending" | "confirmed" | "completed" | "cancelled" | "noshow";
  memo: string | null;
  source: "web" | "line" | "phone" | "walk-in" | "hotpepper" | "minimo";
  hotpepper_id?: string | null;
  customer_visit_count?: number;
  store_name?: string;
  salonboard_synced?: number; // 0=not synced, 1=synced, -1=error
  salonboard_synced_at?: string | null;
  salonboard_sync_error?: string | null;
  salonboard_reserve_id?: string | null;
  salonboard_route?: string | null;
  is_nominated?: number; // 1=指名, 0=フリー
  is_new_customer?: number | null; // 1=新規, 0=リピーター
  merge_candidate_count?: number;
  last_activity_at?: string | null;
  has_consent?: boolean;
};

export type ConsentRecord = {
  id: string;
  template_id: string;
  store_id: string;
  customer_name: string;
  customer_birthday?: string | null;
  customer_phone?: string | null;
  customer_occupation?: string | null;
  customer_visit_reason?: string | null;
  template_snapshot?: {
    title: string;
    version?: string | null;
    sections: { title: string; content: string }[];
  } | null;
  agreed_at: string;
};

export type Karute = {
  id: string;
  store_id: string;
  customer_id: string;
  customer_name?: string;
  staff_id: string;
  staff_name?: string;
  reservation_id?: string | null;
  visit_date: string;
  menu_content: string | null;
  hair_condition: string | null;
  color_formula: string | null;
  perm_info: string | null;
  styling_notes: string | null;
  customer_feedback: string | null;
  next_suggestion: string | null;
  internal_memo: string | null;
  face_drawing: string | null;
  is_shared_to_customer: number;
  image_count?: number;
};

export type KaruteImage = {
  id: string;
  image_url: string;
  image_type: "before" | "after" | "other";
  caption: string | null;
};

export type Message = {
  id: string;
  customer_id: string;
  staff_id: string | null;
  staff_name?: string | null;
  sent_by_staff_name?: string | null;
  direction: "incoming" | "outgoing" | "system";
  message_type: string;
  content: string | null;
  source: "line" | "web";
  is_read: number;
  sent_at: string;
};

export type Equipment = {
  id: string;
  store_id: string;
  name: string;
  quantity: number;
  is_active: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

export type Conversation = {
  customer_id: string;
  customer_name: string;
  customer_staff_id: string | null;
  customer_staff_name: string | null;
  customer_avatar: string | null;
  last_message: string | null;
  last_message_at: string | null;
  last_message_direction: "incoming" | "outgoing" | "system";
  last_message_staff_name: string | null;
  unread_count: number;
};

export type MergeCandidate = {
  id: string;
  store_id: string;
  line_customer_id: string;
  existing_customer_id: string;
  line_display_name: string | null;
  match_type: "name" | "phone" | "name_kana";
  status: "pending" | "merged" | "skipped";
  created_at: string;
  line_customer_name: string;
  line_customer_phone: string | null;
  line_customer_visit_count: number;
  line_customer_avatar: string | null;
  existing_customer_name: string;
  existing_customer_name_kana: string | null;
  existing_customer_phone: string | null;
  existing_customer_email: string | null;
  existing_customer_visit_count: number;
  existing_customer_last_visit_at: string | null;
  existing_customer_staff_id: string | null;
  existing_customer_staff_name: string | null;
};
