const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8787";
const TOKEN_KEY = "staff_token";

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
  const { method = "GET", body, headers = {} } = options;
  const token = tokenStorage.get();

  const requestHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    ...headers,
  };

  // Fallback: use localStorage token if cookie not yet set (legacy sessions)
  if (token) {
    requestHeaders["Authorization"] = `Bearer ${token}`;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  try {
    const res = await fetch(`${API_URL}${endpoint}`, {
      method,
      headers: requestHeaders,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
      credentials: "include",
    });

    clearTimeout(timeoutId);

    if (res.status === 401) {
      tokenStorage.remove();
      if (typeof window !== "undefined" && !endpoint.includes("/auth/")) {
        window.location.href = "/login";
      }
      throw new ApiError("Unauthorized", 401);
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
    const result = await fetchApi<{ staff: Staff; token: string }>("/api/auth/login", {
      method: "POST",
      body: { email, password },
    });
    if (result.token) {
      tokenStorage.set(result.token);
    }
    return result;
  },
  logout: async () => {
    tokenStorage.remove();
    return fetchApi("/api/auth/logout", { method: "POST" });
  },
  me: () => fetchApi<{ staff: Staff; store: Store | null; stores: Array<{ id: string; name: string; is_primary: number; line_friend_url: string | null }>; pending_invitations: Array<{ id: string; store_id: string; store_name: string; invited_by_name: string; role: string; created_at: string }> }>("/api/auth/me"),
  register: (data: { name: string; email: string; password: string }) =>
    fetchApi<{ message: string; staff_code: string }>("/api/auth/register", {
      method: "POST",
      body: data,
    }),
  verifyEmail: (token: string) =>
    fetchApi<{ message: string }>("/api/auth/verify-email", {
      method: "POST",
      body: { token },
    }),
  resendVerification: (email: string) =>
    fetchApi<{ message: string }>("/api/auth/resend-verification", {
      method: "POST",
      body: { email },
    }),
  forgotPassword: (email: string) =>
    fetchApi<{ message: string; registered?: boolean }>("/api/auth/forgot-password", {
      method: "POST",
      body: { email },
    }),
  resetPassword: (token: string, password: string) =>
    fetchApi<{ message: string }>("/api/auth/reset-password", {
      method: "POST",
      body: { token, password },
    }),
  updateProfile: (data: { nickname?: string | null; avatar_url?: string; minimo_name?: string | null }) =>
    fetchApi<{ success: boolean }>("/api/auth/profile", {
      method: "PUT",
      body: data,
    }),
};

// Stores (read-only)
export const stores = {
  get: (id: string) => fetchApi<{ store: Store; business_hours: BusinessHours[] }>(`/api/stores/${id}`),
};

// Staff
export const staffApi = {
  list: (storeId?: string) =>
    fetchApi<{ staff: Staff[] }>(`/api/staff${storeId ? `?store_id=${storeId}` : ""}`),
  update: (id: string, data: Record<string, unknown>) =>
    fetchApi<{ staff: Staff }>(`/api/staff/${id}`, { method: "PUT", body: data }),
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
  searchByCode: (code: string) =>
    fetchApi<{ staff: { id: string; name: string; email: string; role: string; staff_code: string; avatar_url: string | null; email_verified: number } }>(
      `/api/staff/search/code/${code}`
    ),
  linkByCode: (staffCode: string, storeId: string, role?: string) =>
    fetchApi<{ message: string; invitation: { id: string; staff_name: string; status: string } }>(
      "/api/staff/link-by-code",
      { method: "POST", body: { staff_code: staffCode, store_id: storeId, role: role || "staff" } }
    ),
  updateStoreVisibility: (staffId: string, storeId: string, isVisible: boolean) =>
    fetchApi<{ success: boolean }>(
      "/api/staff/store-visibility",
      { method: "PUT", body: { staff_id: staffId, store_id: storeId, is_visible_to_customer: isVisible } }
    ),
};

// Invitations
export const invitations = {
  accept: (id: string) =>
    fetchApi<{ message: string }>(`/api/staff/invitations/${id}/accept`, { method: "POST" }),
  reject: (id: string) =>
    fetchApi<{ message: string }>(`/api/staff/invitations/${id}/reject`, { method: "POST" }),
};

// Customers
export const customers = {
  list: (params?: { store_id?: string; staff_id?: string; search?: string; limit?: number; offset?: number }) => {
    const searchParams = new URLSearchParams();
    if (params?.store_id) searchParams.set("store_id", params.store_id);
    if (params?.staff_id) searchParams.set("staff_id", params.staff_id);
    if (params?.search) searchParams.set("search", params.search);
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
  crossStoreMatches: (phone: string, excludeStoreId?: string) => {
    const params = new URLSearchParams({ phone });
    if (excludeStoreId) params.set("exclude_store_id", excludeStoreId);
    return fetchApi<{ matches: CrossStoreMatch[] }>(`/api/customers/cross-store-matches?${params}`);
  },
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
  duplicates: (opts?: { search?: string; limit?: number; offset?: number }) => {
    const params = new URLSearchParams();
    if (opts?.search) params.set("search", opts.search);
    if (opts?.limit) params.set("limit", String(opts.limit));
    if (opts?.offset) params.set("offset", String(opts.offset));
    return fetchApi<{ groups: DuplicateGroup[]; total: number }>(`/api/customers/duplicates?${params}`);
  },
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
  assignStaff: (customerId: string, staffId: string | null) =>
    fetchApi<{ customer: Customer }>(`/api/customers/${customerId}/staff`, {
      method: "PUT",
      body: { staff_id: staffId },
    }),
  assignStaffMultiple: (customerId: string, staffIds: string[]) =>
    fetchApi<{ customer: Customer }>(`/api/customers/${customerId}/staff`, {
      method: "PUT",
      body: { staff_ids: staffIds },
    }),
};

export type NameDuplicateGroup = {
  normalized_name: string;
  customers: (Customer & { store_name?: string })[];
};

export type DuplicateGroup = {
  customers: (Customer & { store_name?: string; line_user_id?: string | null; line_display_name?: string | null })[];
  reasons: string[];
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
  byCustomer: (customerId: string) =>
    fetchApi<{ intakes: Array<{
      id: string;
      customer_name: string;
      counseling_data: Record<string, Record<string, unknown>> | null;
      status: string;
      consent_submitted_at: string | null;
      counseling_submitted_at: string | null;
      updated_at: string;
    }> }>(`/api/walkin-intakes/by-customer/${customerId}`),
};

export type Notification = {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link_url: string | null;
  is_read: number;
  created_at: string;
};

export const notifications = {
  list: () => fetchApi<{ notifications: Notification[] }>("/api/notifications"),
  unreadCount: () => fetchApi<{ count: number }>("/api/notifications/unread-count"),
  markRead: (id: string) => fetchApi<{ success: boolean }>(`/api/notifications/${id}/read`, { method: "PUT" }),
  markAllRead: () => fetchApi<{ success: boolean }>("/api/notifications/read-all", { method: "PUT" }),
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
  create: (data: Partial<Menu> & { store_id?: string }) =>
    fetchApi<{ menu: Menu }>("/api/menus", { method: "POST", body: data }),
  update: (id: string, data: Partial<Menu>) =>
    fetchApi<{ menu: Menu }>(`/api/menus/${id}`, { method: "PUT", body: data }),
  delete: (id: string, force?: boolean) =>
    fetchApi<{ success: boolean; soft_deleted?: boolean }>(
      `/api/menus/${id}${force ? '?force=true' : ''}`, { method: "DELETE" }
    ),
  reorder: (items: { id: string; sort_order: number }[]) =>
    fetchApi<{ success: boolean; updated: number }>(
      "/api/menus/reorder",
      { method: "PUT", body: { items } }
    ),
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
  bulkUpdateStaffAssignments: (storeId: string, assignments: { menu_id: string; staff_ids: string[] }[], selfOnly?: boolean) =>
    fetchApi<{ success: boolean; updated: number }>(
      "/api/menus/staff-assignments",
      { method: "PUT", body: { store_id: storeId, assignments, ...(selfOnly && { self_only: true }) } }
    ),
  bulkUpdateEquipmentAssignments: (storeId: string, assignments: { menu_id: string; equipment_ids: string[] }[]) =>
    fetchApi<{ success: boolean; updated: number }>(
      "/api/menus/equipment-assignments",
      { method: "PUT", body: { store_id: storeId, assignments } }
    ),
};

// Menu Categories
export const menuCategories = {
  list: (storeId?: string) => {
    const params = new URLSearchParams();
    if (storeId) params.set("store_id", storeId);
    return fetchApi<{ categories: MenuCategory[] }>(`/api/menu-categories?${params}`);
  },
  create: (data: Partial<MenuCategory> & { store_id: string }) =>
    fetchApi<{ category: MenuCategory }>("/api/menu-categories", { method: "POST", body: data }),
  update: (id: string, data: Partial<MenuCategory>) =>
    fetchApi<{ category: MenuCategory }>(`/api/menu-categories/${id}`, { method: "PUT", body: data }),
  delete: (id: string) => fetchApi(`/api/menu-categories/${id}`, { method: "DELETE" }),
  deleteAll: (storeId: string) =>
    fetchApi<{ success: boolean; deleted: number }>(`/api/menu-categories/all?store_id=${storeId}`, { method: "DELETE" }),
};

// Equipment
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

export const equipment = {
  list: (storeId?: string) => {
    const params = new URLSearchParams();
    if (storeId) params.set("store_id", storeId);
    return fetchApi<{ equipment: Equipment[] }>(`/api/equipment?${params}`);
  },
  menuMappings: (storeId: string) =>
    fetchApi<{ mappings: Record<string, string[]>; quantities: Record<string, number> }>(
      `/api/equipment/menu-mappings?store_id=${storeId}`
    ),
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
    sort?: string;
    limit?: string;
  }) => {
    const searchParams = new URLSearchParams();
    if (params?.store_id) searchParams.set("store_id", params.store_id);
    if (params?.date) searchParams.set("date", params.date);
    if (params?.start_date) searchParams.set("start_date", params.start_date);
    if (params?.end_date) searchParams.set("end_date", params.end_date);
    if (params?.staff_id) searchParams.set("staff_id", params.staff_id);
    if (params?.status) searchParams.set("status", params.status);
    if (params?.sort) searchParams.set("sort", params.sort);
    if (params?.limit) searchParams.set("limit", params.limit);
    return fetchApi<{ reservations: Reservation[] }>(`/api/reservations?${searchParams}`);
  },
  get: (id: string) => fetchApi<{ reservation: Reservation }>(`/api/reservations/${id}`),
  create: (data: Partial<Reservation> & { menu_ids?: string[]; menu_data?: { id?: string | null; name?: string; duration?: number; price?: number }[] }) =>
    fetchApi<{ reservation: Reservation }>("/api/reservations", { method: "POST", body: data }),
  update: (id: string, data: Partial<Reservation> & { menu_ids?: string[]; menu_data?: { id?: string | null; name?: string; duration?: number; price?: number }[] }) =>
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
  pendingCount: () =>
    fetchApi<{ count: number }>("/api/reservations/pending-count"),
  retiredStaff: () =>
    fetchApi<{ reservations: Reservation[] }>("/api/reservations/retired-staff"),
  retiredStaffCount: () =>
    fetchApi<{ count: number }>("/api/reservations/retired-staff/count"),
};

// Karutes
export const karutes = {
  list: (params?: { customer_id?: string; staff_id?: string; reservation_id?: string }) => {
    const searchParams = new URLSearchParams();
    if (params?.customer_id) searchParams.set("customer_id", params.customer_id);
    if (params?.staff_id) searchParams.set("staff_id", params.staff_id);
    if (params?.reservation_id) searchParams.set("reservation_id", params.reservation_id);
    return fetchApi<{ karutes: Karute[] }>(`/api/karutes?${searchParams}`);
  },
  get: (id: string) => fetchApi<{ karute: Karute; images: KaruteImage[]; menus: KaruteMenu[] }>(`/api/karutes/${id}`),
  create: (data: Partial<Karute> & { menu_ids?: string[] }) =>
    fetchApi<{ karute: Karute }>("/api/karutes", { method: "POST", body: data }),
  update: (id: string, data: Partial<Karute> & { menu_ids?: string[] }) =>
    fetchApi<{ karute: Karute }>(`/api/karutes/${id}`, { method: "PUT", body: data }),
  share: (id: string) => fetchApi<{ success: boolean }>(`/api/karutes/${id}/share`, { method: "POST" }),
  uploadImage: async (id: string, file: File, imageType: string = "other", caption?: string) => {
    const token = tokenStorage.get();
    const formData = new FormData();
    formData.append("file", file);
    formData.append("image_type", imageType);
    if (caption) formData.append("caption", caption);

    const res = await fetch(`${API_URL}/api/karutes/${id}/images`, {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: formData,
    });

    const data = await res.json();
    if (!res.ok) {
      throw new ApiError(data.error || "An error occurred", res.status);
    }
    return data as { image: KaruteImage };
  },
  delete: (id: string) =>
    fetchApi<{ success: boolean }>(`/api/karutes/${id}`, { method: "DELETE" }),
  deleteImage: (karuteId: string, imageId: string) =>
    fetchApi(`/api/karutes/${karuteId}/images/${imageId}`, { method: "DELETE" }),
  extractDates: (image: string, mediaType: string) =>
    fetchApi<{ visits: Array<{ date: string; time?: string; description?: string }> }>(
      "/api/karutes/extract-dates",
      { method: "POST", body: { image, mediaType } }
    ),
};

// Messages
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

// Counseling Sheets
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
  ocr: (image: string, mediaType: string, questions: Array<{
    id: string;
    label: string;
    type: string;
    options?: string[];
    sliderLabels?: [string, string];
    subFields?: Array<{ id: string; label: string }>;
  }>) =>
    fetchApi<{ data: Record<string, string | string[]> }>('/api/counseling-sheets/ocr', {
      method: "POST",
      body: { image, mediaType, questions },
    }),
};

// Staff Blocks (personal day off)
export const staffBlocks = {
  list: (params?: { staff_id?: string; store_id?: string; date_from?: string; date_to?: string }) => {
    const searchParams = new URLSearchParams();
    if (params?.staff_id) searchParams.set("staff_id", params.staff_id);
    if (params?.store_id) searchParams.set("store_id", params.store_id);
    if (params?.date_from) searchParams.set("date_from", params.date_from);
    if (params?.date_to) searchParams.set("date_to", params.date_to);
    return fetchApi<{ blocks: StaffBlock[] }>(`/api/staff-blocks?${searchParams}`);
  },
  create: (data: { staff_id?: string; store_id?: string | null; date: string; is_all_day?: boolean; start_time?: string; end_time?: string; reason?: string }) =>
    fetchApi<{ block: StaffBlock }>("/api/staff-blocks", { method: "POST", body: data }),
  update: (id: string, data: Partial<StaffBlock>) =>
    fetchApi<{ block: StaffBlock }>(`/api/staff-blocks/${id}`, { method: "PUT", body: data }),
  delete: (id: string) =>
    fetchApi<{ success: boolean }>(`/api/staff-blocks/${id}`, { method: "DELETE" }),
  sync: (data: { staff_id?: string; store_id?: string; month: string; dates: string[] }) =>
    fetchApi<{ blocks: StaffBlock[] }>("/api/staff-blocks/sync", { method: "PUT", body: data }),
};

// Staff Settings (business hours & reservation settings)
export const staffSettings = {
  getBusinessHours: (staffId: string, storeId: string) =>
    fetchApi<{ business_hours: StaffBusinessHours[] }>(
      `/api/staff/${staffId}/business-hours?store_id=${storeId}`
    ),
  updateBusinessHours: (staffId: string, storeId: string, hours: { day_of_week: number; open_time: string; close_time: string; is_closed: boolean }[]) =>
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
  updateReservationSettings: (staffId: string, storeId: string, settings: { advance_booking_days?: number; same_day_cutoff_hours?: number; max_concurrent?: number; accept_same_start_time?: number; accept_outside_hours?: number }) =>
    fetchApi<{ settings: StaffReservationSettings }>(
      `/api/staff/${staffId}/reservation-settings`,
      { method: "PUT", body: { store_id: storeId, ...settings } }
    ),
};

// Types
export type Staff = {
  id: string;
  store_id: string | null;
  name: string;
  nickname: string | null;
  email: string;
  role: "system_admin" | "owner" | "manager" | "staff";
  avatar_url: string | null;
  staff_code: string | null;
  minimo_name: string | null;
  salonboard_staff_id: string | null;
  is_active: number;
  notify_line: number;
  line_user_id: string | null;
  email_verified: number;
  is_visible_to_customer: number;
  retired_at: string | null;
  created_at: string;
};

export type Store = {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  email: string | null;
  line_friend_url: string | null;
  advance_booking_days: number;
  same_day_cutoff_hours: number;
  max_concurrent: number;
  accept_same_start_time: number;
  accept_outside_hours: number;
};

export type BusinessHours = {
  day_of_week: number;
  open_time: string | null;
  close_time: string | null;
  is_closed: number;
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
  last_staff_nickname: string | null;
  last_visit_date: string | null;
  store_name: string | null;
  created_at: string;
  has_line?: number;
  is_minimo?: number;
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

export type CrossStoreMatch = {
  customer_id: string;
  customer_name: string;
  customer_name_kana: string | null;
  phone: string;
  visit_count: number;
  last_visit_at: string | null;
  store_id: string;
  store_name: string;
};

export type ReservationMenu = {
  id: string;
  name: string;
  duration: number;
  price: number;
};

export type Reservation = {
  id: string;
  store_id: string;
  customer_id: string;
  customer_name?: string;
  customer_name_kana?: string | null;
  customer_phone?: string;
  staff_id: string;
  staff_name?: string;
  staff_nickname?: string | null;
  salonboard_staff_id?: string | null;
  store_salonboard_id?: string | null;
  menu_id: string;
  menu_name?: string;
  duration?: number;
  price?: number;
  menus?: ReservationMenu[];
  total_duration?: number;
  total_price?: number;
  start_at: string;
  end_at: string;
  status: "pending" | "confirmed" | "completed" | "cancelled" | "noshow";
  memo: string | null;
  source: "web" | "line" | "phone" | "walk-in" | "hotpepper" | "minimo";
  salonboard_route?: string | null;
  salonboard_synced?: number;
  salonboard_reserve_id?: string | null;
  salonboard_sync_error?: string | null;
  hotpepper_id?: string | null;
  customer_visit_count?: number;
  is_nominated?: number; // 1=指名, 0=フリー
  is_new_customer?: number | null; // 1=新規, 0=リピーター
  created_at?: string; // 予約作成日時（新着順ソート用）
  has_line?: number; // 1=LINE連携済み・未ブロック（メッセージ送信可）
  lime_menu_name?: string | null;
  merge_candidate_count?: number;
  has_consent?: boolean;
  is_minimo?: number;
  store_name?: string;
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
  memo: string | null;
  assistant_memo: string | null;
  is_shared_to_customer: number;
  image_count?: number;
  has_consent?: number;
  store_name?: string;
};

export type KaruteMenu = {
  id: string;
  karute_id: string;
  menu_id: string | null;
  menu_name: string;
  price: number;
  sort_order: number;
  created_at: string;
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
  direction: "incoming" | "outgoing" | "system";
  message_type: string;
  content: string | null;
  source: "line" | "web";
  is_read: number;
  sent_at: string;
  sent_by_staff_name?: string | null;
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

export type StaffBusinessHours = {
  day_of_week: number;
  open_time: string | null;
  close_time: string | null;
  is_closed: number;
};

export type StaffReservationSettings = {
  id?: string;
  staff_id?: string;
  store_id?: string;
  advance_booking_days: number;
  same_day_cutoff_hours: number;
  max_concurrent: number;
  accept_same_start_time: number;
  accept_outside_hours: number;
};

export type StaffBlock = {
  id: string;
  staff_id: string;
  store_id: string | null;
  date: string;
  is_all_day: number;
  start_time: string | null;
  end_time: string | null;
  reason: string | null;
  created_at: string;
  updated_at: string;
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
  existing_customer_store_name?: string | null;
  existing_customer_phone: string | null;
  existing_customer_email: string | null;
  existing_customer_visit_count: number;
  existing_customer_last_visit_at: string | null;
  existing_customer_staff_id: string | null;
  existing_customer_staff_name: string | null;
};

export type CounselingSheet = {
  id: string;
  store_id: string;
  customer_id: string;
  data: Record<string, Record<string, string | string[]>>;
  created_at: string;
};

// Staff Personal Menus
export type StaffMenu = {
  id: string;
  staff_id: string;
  name: string;
  category: string;
  duration: number;
  price: number;
  sort_order: number;
  is_active: number;
  created_at: string;
  updated_at: string;
};

export const publicToken = {
  generate: (resource: string, expiresInHours: number = 72) =>
    fetchApi<{ token: string }>("/api/public-token", { method: "POST", body: { resource, expiresInHours } }),
};

export const staffMenus = {
  list: () => fetchApi<{ menus: StaffMenu[] }>("/api/staff-menus"),
  create: (data: { name: string; category?: string; duration: number; price: number }) =>
    fetchApi<{ menu: StaffMenu }>("/api/staff-menus", { method: "POST", body: data }),
  update: (id: string, data: Partial<{ name: string; category: string; duration: number; price: number }>) =>
    fetchApi<{ menu: StaffMenu }>(`/api/staff-menus/${id}`, { method: "PUT", body: data }),
  delete: (id: string) =>
    fetchApi<{ success: boolean }>(`/api/staff-menus/${id}`, { method: "DELETE" }),
  reorder: (items: { id: string; sort_order: number }[]) =>
    fetchApi<{ success: boolean }>("/api/staff-menus/batch/reorder", { method: "PUT", body: { items } }),
};
