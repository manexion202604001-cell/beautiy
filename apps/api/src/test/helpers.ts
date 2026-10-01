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

/** Next local (JST) date with the given weekday (0=Sun) at least minDays ahead */
export function nextWeekday(weekday: number, minDays = 3): string {
  for (let i = minDays; i < minDays + 8; i++) {
    const d = jstDate(i);
    if (new Date(`${d}T12:00:00+09:00`).getUTCDay() === weekday) return d;
  }
  throw new Error('unreachable');
}

/** ISO timestamp for a JST local date/time */
export function jst(date: string, time: string): string {
  return new Date(`${date}T${time}:00+09:00`).toISOString();
}

export async function createMenu(tenant: Tenant, overrides: Record<string, unknown> = {}) {
  const res = await tenant.owner.post('/v1/menus', { name: 'カット', durationMin: 60, price: 5500, ...overrides });
  if (res.status !== 201) throw new Error(`menu create failed ${JSON.stringify(res.body)}`);
  return res.body as { id: string; name: string };
}

export async function createCustomer(tenant: Tenant, overrides: Record<string, unknown> = {}) {
  const res = await tenant.owner.post('/v1/customers', { lastName: '顧客', firstName: randomUUID().slice(0, 4), ...overrides });
  if (res.status !== 201) throw new Error(`customer create failed ${JSON.stringify(res.body)}`);
  return res.body.customer as { id: string };
}

// ---------------------------------------------------------------- messaging fixtures (LINE webhook / channels / jobs)
import { sql as _msgSql } from 'kysely';
import { hmacSha256 as _msgHmac } from '../lib/crypto.js';
import { clock as _messagingClock } from '../modules/messaging/clock.js';
import { mockBotUserId as _mockBotUserId } from '../modules/messaging/providers/line.js';
import { processLineEvent as _processLineEvent, verifyLineWebhook as _verifyLineWebhook } from '../modules/messaging/webhook.js';

export interface TestLineChannel {
  id: string;
  channelId: string;
  secret: string;
  accessToken: string;
  botUserId: string;
}

export async function createLineChannel(t: Tenant, opts: { shopId?: string | null } = {}): Promise<TestLineChannel> {
  const suffix = randomUUID().replace(/-/g, '');
  const body = {
    shopId: opts.shopId ?? null,
    channelId: `ch-${suffix.slice(0, 12)}`,
    name: 'テストLINE',
    channelSecret: `secret-${suffix}`,
    accessToken: `token-${suffix}`,
  };
  const res = await t.owner.post('/v1/line-channels', body);
  if (res.status !== 201) throw new Error(`line channel create failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { id: res.body.id, channelId: body.channelId, secret: body.channelSecret, accessToken: body.accessToken, botUserId: _mockBotUserId(body.accessToken) };
}

export function lineUserId(): string {
  return `U${randomUUID().replace(/-/g, '')}`;
}

let lineSeq = 0;
export function lineEvent(type: string, userId: string, extra: Record<string, unknown> = {}) {
  lineSeq++;
  return {
    type,
    mode: 'active',
    timestamp: Date.now(),
    webhookEventId: `01H${randomUUID().replace(/-/g, '').slice(0, 20).toUpperCase()}${lineSeq}`,
    deliveryContext: { isRedelivery: false },
    source: { type: 'user', userId },
    ...extra,
  };
}

export function textEvent(userId: string, text: string) {
  return lineEvent('message', userId, { replyToken: 'r', message: { id: `m${Date.now()}${lineSeq}`, type: 'text', text } });
}

export function signedDelivery(channel: TestLineChannel, events: unknown[], opts: { secret?: string; destination?: string } = {}) {
  const body = { destination: opts.destination ?? channel.botUserId, events };
  const rawBody = JSON.stringify(body);
  const signature = _msgHmac(opts.secret ?? channel.secret, rawBody, 'base64');
  return { provider: 'line', headers: { 'x-line-signature': signature, 'content-type': 'application/json' }, rawBody, body };
}

/** verify + process a delivery like the generic webhook route would (each split event in its own tx) */
export async function deliverWebhook(t: Tenant, channel: TestLineChannel, events: unknown[]) {
  const verified = await _verifyLineWebhook(signedDelivery(channel, events));
  if (!verified.signatureValid) throw new Error('signature invalid');
  const results: string[] = [];
  for (const ev of verified.events ?? []) {
    results.push(await asSystem(t.organizationId, (ctx) => _processLineEvent(ctx, { eventId: ev.eventId, eventType: ev.eventType ?? null, payload: ev.payload })));
  }
  return { verified, results };
}

/** Follow the LINE account as a new user → returns the resolved customer id */
export async function lineFollower(t: Tenant, channel: TestLineChannel, userId = lineUserId()) {
  await deliverWebhook(t, channel, [lineEvent('follow', userId)]);
  const row = await asSystem(t.organizationId, (ctx) =>
    ctx.trx.selectFrom('customer_identities').select('customer_id').where('provider', '=', 'line').where('external_id', '=', userId).executeTakeFirstOrThrow(),
  );
  return { userId, customerId: row.customer_id };
}

export function messagesOf(t: Tenant, customerId: string) {
  return asSystem(t.organizationId, (ctx) => ctx.trx.selectFrom('messages').selectAll().where('customer_id', '=', customerId).orderBy('created_at').orderBy('id').execute());
}

export function updateCustomer(t: Tenant, customerId: string, patch: Record<string, unknown>) {
  return asSystem(t.organizationId, (ctx) => ctx.trx.updateTable('customers').set(patch).where('id', '=', customerId).execute());
}

/** Make queued jobs of this tenant runnable now (skip backoff / scheduled delays) */
export function makeJobsDue(t: Tenant, filter: { type?: string } = {}) {
  return asSystem(t.organizationId, (ctx) => {
    let q = ctx.trx.updateTable('jobs').set({ run_at: _msgSql`now() - interval '1 second'` }).where('state', '=', 'queued').where('organization_id', '=', t.organizationId);
    if (filter.type) q = q.where('type', '=', filter.type);
    return q.execute();
  });
}

export function daysAgo(n: number) {
  return new Date(Date.now() - n * 86_400_000);
}

export function setClock(d: Date | null) {
  _messagingClock.now = d ? () => new Date(d) : () => new Date();
}
