/**
 * Google Business Profile (GBP) reviews adapter.
 *  - live: My Business API v4 (accounts/{a}/locations/{l}/reviews) with OAuth2 access tokens,
 *          refreshed through https://oauth2.googleapis.com/token when expired.
 *  - mock: in-memory fixtures (dev/test). Configure with setMockGbpReviews().
 * Driver: integration_accounts.config.driver ('mock' | 'live'), else env GBP_DRIVER, default 'mock'
 * (same default as the other external drivers: LINE_DRIVER / PAYMENT_PROVIDER ...).
 */
export type StarRating = 'STAR_RATING_UNSPECIFIED' | 'ONE' | 'TWO' | 'THREE' | 'FOUR' | 'FIVE';

export interface GbpReview {
  /** resource name: accounts/{a}/locations/{l}/reviews/{reviewId} */
  name: string;
  reviewId: string;
  reviewer?: { displayName?: string; profilePhotoUrl?: string; isAnonymous?: boolean };
  starRating: StarRating;
  comment?: string;
  createTime: string;
  updateTime?: string;
  reviewReply?: { comment: string; updateTime?: string };
}

export interface GbpCredentials {
  accessToken?: string;
  refreshToken?: string;
  /** epoch ms */
  expiresAt?: number;
  clientId?: string;
  clientSecret?: string;
}

export interface GbpAccount {
  integrationAccountId: string;
  accountId: string;
  locationId: string;
  credentials: GbpCredentials;
  /** called when the live adapter refreshed the access token (caller persists it encrypted) */
  onCredentialsRefreshed?: (creds: GbpCredentials) => Promise<void> | void;
}

export interface GbpReviewPage {
  reviews: GbpReview[];
  nextPageToken?: string;
}

export interface GbpAdapter {
  listReviews(account: GbpAccount, pageToken?: string): Promise<GbpReviewPage>;
  replyToReview(account: GbpAccount, reviewName: string, comment: string): Promise<void>;
}

export class GbpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = true,
  ) {
    super(message);
    this.name = 'GbpError';
  }
}

export function starToNumber(star: StarRating | undefined): number | null {
  return ({ ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 } as Record<string, number>)[star ?? ''] ?? null;
}

export function reviewResourceName(account: Pick<GbpAccount, 'accountId' | 'locationId'>, reviewId: string) {
  return `accounts/${account.accountId}/locations/${account.locationId}/reviews/${reviewId}`;
}

// ---------------------------------------------------------------- mock

const mockReviews = new Map<string, GbpReview[]>();
export const mockGbpReplies: { reviewName: string; comment: string; at: Date }[] = [];
const mockFailures = new Map<string, number>();

const locKey = (a: Pick<GbpAccount, 'accountId' | 'locationId'>) => `${a.accountId}/${a.locationId}`;

/** Test/dev fixtures: reviews returned for an account/location (page size 2 to exercise paging) */
export function setMockGbpReviews(accountId: string, locationId: string, reviews: Omit<GbpReview, 'name'>[]) {
  mockReviews.set(
    `${accountId}/${locationId}`,
    reviews.map((r) => ({ ...r, name: reviewResourceName({ accountId, locationId }, r.reviewId) })),
  );
}

/** Make the next N mock calls for this location fail (to test retry/degradation) */
export function failMockGbp(accountId: string, locationId: string, times = 1) {
  mockFailures.set(`${accountId}/${locationId}`, times);
}

function maybeFail(account: GbpAccount) {
  const n = mockFailures.get(locKey(account)) ?? 0;
  if (n > 0) {
    mockFailures.set(locKey(account), n - 1);
    throw new GbpError('mock GBP failure', 503, true);
  }
}

export const mockGbpAdapter: GbpAdapter = {
  async listReviews(account, pageToken) {
    maybeFail(account);
    const all = mockReviews.get(locKey(account)) ?? [];
    const start = pageToken ? Number(pageToken) : 0;
    const page = all.slice(start, start + 2);
    return { reviews: page.map((r) => structuredClone(r)), nextPageToken: start + 2 < all.length ? String(start + 2) : undefined };
  },
  async replyToReview(account, reviewName, comment) {
    maybeFail(account);
    mockGbpReplies.push({ reviewName, comment, at: new Date() });
    const r = mockReviews.get(locKey(account))?.find((x) => x.name === reviewName);
    if (r) r.reviewReply = { comment, updateTime: new Date().toISOString() };
  },
};

// ---------------------------------------------------------------- live

const API = 'https://mybusiness.googleapis.com/v4';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

async function accessToken(account: GbpAccount): Promise<string> {
  const c = account.credentials;
  if (c.accessToken && (!c.expiresAt || c.expiresAt - 60_000 > Date.now())) return c.accessToken;
  if (!c.refreshToken) throw new GbpError('Google連携の認証情報(refresh token)がありません', 401, false);
  const clientId = c.clientId ?? process.env.GOOGLE_CLIENT_ID;
  const clientSecret = c.clientSecret ?? process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new GbpError('Google OAuthクライアントが設定されていません', 401, false);
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: c.refreshToken, client_id: clientId, client_secret: clientSecret }),
  });
  if (!res.ok) {
    // 400 invalid_grant = revoked consent → not retryable
    throw new GbpError(`Googleトークン更新に失敗しました (${res.status})`, res.status, res.status >= 500 || res.status === 429);
  }
  const body = (await res.json()) as { access_token: string; expires_in?: number; refresh_token?: string };
  const next: GbpCredentials = {
    ...c,
    accessToken: body.access_token,
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
    refreshToken: body.refresh_token ?? c.refreshToken,
  };
  account.credentials = next;
  await account.onCredentialsRefreshed?.(next);
  return next.accessToken!;
}

async function call<T>(account: GbpAccount, url: string, init: RequestInit = {}, retried = false): Promise<T> {
  const token = await accessToken(account);
  const res = await fetch(url, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}`, 'content-type': 'application/json' } });
  if (res.status === 401 && !retried && account.credentials.refreshToken) {
    account.credentials = { ...account.credentials, accessToken: undefined };
    return call<T>(account, url, init, true);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new GbpError(`Google Business Profile API エラー (${res.status}) ${text.slice(0, 200)}`, res.status, res.status >= 500 || res.status === 429);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export const liveGbpAdapter: GbpAdapter = {
  async listReviews(account, pageToken) {
    const url = new URL(`${API}/accounts/${encodeURIComponent(account.accountId)}/locations/${encodeURIComponent(account.locationId)}/reviews`);
    url.searchParams.set('pageSize', '50');
    url.searchParams.set('orderBy', 'updateTime desc');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const body = await call<{ reviews?: GbpReview[]; nextPageToken?: string }>(account, url.toString());
    return { reviews: body?.reviews ?? [], nextPageToken: body?.nextPageToken };
  },
  async replyToReview(account, reviewName, comment) {
    if (!/^accounts\/[^/]+\/locations\/[^/]+\/reviews\/[^/]+$/.test(reviewName)) throw new GbpError('不正なレビューIDです', 400, false);
    await call(account, `${API}/${reviewName.split('/').map(encodeURIComponent).join('/')}/reply`, { method: 'PUT', body: JSON.stringify({ comment }) });
  },
};

export function gbpAdapterFor(config: { driver?: unknown }): GbpAdapter {
  const driver = typeof config.driver === 'string' ? config.driver : (process.env.GBP_DRIVER ?? 'mock');
  return driver === 'live' ? liveGbpAdapter : mockGbpAdapter;
}
