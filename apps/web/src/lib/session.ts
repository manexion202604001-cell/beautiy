import { storageGet, storageGetJson, storageSet, storageSetJson } from './storage';

/**
 * Staff session store.
 *  - access token: memory only (short-lived JWT)
 *  - refresh token: localStorage (rotated on every refresh)
 *  - current shop: localStorage (UI context, sent as X-Shop-Id)
 */
const REFRESH_KEY = 'salon.refreshToken';
const SHOP_KEY = 'salon.currentShopId';

type Listener = () => void;

let accessToken: string | null = null;
let refreshToken: string | null = storageGet(REFRESH_KEY);
let shopId: string | null = storageGet(SHOP_KEY);
let version = 0;
const listeners = new Set<Listener>();

function notify() {
  version++;
  for (const l of listeners) l();
}

export const session = {
  getAccessToken: () => accessToken,
  getRefreshToken: () => refreshToken,
  getShopId: () => shopId,
  getVersion: () => version,
  setTokens(access: string, refresh: string) {
    accessToken = access;
    refreshToken = refresh;
    storageSet(REFRESH_KEY, refresh);
    notify();
  },
  clear() {
    accessToken = null;
    refreshToken = null;
    storageSet(REFRESH_KEY, null);
    notify();
  },
  /** re-read the refresh token written by another tab; returns the current token */
  syncFromStorage(): string | null {
    const stored = storageGet(REFRESH_KEY);
    if (stored !== refreshToken) {
      refreshToken = stored;
      if (!stored) accessToken = null;
      notify();
    }
    return refreshToken;
  },
  setShopId(id: string | null) {
    if (id === shopId) return;
    shopId = id;
    storageSet(SHOP_KEY, id);
    notify();
  },
  subscribe(l: Listener) {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
};

// logout / rotation in another tab
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === REFRESH_KEY) session.syncFromStorage();
  });
}

// ---------------------------------------------------------------- customer (public pages)

export interface CustomerSession {
  token: string;
  customerId: string;
  via: 'line' | 'otp';
  shopSlug: string;
  savedAt: number;
}

const CUSTOMER_KEY = 'salon.customerSessions';
const LAST_SLUG_KEY = 'salon.lastShopSlug';

export const customerSession = {
  get(slug: string): CustomerSession | null {
    const all = storageGetJson<Record<string, CustomerSession>>(CUSTOMER_KEY) ?? {};
    return all[slug] ?? null;
  },
  set(s: CustomerSession) {
    const all = storageGetJson<Record<string, CustomerSession>>(CUSTOMER_KEY) ?? {};
    all[s.shopSlug] = s;
    storageSetJson(CUSTOMER_KEY, all);
    storageSet(LAST_SLUG_KEY, s.shopSlug);
  },
  clear(slug: string) {
    const all = storageGetJson<Record<string, CustomerSession>>(CUSTOMER_KEY) ?? {};
    delete all[slug];
    storageSetJson(CUSTOMER_KEY, all);
  },
  lastSlug(): string | null {
    return storageGet(LAST_SLUG_KEY);
  },
  rememberSlug(slug: string) {
    storageSet(LAST_SLUG_KEY, slug);
  },
};
