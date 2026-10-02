export const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8787";
const DEFAULT_STORE_ID = process.env.NEXT_PUBLIC_STORE_ID || "";
let _storeIdOverride: string | null = null;
const TOKEN_KEY = "customer_token";

export function setStoreId(id: string) {
  _storeIdOverride = id;
}

export function getStoreId(): string {
  return _storeIdOverride || DEFAULT_STORE_ID;
}

interface ApiError {
  error: string;
}

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

async function fetchApi<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const url = `${API_BASE_URL}${endpoint}`;
  const token = tokenStorage.get();

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };

  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const response = await fetch(url, {
    ...options,
    headers,
    credentials: "include",
  });

  if (!response.ok) {
    const error: ApiError = await response.json().catch(() => ({
      error: "エラーが発生しました",
    }));
    throw new Error(error.error);
  }

  return response.json();
}

// Types
export interface Customer {
  id: string;
  store_id: string;
  name: string;
  name_kana: string | null;
  email: string | null;
  phone: string | null;
  birthday: string | null;
  gender: string | null;
  memo: string | null;
  created_at: string;
  updated_at: string;
  last_visit_at: string | null;
  visit_count: number;
}

export interface Store {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  email: string | null;
  description: string | null;
  logo_url: string | null;
  line_liff_id?: string | null;
  business_hours?: BusinessHour[];
}

export interface BusinessHour {
  day_of_week: number;
  open_time: string | null;
  close_time: string | null;
  is_closed: boolean;
}

export interface Menu {
  id: string;
  name: string;
  description: string | null;
  image_url: string | null;
  price: number;
  price_tilde: number;
  duration: number;
  category: string | null;
  coupon_type: 'new' | 'repeat' | 'all' | null;
  is_active: boolean;
}

export interface Staff {
  id: string;
  name: string;
  avatar_url: string | null;
}

export interface Reservation {
  id: string;
  store_id: string;
  customer_id: string;
  staff_id: string | null;
  menu_id: string;
  start_at: string;
  end_at: string;
  status: "pending" | "confirmed" | "cancelled" | "completed";
  note: string | null;
  created_at: string;
  staff?: Staff;
  staff_name?: string;
  staff_is_active?: number; // 0=退職スタッフ
  menu?: Menu;
  menu_name?: string;
}

// Shared karute as exposed to customers (no treatment notes — photos only)
export interface Karute {
  id: string;
  visit_date: string;
  shared_at: string | null;
  staff_name: string | null;
  staff_avatar_url: string | null;
  image_count?: number;
  images?: KaruteImage[];
}

export interface KaruteImage {
  id: string;
  image_url: string;
  caption: string | null;
}

export interface Message {
  id: string;
  store_id: string;
  customer_id: string;
  sender_type: "store" | "customer";
  sender_id: string | null;
  content: string;
  is_read: boolean;
  sent_at: string;
  sender?: Staff;
}

export interface TimeSlot {
  time: string;
  available: boolean;
  available_other_staff?: boolean;
}

// Auth API
export const authApi = {
  login: async (data: { email: string; password: string }) => {
    const result = await fetchApi<{ customer: Customer; token: string }>("/api/customer/auth/login", {
      method: "POST",
      body: JSON.stringify({ ...data, store_id: getStoreId() }),
    });
    // Save token to localStorage
    if (result.token) {
      tokenStorage.set(result.token);
    }
    return result;
  },

  logout: async () => {
    tokenStorage.remove();
    return fetchApi<{ success: boolean }>("/api/customer/auth/logout", {
      method: "POST",
    });
  },

  me: () =>
    fetchApi<{
      customer: Customer;
      line?: { display_name: string | null; picture_url: string | null; registration_status: string | null } | null;
      store?: { id: string; name: string } | null;
    }>("/api/customer/auth/me"),

  // LINE Login (web browser). nonce is echoed back in `state` and checked by /auth/line/callback
  lineLoginUrl: (nonce: string) =>
    fetchApi<{ url: string }>(
      `/api/customer/auth/line?store_id=${encodeURIComponent(getStoreId())}&nonce=${encodeURIComponent(nonce)}`
    ),

  lineCallback: async (code: string, state: string) => {
    const result = await fetchApi<{ customer: Customer; token: string; isNewUser: boolean }>(
      "/api/customer/auth/line/callback",
      {
        method: "POST",
        body: JSON.stringify({ code, state }),
      }
    );
    if (result.token) {
      tokenStorage.set(result.token);
    }
    return result;
  },

  phoneMatch: async (phone: string) => {
    const result = await fetchApi<{
      matched: boolean;
      customer: Customer;
      token?: string;
    }>("/api/customer/auth/phone-match", {
      method: "POST",
      body: JSON.stringify({ phone }),
    });
    if (result.token) {
      tokenStorage.set(result.token);
    }
    return result;
  },
};

// Store API
export const storeApi = {
  get: () =>
    fetchApi<{ store: Store }>(`/api/customer/store/${getStoreId()}`),
};

// Menus API
export const menusApi = {
  list: (staffId?: string) => {
    const params = staffId ? `?staff_id=${staffId}` : "";
    return fetchApi<{ menus: Menu[]; categoryColors: Record<string, string> }>(`/api/customer/menus/${getStoreId()}${params}`);
  },
};

// Staff API
export const staffApi = {
  list: (menuId?: string) => {
    const params = menuId ? `?menu_id=${menuId}` : "";
    return fetchApi<{ staff: Staff[] }>(`/api/customer/staff/${getStoreId()}${params}`);
  },
};

// Reservations API
export const reservationsApi = {
  list: () =>
    fetchApi<{ reservations: Reservation[] }>("/api/customer/reservations"),


  create: (data: {
    store_id?: string;
    menu_id: string;
    menu_ids?: string[];
    staff_id?: string;
    start_at: string;
    memo?: string;
    phone?: string;
    name?: string;
    name_kana?: string;
    is_first_visit?: boolean;
  }) =>
    fetchApi<{ reservation: Reservation }>("/api/customer/reservations", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  createGuest: (data: {
    store_id: string;
    menu_id: string;
    menu_ids?: string[];
    staff_id?: string;
    start_at: string;
    memo?: string;
    phone: string;
    name: string;
    name_kana?: string;
    is_first_visit?: boolean;
    liff_access_token?: string;
  }) =>
    fetchApi<{ reservation: Reservation }>("/api/customer/reservations/guest", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  cancel: (id: string) =>
    fetchApi<{ success: boolean }>(`/api/customer/reservations/${id}/cancel`, {
      method: "PUT",
    }),

  getAvailableSlots: (params: {
    date: string;
    menu_id: string;
    staff_id?: string;
    duration?: number;
  }) => {
    const query = new URLSearchParams();
    query.set("date", params.date);
    query.set("menu_id", params.menu_id);
    if (params.staff_id) query.set("staff_id", params.staff_id);
    if (params.duration) query.set("duration", params.duration.toString());
    return fetchApi<{ slots: TimeSlot[]; max_booking_date?: string; closed?: boolean; blocked?: boolean; open_time?: string; close_time?: string; is_holiday?: boolean }>(
      `/api/customer/available-slots/${getStoreId()}?${query}`
    );
  },
};

// Karutes API
export const karutesApi = {
  list: () =>
    fetchApi<{ karutes: Karute[] }>("/api/customer/karutes"),

  get: (id: string) =>
    fetchApi<{ karute: Karute; images: KaruteImage[] }>(`/api/customer/karutes/${id}`),
};

// Messages API
export const messagesApi = {
  list: (staffId?: string, storeId?: string) => {
    const params = new URLSearchParams();
    if (staffId) params.set('staff_id', staffId);
    if (storeId) params.set('store_id', storeId);
    return fetchApi<{ messages: Message[] }>(
      `/api/customer/messages?${params}`
    );
  },

  send: (content: string, staffId?: string, storeId?: string) =>
    fetchApi<{ message: Message }>("/api/customer/messages", {
      method: "POST",
      body: JSON.stringify({ content, staff_id: staffId, store_id: storeId }),
    }),

  sendGuest: (data: { store_id: string; staff_id?: string; content: string; name: string; phone: string }) =>
    fetchApi<{ message: Message; customer_id: string }>("/api/customer/messages/guest", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  sendLiffGuest: (data: { store_id: string; staff_id?: string; content: string; liff_access_token: string }) =>
    fetchApi<{ message: Message; customer_id: string }>("/api/customer/messages/liff-guest", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  // Fetch history by verified LINE identity (LIFF token) — same secure resolution as sendLiffGuest.
  listLiffGuest: (data: { store_id: string; staff_id?: string; liff_access_token: string }) =>
    fetchApi<{ messages: Message[] }>("/api/customer/messages/liff-guest-history", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  markAsRead: () =>
    fetchApi<{ success: boolean }>("/api/customer/messages/read", {
      method: "POST",
    }),
};

// Counseling Sheet API
export type CounselingSheet = {
  id: string;
  store_id: string;
  customer_id: string;
  data: Record<string, Record<string, string | string[]>>;
  created_at: string;
  updated_at: string;
};

export const counselingSheetApi = {
  get: () =>
    fetchApi<{ counseling_sheet: CounselingSheet | null }>("/api/customer/counseling-sheet"),

  save: (data: Record<string, Record<string, string | string[]>>) =>
    fetchApi<{ counseling_sheet: CounselingSheet }>("/api/customer/counseling-sheet", {
      method: "PUT",
      body: JSON.stringify({ data }),
    }),
};

// Profile API
// LIFF Registration (no JWT — uses LIFF access token directly)
export async function registerWithLiff(data: {
  store_id: string;
  liff_access_token: string;
  name: string;
  phone?: string;
  type: 'returning' | 'new';
}): Promise<{ success: boolean; customer_id: string }> {
  const res = await fetch(`${API_BASE_URL}/api/customer/register/liff`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: '登録に失敗しました' }));
    throw new Error((error as { error: string }).error);
  }
  return res.json();
}

// Profile API
export const profileApi = {
  get: () =>
    fetchApi<{ customer: Customer }>("/api/customer/profile"),

  update: (data: Partial<Customer>) =>
    fetchApi<{ customer: Customer }>("/api/customer/profile", {
      method: "PUT",
      body: JSON.stringify(data),
    }),
};
