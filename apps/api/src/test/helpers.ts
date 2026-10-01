import { randomUUID } from 'node:crypto';
import type { InjectOptions } from 'fastify';
import { systemActor, type Ctx } from '../auth/actor.js';
import { invalidateActorCache } from '../auth/load-actor.js';
import { withTenant } from '../db/tenant.js';
import { drainJobs } from '../jobs/queue.js';
import { hashPassword } from '../lib/crypto.js';
import { buildApp, type App } from '../server.js';

let appPromise: Promise<App> | null = null;

export function getApp(): Promise<App> {
  appPromise ??= buildApp({ logger: false }).then(async (app) => {
    await app.ready();
    return app;
  });
  return appPromise;
}

export interface ApiResponse<T = any> {
  status: number;
  body: T;
  headers: Record<string, string | string[] | number | undefined>;
}

export interface Api {
  get<T = any>(url: string, query?: Record<string, unknown>, headers?: Record<string, string>): Promise<ApiResponse<T>>;
  post<T = any>(url: string, body?: unknown, headers?: Record<string, string>): Promise<ApiResponse<T>>;
  patch<T = any>(url: string, body?: unknown, headers?: Record<string, string>): Promise<ApiResponse<T>>;
  put<T = any>(url: string, body?: unknown, headers?: Record<string, string>): Promise<ApiResponse<T>>;
  delete<T = any>(url: string, headers?: Record<string, string>): Promise<ApiResponse<T>>;
}

export function api(token?: string): Api {
  const call = async (method: InjectOptions['method'], url: string, body?: unknown, headers: Record<string, string> = {}, query?: Record<string, unknown>) => {
    const app = await getApp();
    const qs = query
      ? '?' +
        new URLSearchParams(
          Object.entries(query)
            .filter(([, v]) => v !== undefined && v !== null)
            .flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, String(x)]) : [[k, String(v)]])),
        ).toString()
      : '';
    const res = await app.inject({
      method,
      url: url + qs,
      payload: body === undefined ? undefined : (body as InjectOptions['payload']),
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    });
    let parsed: unknown = res.body;
    try {
      parsed = res.body ? JSON.parse(res.body) : null;
    } catch {
      /* non-JSON */
    }
    return { status: res.statusCode, body: parsed as any, headers: res.headers };
  };
  return {
    get: (url, query, headers) => call('GET', url, undefined, headers, query),
    post: (url, body, headers) => call('POST', url, body ?? {}, headers),
    patch: (url, body, headers) => call('PATCH', url, body ?? {}, headers),
    put: (url, body, headers) => call('PUT', url, body ?? {}, headers),
    delete: (url, headers) => call('DELETE', url, undefined, headers),
  };
}

export interface Tenant {
  organizationId: string;
  shopId: string;
  ownerStaffId: string;
  ownerToken: string;
  owner: Api;
  email: string;
  password: string;
}

const PASSWORD = 'password-1234';

export async function createTenant(name = 'テストサロン'): Promise<Tenant> {
  const suffix = randomUUID().slice(0, 8);
  const email = `owner-${suffix}@example.com`;
  const res = await api().post('/v1/auth/signup', {
    organizationName: name,
    organizationSlug: `org-${suffix}`,
    shopName: `${name} 本店`,
    shopSlug: `shop-${suffix}`,
    ownerName: 'オーナー 太郎',
    email,
    password: PASSWORD,
  });
  if (res.status !== 201) throw new Error(`signup failed: ${res.status} ${JSON.stringify(res.body)}`);
  const token = res.body.auth.accessToken as string;
  return {
    organizationId: res.body.organizationId,
    shopId: res.body.shopId,
    ownerStaffId: res.body.staffId,
    ownerToken: token,
    owner: api(token),
    email,
    password: PASSWORD,
  };
}

/** Create a staff member with a login and return an authenticated client */
export async function createStaffUser(
  tenant: Tenant,
  roleKey: string,
  opts: { shopIds?: string[]; displayName?: string; isBookable?: boolean; nominationFee?: number } = {},
): Promise<{ staffId: string; token: string; api: Api }> {
  const roles = await tenant.owner.get('/v1/roles');
  const role = (roles.body as { id: string; key: string }[]).find((r) => r.key === roleKey);
  if (!role) throw new Error(`role ${roleKey} not found`);
  const suffix = randomUUID().slice(0, 8);
  const email = `${roleKey}-${suffix}@example.com`;
  const created = await tenant.owner.post('/v1/staff', {
    displayName: opts.displayName ?? `${roleKey} ${suffix}`,
    email,
    initialPassword: PASSWORD,
    roleId: role.id,
    shopIds: opts.shopIds ?? [tenant.shopId],
    isBookable: opts.isBookable ?? true,
    nominationFee: opts.nominationFee ?? 0,
  });
  if (created.status !== 201) throw new Error(`staff create failed: ${JSON.stringify(created.body)}`);
  const login = await api().post('/v1/auth/login', { email, password: PASSWORD, organizationId: tenant.organizationId });
  if (login.body.status !== 'authenticated') throw new Error(`login failed: ${JSON.stringify(login.body)}`);
  return { staffId: created.body.staff.id, token: login.body.accessToken, api: api(login.body.accessToken) };
}

/** Run code as the system actor inside the tenant (bypasses permission checks, not RLS) */
export function asSystem<T>(organizationId: string, fn: (ctx: Ctx) => Promise<T>): Promise<T> {
  return withTenant(organizationId, (trx) => fn({ actor: systemActor(organizationId, 'test'), trx, meta: {} }));
}

export async function runJobs(): Promise<number> {
  return drainJobs();
}

export { hashPassword, invalidateActorCache };

/** Local date string N days from today in JST */
export function jstDate(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(d);
}
