import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, buildQuery, newIdempotencyKey, refreshAccessToken } from './api';
import { session } from './session';

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('api client', () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    session.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('builds query strings (arrays repeated, empty skipped)', () => {
    expect(buildQuery({ a: 1, b: ['x', 'y'], c: undefined, d: '', e: false })).toBe(
      '?a=1&b=x&b=y&e=false',
    );
    expect(buildQuery({})).toBe('');
  });

  it('generates RFC4122 v4 idempotency keys', () => {
    expect(newIdempotencyKey()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('sends auth, shop and idempotency headers', async () => {
    session.setTokens('access-1', 'refresh-1');
    session.setShopId('11111111-1111-1111-1111-111111111111');
    fetchMock.mockResolvedValueOnce(json(201, { ok: true }));
    await api.post('/appointments', { a: 1 }, { idempotencyKey: 'key-1' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/v1/appointments');
    const h = init!.headers as Record<string, string>;
    expect(h.authorization).toBe('Bearer access-1');
    expect(h['x-shop-id']).toBe('11111111-1111-1111-1111-111111111111');
    expect(h['idempotency-key']).toBe('key-1');
    expect(init!.body).toBe('{"a":1}');
  });

  it('maps the error envelope to a typed ApiError', async () => {
    session.setTokens('access-1', 'refresh-1');
    fetchMock.mockResolvedValueOnce(
      json(409, {
        error: {
          code: 'SLOT_UNAVAILABLE',
          category: 'conflict',
          message: 'この時間帯は既に予約が入っています',
          details: { reason: 'staff_busy' },
          requestId: 'req-1',
        },
      }),
    );
    const err = await api.get('/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      status: 409,
      code: 'SLOT_UNAVAILABLE',
      category: 'conflict',
      requestId: 'req-1',
      message: 'この時間帯は既に予約が入っています',
    });
  });

  it('extracts field errors from validation issues', () => {
    const e = new ApiError({
      status: 400,
      code: 'VALIDATION_ERROR',
      category: 'validation',
      message: 'x',
      details: { issues: [{ path: '/email', message: 'Invalid email' }] },
    });
    expect(e.fieldErrors()).toEqual({ email: 'Invalid email' });
  });

  it('refreshes once on concurrent 401s (single-flight) and retries', async () => {
    session.setTokens('expired', 'refresh-1');
    let refreshCalls = 0;
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/auth/refresh')) {
        refreshCalls++;
        expect(JSON.parse(String(init!.body))).toEqual({ refreshToken: 'refresh-1' });
        await new Promise((r) => setTimeout(r, 10));
        return json(200, { accessToken: 'access-2', refreshToken: 'refresh-2' });
      }
      const auth = (init!.headers as Record<string, string>).authorization;
      return auth === 'Bearer access-2'
        ? json(200, { url })
        : json(401, {
            error: {
              code: 'UNAUTHENTICATED',
              category: 'authentication',
              message: '認証が必要です',
            },
          });
    });
    const results = await Promise.all([
      api.get<{ url: string }>('/a'),
      api.get<{ url: string }>('/b'),
      api.get<{ url: string }>('/c'),
    ]);
    expect(results.map((r) => r.url)).toEqual(['/v1/a', '/v1/b', '/v1/c']);
    expect(refreshCalls).toBe(1);
    expect(session.getRefreshToken()).toBe('refresh-2');
    expect(window.localStorage.getItem('salon.refreshToken')).toBe('refresh-2');
  });

  it('clears the session when the refresh token is rejected', async () => {
    session.setTokens('expired', 'refresh-bad');
    fetchMock.mockResolvedValue(
      json(401, {
        error: { code: 'INVALID_REFRESH_TOKEN', category: 'authentication', message: 'x' },
      }),
    );
    await expect(refreshAccessToken()).resolves.toBeNull();
    expect(session.getRefreshToken()).toBeNull();
  });

  it('keeps the session on transient refresh failures', async () => {
    session.setTokens('expired', 'refresh-ok');
    fetchMock.mockResolvedValue(
      json(503, { error: { code: 'INTERNAL_ERROR', category: 'system', message: 'x' } }),
    );
    await expect(refreshAccessToken()).resolves.toBeNull();
    expect(session.getRefreshToken()).toBe('refresh-ok');
  });

  it('wraps network failures', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(api.get('/x', undefined, { auth: 'none' })).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
      category: 'network',
    });
  });
});
