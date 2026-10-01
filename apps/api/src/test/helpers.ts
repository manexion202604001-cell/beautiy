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

// ---------------------------------------------------------------- analytics / AI test data (direct inserts)

export interface TestTxItem {
  itemType: 'service' | 'product' | 'nomination_fee' | 'discount' | 'coupon' | 'adjustment';
  menuId?: string | null;
  name?: string;
  quantity?: number;
  /** tax-inclusive unit price (negative for discount/coupon rows) */
  unitPrice: number;
  lineDiscount?: number;
  taxRateBp?: number;
  staff?: { staffId: string; role?: 'main' | 'assistant' | 'referral'; shareBp?: number; isNominated?: boolean }[];
}

export interface TestTxInput {
  shopId: string;
  customerId?: string | null;
  appointmentId?: string | null;
  completedAt: string | Date;
  status?: 'completed' | 'partially_refunded' | 'refunded' | 'voided';
  isNewCustomer?: boolean | null;
  refundedTotal?: number;
  /** defaults: discount = Σ(−discount/coupon rows) + Σ line discounts; tax = floor(total × 10/110) */
  discountTotal?: number;
  taxTotal?: number;
  items: TestTxItem[];
}

/**
 * Insert a finished POS transaction (items + staff allocations) directly as the system actor —
 * analytics/AI tests must not depend on the POS module's API. Emits no events.
 */
export async function insertTransaction(organizationId: string, input: TestTxInput): Promise<{ id: string; total: number }> {
  return asSystem(organizationId, async (ctx) => {
    const lines = input.items.map((it) => {
      const qty = it.quantity ?? 1;
      return { ...it, qty, amount: it.unitPrice * qty - (it.lineDiscount ?? 0) };
    });
    const total = lines.reduce((s, l) => s + l.amount, 0);
    const subtotal = lines.filter((l) => l.amount > 0).reduce((s, l) => s + l.unitPrice * l.qty, 0);
    const discount =
      input.discountTotal ??
      -lines.filter((l) => l.itemType === 'discount' || l.itemType === 'coupon').reduce((s, l) => s + l.amount, 0) +
        lines.reduce((s, l) => s + (l.lineDiscount ?? 0), 0);
    const status = input.status ?? 'completed';
    const completedAt = new Date(input.completedAt);
    const tx = await ctx.trx
      .insertInto('transactions')
      .values({
        organization_id: organizationId,
        shop_id: input.shopId,
        customer_id: input.customerId ?? null,
        appointment_id: input.appointmentId ?? null,
        transaction_number: `T-${randomUUID().slice(0, 12)}`,
        status,
        subtotal,
        discount_total: discount,
        tax_total: input.taxTotal ?? Math.floor((total * 10) / 110),
        total,
        paid_total: total,
        refunded_total: input.refundedTotal ?? (status === 'refunded' ? total : 0),
        is_new_customer: input.isNewCustomer === undefined ? null : input.isNewCustomer,
        completed_at: completedAt,
        voided_at: status === 'voided' ? completedAt : null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    for (const [i, l] of lines.entries()) {
      const item = await ctx.trx
        .insertInto('transaction_items')
        .values({
          organization_id: organizationId,
          transaction_id: tx.id,
          item_type: l.itemType,
          menu_id: l.menuId ?? null,
          name: l.name ?? l.itemType,
          quantity: l.qty,
          unit_price: l.unitPrice,
          line_discount: l.lineDiscount ?? 0,
          tax_rate_bp: l.taxRateBp ?? 1000,
          amount: l.amount,
          sort_order: i,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      for (const s of l.staff ?? []) {
        const share = s.shareBp ?? 10000;
        await ctx.trx
          .insertInto('transaction_item_staff')
          .values({
            organization_id: organizationId,
            transaction_item_id: item.id,
            staff_id: s.staffId,
            role: s.role ?? 'main',
            share_bp: share,
            is_nominated: s.isNominated ?? false,
            allocated_amount: Math.floor((l.amount * share) / 10000),
          })
          .execute();
      }
    }
    return { id: tx.id, total };
  });
}

export interface TestAppointmentInput {
  shopId: string;
  customerId?: string | null;
  staffId?: string | null;
  startAt: string | Date;
  durationMin?: number;
  status?: 'tentative' | 'confirmed' | 'checked_in' | 'in_service' | 'completed' | 'cancelled' | 'no_show';
  source?: 'web' | 'line' | 'external' | 'phone' | 'walk_in' | 'staff';
  isNominated?: boolean;
  estimatedTotal?: number;
}

/** Insert an appointment row directly (past dates allowed, no availability checks, no events) */
export async function insertAppointment(organizationId: string, input: TestAppointmentInput): Promise<{ id: string }> {
  return asSystem(organizationId, async (ctx) => {
    const start = new Date(input.startAt);
    const end = new Date(start.getTime() + (input.durationMin ?? 60) * 60_000);
    const status = input.status ?? 'confirmed';
    return ctx.trx
      .insertInto('appointments')
      .values({
        organization_id: organizationId,
        shop_id: input.shopId,
        customer_id: input.customerId ?? null,
        staff_id: input.staffId ?? null,
        is_nominated: input.isNominated ?? false,
        booking_reference: `R${randomUUID().slice(0, 10)}`,
        start_at: start,
        end_at: end,
        occupied_start_at: start,
        occupied_end_at: end,
        status,
        source: input.source ?? 'staff',
        estimated_total: input.estimatedTotal ?? 0,
        cancelled_at: status === 'cancelled' ? start : null,
        completed_at: status === 'completed' ? end : null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
  });
}
