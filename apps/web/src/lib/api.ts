import { session } from './session';

/** API base path. Relative '/v1' by default (Vite proxy in dev, same-origin reverse proxy in prod). */
export const API_BASE_URL: string =
  (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, '') || '/v1';

export type ErrorCategory =
  | 'validation'
  | 'business'
  | 'authentication'
  | 'authorization'
  | 'not_found'
  | 'conflict'
  | 'external'
  | 'rate_limit'
  | 'system'
  | 'network';

/** Typed API error mirroring { error: { code, category, message, details, requestId } } */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly category: ErrorCategory;
  readonly details: unknown;
  readonly requestId?: string;

  constructor(init: {
    status: number;
    code: string;
    category: ErrorCategory;
    message: string;
    details?: unknown;
    requestId?: string;
  }) {
    super(init.message);
    this.name = 'ApiError';
    this.status = init.status;
    this.code = init.code;
    this.category = init.category;
    this.details = init.details;
    this.requestId = init.requestId;
  }

  /** Field-level validation issues (zod) as { path: message } */
  fieldErrors(): Record<string, string> {
    const issues =
      (this.details as { issues?: { path?: string; message?: string }[] } | undefined)?.issues ??
      [];
    const out: Record<string, string> = {};
    for (const i of issues) {
      const key = (i.path ?? '').replace(/^\//, '').replace(/\//g, '.');
      if (key && i.message && !out[key]) out[key] = i.message;
    }
    return out;
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

/** Japanese user-facing message for any thrown value */
export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return '予期しないエラーが発生しました';
}

export function newIdempotencyKey(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  // RFC4122 v4 fallback (older in-app browsers)
  const bytes = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export type QueryValue = string | number | boolean | null | undefined | (string | number)[];

export function buildQuery(query?: Record<string, QueryValue>): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) v.forEach((x) => params.append(k, String(x)));
    else params.append(k, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, QueryValue>;
  headers?: Record<string, string>;
  /** sends Idempotency-Key (pass a key generated once per user action so retries are safe) */
  idempotencyKey?: string;
  /** 'staff' (default): access token + X-Shop-Id with automatic refresh. 'customer': explicit bearer token. 'none': anonymous */
  auth?: 'staff' | 'customer' | 'none';
  /** bearer token for auth: 'customer' */
  token?: string | null;
  signal?: AbortSignal;
  /** return the raw Response (downloads) */
  raw?: boolean;
}

// ---------------------------------------------------------------- refresh (single-flight)

let refreshPromise: Promise<string | null> | null = null;
let onSessionExpired: (() => void) | null = null;
/** why the last refresh failed: 'auth' = token rejected (logged out), 'transient' = network / 429 / 5xx */
let lastRefreshFailure: 'auth' | 'transient' | null = null;

export function setSessionExpiredHandler(fn: (() => void) | null) {
  onSessionExpired = fn;
}

export function getLastRefreshFailure() {
  return lastRefreshFailure;
}

interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function refreshOnce(): Promise<string | null> {
  // another tab may have rotated the token meanwhile → always use the latest stored one
  session.syncFromStorage();
  const rt = session.getRefreshToken();
  if (!rt) {
    lastRefreshFailure = 'auth';
    return null;
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${API_BASE_URL}/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ refreshToken: rt }),
      });
    } catch {
      lastRefreshFailure = 'transient';
      return null;
    }
    if (res.ok) {
      const pair = (await res.json()) as TokenPair;
      session.setTokens(pair.accessToken, pair.refreshToken);
      lastRefreshFailure = null;
      return pair.accessToken;
    }
    if (res.status === 429 && attempt < 3) {
      // auth endpoints are rate limited per IP (shared salon network) → back off and retry
      const retryAfter = Number(res.headers.get('retry-after'));
      await sleep(
        Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter, 10) * 1000
          : 1000 * 2 ** attempt,
      );
      continue;
    }
    if (res.status === 401 || res.status === 403 || res.status === 400) {
      // the server rejected the token → the session is over
      lastRefreshFailure = 'auth';
      session.clear();
      onSessionExpired?.();
      return null;
    }
    lastRefreshFailure = 'transient';
    return null;
  }
  lastRefreshFailure = 'transient';
  return null;
}

/**
 * Rotate the refresh token once even when many requests hit 401 at the same time (single-flight),
 * serialized across browser tabs with the Web Locks API so two tabs never present the same
 * refresh token (the API treats a replayed rotated token as theft and revokes every session).
 */
export function refreshAccessToken(): Promise<string | null> {
  if (refreshPromise) return refreshPromise;
  if (!session.getRefreshToken() && !session.syncFromStorage()) return Promise.resolve(null);
  refreshPromise = (async () => {
    try {
      const locks = (
        navigator as Navigator & {
          locks?: { request: <T>(name: string, cb: () => Promise<T>) => Promise<T> };
        }
      ).locks;
      if (!locks?.request) return await refreshOnce();
      return await locks.request('salon-auth-refresh', async () => {
        // a tab that held the lock may already have rotated the token and shared it via storage;
        // we still need our own access token, so refresh with the latest token
        session.syncFromStorage();
        if (!session.getRefreshToken()) return null;
        return refreshOnce();
      });
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

async function parseError(res: Response): Promise<ApiError> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON */
  }
  const e = (
    body as {
      error?: {
        code?: string;
        category?: ErrorCategory;
        message?: string;
        details?: unknown;
        requestId?: string;
      };
    } | null
  )?.error;
  if (e) {
    return new ApiError({
      status: res.status,
      code: e.code ?? 'UNKNOWN',
      category: e.category ?? 'system',
      message: e.message ?? `エラーが発生しました (${res.status})`,
      details: e.details,
      requestId: e.requestId ?? res.headers.get('x-request-id') ?? undefined,
    });
  }
  return new ApiError({
    status: res.status,
    code: `HTTP_${res.status}`,
    category: res.status >= 500 ? 'system' : res.status === 404 ? 'not_found' : 'validation',
    message:
      res.status >= 500
        ? 'サーバーでエラーが発生しました。しばらくしてから再試行してください'
        : `リクエストに失敗しました (${res.status})`,
    requestId: res.headers.get('x-request-id') ?? undefined,
  });
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const auth = opts.auth ?? 'staff';
  const doFetch = (token: string | null) => {
    const headers: Record<string, string> = { accept: 'application/json', ...opts.headers };
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    if (token) headers.authorization = `Bearer ${token}`;
    if (auth === 'staff') {
      const shop = session.getShopId();
      if (shop) headers['x-shop-id'] = shop;
    }
    if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;
    return fetch(`${API_BASE_URL}${path}${buildQuery(opts.query)}`, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: opts.signal,
    });
  };

  let token: string | null =
    auth === 'staff' ? session.getAccessToken() : auth === 'customer' ? (opts.token ?? null) : null;
  if (auth === 'staff' && !token && session.getRefreshToken()) token = await refreshAccessToken();

  let res: Response;
  try {
    res = await doFetch(token);
    if (res.status === 401 && auth === 'staff' && session.getRefreshToken()) {
      const fresh = await refreshAccessToken();
      if (fresh) res = await doFetch(fresh);
    }
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError({
      status: 0,
      code: 'NETWORK_ERROR',
      category: 'network',
      message: 'ネットワークに接続できません。通信環境をご確認ください',
    });
  }

  if (!res.ok) throw await parseError(res);
  if (opts.raw) return res as unknown as T;
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export const api = {
  get: <T>(
    path: string,
    query?: Record<string, QueryValue>,
    opts: Omit<RequestOptions, 'query' | 'method'> = {},
  ) => request<T>(path, { ...opts, query }),
  post: <T>(path: string, body?: unknown, opts: Omit<RequestOptions, 'body' | 'method'> = {}) =>
    request<T>(path, { ...opts, method: 'POST', body: body ?? {} }),
  put: <T>(path: string, body?: unknown, opts: Omit<RequestOptions, 'body' | 'method'> = {}) =>
    request<T>(path, { ...opts, method: 'PUT', body: body ?? {} }),
  patch: <T>(path: string, body?: unknown, opts: Omit<RequestOptions, 'body' | 'method'> = {}) =>
    request<T>(path, { ...opts, method: 'PATCH', body: body ?? {} }),
  delete: <T = void>(path: string, opts: Omit<RequestOptions, 'method'> = {}) =>
    request<T>(path, { ...opts, method: 'DELETE' }),
};

/** Download a file from an authenticated endpoint (e.g. CSV export) */
export async function downloadFile(
  path: string,
  query: Record<string, QueryValue> | undefined,
  fallbackName: string,
) {
  const res = await request<Response>(path, {
    query,
    raw: true,
    headers: { accept: 'text/csv,*/*' },
  });
  const blob = await res.blob();
  const cd = res.headers.get('content-disposition') ?? '';
  const name = /filename="?([^";]+)"?/.exec(cd)?.[1] ?? fallbackName;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
