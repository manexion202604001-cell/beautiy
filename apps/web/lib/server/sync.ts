// External booking sync: inbound webhook ingestion, idempotent event processing,
// retry/backoff/dead-letter, conflict reconciliation and outbound propagation.
//
// Flow: verify signature → normalize through the provider adapter → store SyncEvent
// (unique provider + namespaced event id) → process (inline best effort, then cron).
// Domain writes only go through lib/server/booking.ts and resolveCustomer.
import type { BookingSource, Prisma, SyncStatus } from '@salonos/db';
import { ACTIVE_STATUSES, backoffMs, MAX_SYNC_ATTEMPTS, normalizePhone } from '@salonos/core';
import { sha256 } from '@salonos/core/crypto';
import {
  getBookingAdapter, NormalizeError, type ExternalBooking, type NormalizedEvent,
} from '@salonos/core/integrations/booking-provider';
import { prisma } from './db';
import { AppError, NotFoundError } from './errors';
import { readConfig, type IntegrationConfig } from './integrations';
import { BookingError, changeAppointmentStatus, createAppointment, updateAppointment, type MenuLine } from './booking';
import { resolveCustomer } from './customers';
import { phoneHash } from './pii';

export const BOOKING_PROVIDERS = ['GENERIC', 'HOTPEPPER', 'MINIMO', 'RAKUTEN', 'OTHER'] as const;
export type BookingProvider = (typeof BOOKING_PROVIDERS)[number];

export const PROVIDER_SOURCE: Record<string, BookingSource> = {
  HOTPEPPER: 'HOTPEPPER', MINIMO: 'MINIMO', RAKUTEN: 'RAKUTEN', GENERIC: 'OTHER', OTHER: 'OTHER',
};

/**
 * Appointment.externalRef for a provider booking id. Sites with globally unique reservation
 * numbers keep the raw id; free-form sources (GENERIC/OTHER) are namespaced by integration so
 * two tenants sending id "1" never collide on the (externalProvider, externalRef) unique key.
 */
export function externalRefFor(provider: string, integrationId: string | null, externalId: string): string {
  return (provider === 'GENERIC' || provider === 'OTHER') && integrationId ? `${integrationId}/${externalId}` : externalId;
}
export function providerBookingId(provider: string, externalRef: string): string {
  return provider === 'GENERIC' || provider === 'OTHER' ? externalRef.slice(externalRef.indexOf('/') + 1) : externalRef;
}

/** Non-retryable processing failure → DEAD immediately. */
class PermanentSyncError extends AppError {}

export const SYNC_STATUS_LABEL: Record<SyncStatus, string> = {
  PENDING: '待機中', PROCESSING: '処理中', DONE: '完了', FAILED: '再試行待ち', DEAD: '失敗（停止）', CONFLICT: '要確認（競合）',
};

/** Processing lease: a crashed worker's claim becomes reclaimable after this. */
const LEASE_MS = 5 * 60_000;
const MAX_BODY_BYTES = 256 * 1024;

/** Result stored in SyncEvent.normalized alongside the normalized payload. */
interface Outcome {
  at: string;
  items: { externalId: string; action: 'created' | 'updated' | 'cancelled' | 'unchanged' | 'stale' | 'cancel_unknown' | 'linked' | 'ignored' | 'pushed' | 'noop'; appointmentId?: string | null; version?: number | null; note?: string }[];
  conflict?: { externalId: string; reason: string; message: string; shopId: string; staffId: string | null; startAt: string; endAt: string };
  note?: string;
}
type StoredNormalized = NormalizedEvent & { applied?: Record<string, number>; outcome?: Outcome };

export interface WebhookResult { status: number; body: Record<string, unknown> }

function lowerHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v;
  return out;
}

function safeJson(raw: string): Prisma.InputJsonValue {
  try { return JSON.parse(raw); } catch { return { raw: raw.slice(0, 10_000) }; }
}

function isUniqueViolation(e: any) { return e?.code === 'P2002'; }

// ───────────────────────── Inbound ─────────────────────────

/**
 * Entry point for POST /api/webhooks/booking/<webhookKey>.
 * 404 unknown/paused · 401 bad signature · 400 invalid payload (stored as DEAD) ·
 * 200 accepted (or duplicate, which is never reprocessed).
 */
export async function ingestBookingWebhook(
  webhookKey: string, headers: Record<string, string>, rawBody: string,
  opts: { processInline?: boolean; now?: Date } = {},
): Promise<WebhookResult> {
  if (!webhookKey || webhookKey.length > 64) return { status: 404, body: { ok: false, error: 'not_found' } };
  const integration = await prisma.integration.findUnique({ where: { webhookKey } });
  const adapter = integration ? getBookingAdapter(integration.provider) : null;
  if (!integration || !adapter || integration.status === 'PAUSED') return { status: 404, body: { ok: false, error: 'not_found' } };
  if (Buffer.byteLength(rawBody, 'utf8') > MAX_BODY_BYTES) return { status: 413, body: { ok: false, error: 'payload_too_large' } };

  const config = readConfig(integration.configEnc);
  const h = lowerHeaders(headers);
  if (!adapter.verifyWebhook(h, rawBody, config.webhookSecret || undefined)) {
    return { status: 401, body: { ok: false, error: 'invalid_signature' } };
  }

  let normalized: NormalizedEvent;
  try {
    normalized = adapter.normalizeWebhook(rawBody);
  } catch (e: any) {
    const message = e instanceof NormalizeError ? e.message : `normalize failed: ${e?.message ?? e}`;
    // Keep the bad payload for inspection; idempotent by body hash.
    const externalEventId = `${integration.id}:invalid:${sha256(rawBody).slice(0, 32)}`;
    const seenBad = await prisma.syncEvent.findUnique({ where: { provider_externalEventId: { provider: integration.provider, externalEventId } } });
    if (!seenBad) try {
      await prisma.syncEvent.create({
        data: {
          organizationId: integration.organizationId, integrationId: integration.id, provider: integration.provider, direction: 'INBOUND',
          externalEventId, type: 'invalid', payload: safeJson(rawBody), status: 'DEAD', attempts: 1, lastError: message,
        },
      });
    } catch (err) { if (!isUniqueViolation(err)) throw err; }
    await prisma.integration.update({ where: { id: integration.id }, data: { lastError: message } });
    return { status: 400, body: { ok: false, error: 'invalid_payload', message } };
  }

  // Event ids are namespaced by integration so two tenants can never collide.
  const externalEventId = `${integration.id}:${normalized.eventId}`;
  const seen = await prisma.syncEvent.findUnique({ where: { provider_externalEventId: { provider: integration.provider, externalEventId } } });
  if (seen) return { status: 200, body: { ok: true, duplicate: true, id: seen.id, status: seen.status } };
  let eventId: string;
  try {
    const ev = await prisma.syncEvent.create({
      data: {
        organizationId: integration.organizationId, integrationId: integration.id, provider: integration.provider, direction: 'INBOUND',
        externalEventId, type: normalized.type, payload: safeJson(rawBody),
        normalized: normalized as unknown as Prisma.InputJsonValue, status: 'PENDING', nextAttemptAt: opts.now ?? new Date(),
      },
    });
    eventId = ev.id;
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    const dup = await prisma.syncEvent.findUnique({ where: { provider_externalEventId: { provider: integration.provider, externalEventId } } });
    return { status: 200, body: { ok: true, duplicate: true, id: dup?.id, status: dup?.status } };
  }

  let status: SyncStatus = 'PENDING';
  if (opts.processInline !== false) {
    try { status = (await processSyncEvent(eventId, { now: opts.now })).status ?? 'PENDING'; } catch (e) { console.error('[sync] inline processing failed', e); }
  }
  return { status: 200, body: { ok: true, id: eventId, status } };
}

// ───────────────────────── Processing ─────────────────────────

export interface ProcessOptions {
  now?: Date;
  /** Reconciliation: allow seat-capacity overrun. */
  force?: boolean;
  /** Reconciliation: register without the (conflicting) mapped staff. */
  dropStaff?: boolean;
  /** Also claim events in these statuses (manual retry of DEAD/CONFLICT). */
  alsoFrom?: SyncStatus[];
}

export interface ProcessResult { claimed: boolean; status?: SyncStatus; error?: string; deferred?: boolean }

/** Atomically claim an event (status → PROCESSING, attempts+1). Concurrent claimers get false. */
async function claim(id: string, now: Date, alsoFrom: SyncStatus[] = []): Promise<boolean> {
  const r = await prisma.syncEvent.updateMany({
    where: {
      id,
      OR: [
        { status: { in: ['PENDING', 'FAILED', ...alsoFrom] } },
        { status: 'PROCESSING', nextAttemptAt: { lte: now } }, // expired lease
      ],
    },
    data: { status: 'PROCESSING', attempts: { increment: 1 }, nextAttemptAt: new Date(now.getTime() + LEASE_MS) },
  });
  return r.count === 1;
}

export async function processSyncEvent(id: string, opts: ProcessOptions = {}): Promise<ProcessResult> {
  const now = opts.now ?? new Date();
  if (!(await claim(id, now, opts.alsoFrom))) return { claimed: false };
  const ev = await prisma.syncEvent.findUniqueOrThrow({ where: { id } });
  const integration = ev.integrationId ? await prisma.integration.findUnique({ where: { id: ev.integrationId } }) : null;

  const fail = async (status: SyncStatus, message: string, extra: Prisma.SyncEventUpdateInput = {}) => {
    await prisma.syncEvent.update({ where: { id }, data: { status, lastError: message.slice(0, 2000), ...extra } });
    if (integration) await prisma.integration.update({ where: { id: integration.id }, data: { lastError: message.slice(0, 500) } });
    return { claimed: true, status, error: message };
  };

  let normalized = ev.normalized as unknown as StoredNormalized | null;
  try {
    if (ev.direction === 'OUTBOUND') return await processOutbound(ev, integration, now);
    if (!integration) return await fail('DEAD', '連携設定が見つかりません（削除された可能性があります）');
    const adapter = getBookingAdapter(integration.provider);
    if (!adapter) return await fail('DEAD', `未対応のプロバイダです: ${integration.provider}`);

    if (!normalized?.bookings) {
      try { normalized = adapter.normalizeWebhook(JSON.stringify(ev.payload)); } catch (e: any) {
        return await fail('DEAD', e instanceof NormalizeError ? e.message : String(e?.message ?? e));
      }
    }
    const n = normalized;

    // In-order processing per external booking: while an older event for the same booking is
    // still unfinished, defer this one (no attempt consumed). Row-based, so it never holds a
    // DB connection across the booking engine's own transactions.
    if (!opts.force && (await hasOlderUnfinished(ev, integration.provider, n.bookings.map((b) => b.externalId), now))) {
      await prisma.syncEvent.update({ where: { id }, data: { status: 'PENDING', attempts: { decrement: 1 }, nextAttemptAt: new Date(now.getTime() + 15_000) } });
      return { claimed: false, status: 'PENDING', deferred: true };
    }

    const config = readConfig(integration.configEnc);
    const out: Outcome = { at: now.toISOString(), items: [] };
    const applied: Record<string, number> = { ...(n.applied ?? {}) };
    for (const b of n.bookings) {
      const item = await applyBooking(ev.organizationId, integration, config, b, opts, now);
      out.items.push(item);
      if (item.action !== 'stale') applied[b.externalId] = b.version ?? 0;
    }
    const firstAppt = out.items.find((i) => i.appointmentId)?.appointmentId ?? null;
    await prisma.syncEvent.update({
      where: { id },
      data: {
        status: 'DONE', processedAt: now, lastError: null, appointmentId: firstAppt ?? ev.appointmentId,
        normalized: { ...n, applied, outcome: out } as unknown as Prisma.InputJsonValue,
      },
    });
    await prisma.integration.update({ where: { id: integration.id }, data: { lastSyncAt: now, lastError: null } });
    for (const it of out.items) {
      if (it.appointmentId && ['created', 'updated', 'cancelled'].includes(it.action)) {
        await propagateAppointmentChange(it.appointmentId, { originProvider: integration.provider }).catch((e) => console.error('[sync] propagate failed', e));
      }
    }
    return { claimed: true, status: 'DONE' };
  } catch (e: any) {
    if (e instanceof ConflictError) {
      return await fail('CONFLICT', e.message, {
        normalized: { ...(normalized ?? {}), outcome: { at: now.toISOString(), items: [], conflict: e.detail } } as unknown as Prisma.InputJsonValue,
      });
    }
    const message = e instanceof AppError ? e.message : `${e?.name ?? 'Error'}: ${e?.message ?? e}`;
    if (!(e instanceof AppError)) console.error('[sync] processing error', id, e);
    const extra: Prisma.SyncEventUpdateInput = normalized && !ev.normalized ? { normalized: normalized as unknown as Prisma.InputJsonValue } : {};
    if (e instanceof PermanentSyncError) return await fail('DEAD', message, extra);
    // ev.attempts already includes this attempt (incremented by claim()).
    if (ev.attempts >= MAX_SYNC_ATTEMPTS) return await fail('DEAD', message, extra);
    return await fail('FAILED', message, { ...extra, nextAttemptAt: new Date(now.getTime() + backoffMs(ev.attempts)) });
  }
}

/** True when an older INBOUND event for any of these external bookings is not finished yet. */
async function hasOlderUnfinished(ev: { id: string; organizationId: string; createdAt: Date }, provider: string, externalIds: string[], now: Date): Promise<boolean> {
  for (const externalId of externalIds) {
    const probe = JSON.stringify([{ externalId }]);
    const rows = await prisma.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "SyncEvent"
      WHERE "organizationId" = ${ev.organizationId} AND "provider" = ${provider} AND "direction" = 'INBOUND' AND "id" <> ${ev.id}
        AND ("createdAt", "id") < (SELECT "createdAt", "id" FROM "SyncEvent" WHERE "id" = ${ev.id})
        AND ("status" IN ('PENDING', 'FAILED') OR ("status" = 'PROCESSING' AND "nextAttemptAt" > (${now.toISOString()}::timestamptz AT TIME ZONE 'UTC')))
        AND "normalized"->'bookings' @> ${probe}::jsonb
      LIMIT 1`;
    if (rows.length) return true;
  }
  return false;
}

class ConflictError extends AppError {
  constructor(message: string, public detail: NonNullable<Outcome['conflict']>) { super(message, 'SYNC_CONFLICT', 409); }
}

interface ResolvedTarget { shopId: string; staffId: string | null; customerId: string; menus: MenuLine[] }

async function resolveShop(orgId: string, integration: { shopId: string | null }, config: IntegrationConfig, b: ExternalBooking): Promise<string> {
  let shopId: string | null = integration.shopId;
  if (!shopId && b.shopExternalId && config.shopMap && typeof config.shopMap === 'object') shopId = config.shopMap[b.shopExternalId] ?? null;
  if (!shopId) {
    const shops = await prisma.shop.findMany({ where: { organizationId: orgId, active: true }, select: { id: true }, take: 2 });
    if (shops.length === 1) shopId = shops[0].id;
  }
  if (!shopId) throw new AppError('予約先の店舗を特定できません（連携設定で店舗を指定してください）');
  const shop = await prisma.shop.findFirst({ where: { id: shopId, organizationId: orgId }, select: { id: true } });
  if (!shop) throw new AppError('連携設定の店舗が見つかりません');
  return shop.id;
}

async function resolveStaff(orgId: string, config: IntegrationConfig, b: ExternalBooking): Promise<string | null> {
  if (!b.staffExternalId || !config.staffMap || typeof config.staffMap !== 'object') return null;
  const userId = config.staffMap[b.staffExternalId];
  if (!userId || typeof userId !== 'string') return null;
  const m = await prisma.membership.findFirst({ where: { organizationId: orgId, userId, active: true }, select: { userId: true } });
  return m?.userId ?? null;
}

async function resolveMenus(shopId: string, b: ExternalBooking): Promise<MenuLine[]> {
  const names = (b.menuNames ?? []).map((n) => n.trim()).filter(Boolean);
  const durationMin = Math.max(15, Math.round((Date.parse(b.endAt) - Date.parse(b.startAt)) / 60000));
  if (!names.length) return [{ name: '外部予約', price: b.totalPrice ?? 0, durationMin }];
  const menus = await prisma.menu.findMany({ where: { shopId, name: { in: names } }, select: { id: true, name: true, price: true, durationMin: true, active: true } });
  const byName = new Map(menus.sort((a, b2) => Number(b2.active) - Number(a.active)).map((m) => [m.name, m]));
  const lines: MenuLine[] = names.map((n) => {
    const m = byName.get(n);
    return m ? { menuId: m.id, name: m.name, price: m.price, durationMin: m.durationMin } : { name: n, price: 0, durationMin: 0 };
  });
  // Synthetic lines carry the provider's total so the appointment price is right.
  const known = lines.reduce((s, l) => s + l.price, 0);
  if (b.totalPrice !== undefined && b.totalPrice > known) {
    const synthetic = lines.filter((l) => !l.menuId);
    if (synthetic.length) synthetic[0].price += b.totalPrice - known;
  }
  const sumDur = lines.reduce((s, l) => s + l.durationMin, 0);
  if (sumDur !== durationMin) {
    const target = lines.find((l) => !l.menuId) ?? lines[lines.length - 1];
    target.durationMin = Math.max(0, target.durationMin + durationMin - sumDur);
  }
  return lines;
}

async function resolveTarget(orgId: string, integration: { provider: string; shopId: string | null }, config: IntegrationConfig, b: ExternalBooking, opts: ProcessOptions): Promise<ResolvedTarget> {
  const shopId = await resolveShop(orgId, integration, config, b);
  const staffId = opts.dropStaff ? null : await resolveStaff(orgId, config, b);
  const ph = phoneHash(b.customer.phone);
  const externalId = b.customer.externalCustomerId ?? (ph ? `tel:${ph}` : null);
  const { customerId } = await resolveCustomer(prisma, {
    orgId, shopId, name: b.customer.name, kana: b.customer.kana ?? null,
    phone: normalizePhone(b.customer.phone) ?? b.customer.phone ?? null, email: b.customer.email ?? null,
    identity: externalId ? { provider: integration.provider, externalId, displayName: b.customer.name } : null,
  });
  return { shopId, staffId, customerId, menus: await resolveMenus(shopId, b) };
}

async function lastAppliedVersion(orgId: string, provider: string, externalId: string): Promise<number | null> {
  const rows = await prisma.$queryRaw<{ v: number | null }[]>`
    SELECT MAX(("normalized"->'applied'->>${externalId})::double precision) AS v
    FROM "SyncEvent"
    WHERE "organizationId" = ${orgId} AND "provider" = ${provider} AND "direction" = 'INBOUND' AND "status" = 'DONE'
      AND jsonb_exists("normalized"->'applied', ${externalId})`;
  return rows[0]?.v ?? null;
}

async function applyBooking(orgId: string, integration: { id: string; provider: string; shopId: string | null }, config: IntegrationConfig, b: ExternalBooking, opts: ProcessOptions, now: Date): Promise<Outcome['items'][number]> {
  const provider = integration.provider;
  const version = b.version ?? null;
  if (version !== null && Number.isFinite(version)) {
    const last = await lastAppliedVersion(orgId, provider, b.externalId);
    if (last !== null && version <= last) return { externalId: b.externalId, action: 'stale', version, note: `適用済みバージョン ${last} 以下のため破棄` };
  }
  const ref = externalRefFor(provider, integration.id, b.externalId);
  const existing = await prisma.appointment.findFirst({
    where: { organizationId: orgId, externalProvider: provider, externalRef: ref },
    include: { menus: true },
  });
  const startAt = new Date(b.startAt), endAt = new Date(b.endAt);

  if (b.status === 'cancelled') {
    if (!existing) return { externalId: b.externalId, action: 'cancel_unknown', version, note: '未登録の予約のキャンセル通知' };
    if (existing.status === 'CANCELLED') return { externalId: b.externalId, action: 'unchanged', appointmentId: existing.id, version };
    if (existing.status === 'COMPLETED' || existing.status === 'NO_SHOW') return { externalId: b.externalId, action: 'unchanged', appointmentId: existing.id, version, note: '来店処理済みのためキャンセルを適用しませんでした' };
    await changeAppointmentStatus(orgId, existing.id, 'CANCELLED', { reason: '外部予約サイトでキャンセル', force: true });
    return { externalId: b.externalId, action: 'cancelled', appointmentId: existing.id, version };
  }

  const target = await resolveTarget(orgId, integration, config, b, opts);
  const conflict = (e: BookingError): never => {
    throw new ConflictError(e.message, {
      externalId: b.externalId, reason: e.reason, message: e.message, shopId: target.shopId, staffId: target.staffId,
      startAt: startAt.toISOString(), endAt: endAt.toISOString(),
    });
  };

  if (!existing) {
    try {
      const r = await createAppointment({
        orgId, shopId: target.shopId, customerId: target.customerId, staffId: target.staffId, startAt, endAt, menus: target.menus,
        source: PROVIDER_SOURCE[provider] ?? 'OTHER', status: 'CONFIRMED', nominated: !!target.staffId,
        customerNote: b.note ?? null, externalProvider: provider, externalRef: ref,
        idempotencyKey: `${provider}:${b.externalId}:v${version ?? 0}`, allowOverCapacity: !!opts.force, now,
      });
      return { externalId: b.externalId, action: 'created', appointmentId: r.appointmentId, version, note: r.warnings.length ? `警告: ${r.warnings.join(',')}` : undefined };
    } catch (e: any) {
      if (e instanceof BookingError) conflict(e);
      if (e?.code === 'P2002' && String(e?.meta?.target ?? '').includes('externalRef')) {
        throw new PermanentSyncError(`外部予約ID「${b.externalId}」は別の組織の予約で使用されています。プロバイダ側の予約IDを確認してください。`);
      }
      throw e;
    }
  }

  try {
    const inactive = !(ACTIVE_STATUSES as readonly string[]).includes(existing.status);
    if (inactive) await changeAppointmentStatus(orgId, existing.id, 'CONFIRMED', { force: true });
    const menusChanged = JSON.stringify(existing.menus.map((m) => [m.menuId, m.name, m.price]).sort()) !== JSON.stringify(target.menus.map((m) => [m.menuId ?? null, m.name, m.price]).sort());
    const changed = existing.startAt.getTime() !== startAt.getTime() || existing.endAt.getTime() !== endAt.getTime()
      || existing.staffId !== target.staffId || existing.shopId !== target.shopId || menusChanged;
    if (changed) {
      await updateAppointment({
        orgId, id: existing.id, startAt, endAt, staffId: target.staffId, shopId: target.shopId,
        menus: menusChanged ? target.menus : undefined, allowOverCapacity: !!opts.force, now,
      });
    }
    return { externalId: b.externalId, action: changed || inactive ? 'updated' : 'unchanged', appointmentId: existing.id, version };
  } catch (e) {
    if (e instanceof BookingError) conflict(e);
    throw e;
  }
}

/** Cron entry point: process due PENDING/FAILED events (and expired leases). */
export async function processPendingSyncEvents(now: Date = new Date()): Promise<{ processed: number; failed: number }> {
  const due = await prisma.syncEvent.findMany({
    where: { status: { in: ['PENDING', 'FAILED', 'PROCESSING'] }, nextAttemptAt: { lte: now } },
    orderBy: { createdAt: 'asc' }, take: 100, select: { id: true },
  });
  let processed = 0, failed = 0;
  for (const { id } of due) {
    const r = await processSyncEvent(id, { now }).catch((e) => { console.error('[sync] cron error', id, e); return { claimed: true, status: 'FAILED' as SyncStatus }; });
    if (!r.claimed) continue;
    if (r.status === 'DONE' || r.status === 'CONFLICT') processed++;
    else failed++;
  }
  return { processed, failed };
}

// ───────────────────────── Outbound ─────────────────────────

/**
 * Record outbound propagation for integrations whose adapter can push bookings/availability.
 * Never propagates back to the provider the change came from (loop prevention).
 * Placeholder adapters have no push capability → no-op.
 */
export async function propagateAppointmentChange(appointmentId: string, opts: { originProvider?: string | null } = {}): Promise<number> {
  const appt = await prisma.appointment.findUnique({ where: { id: appointmentId }, select: { id: true, organizationId: true, shopId: true, externalProvider: true, source: true, updatedAt: true } });
  if (!appt) return 0;
  const origin = new Set([opts.originProvider, appt.externalProvider].filter(Boolean) as string[]);
  const integrations = await prisma.integration.findMany({
    where: { organizationId: appt.organizationId, status: 'ACTIVE', provider: { in: [...BOOKING_PROVIDERS] }, OR: [{ shopId: null }, { shopId: appt.shopId }] },
  });
  let n = 0;
  for (const it of integrations) {
    // Loop prevention: never echo a change back to the provider it came from.
    if (origin.has(it.provider)) continue;
    if (it.provider !== 'GENERIC' && it.provider !== 'OTHER' && PROVIDER_SOURCE[it.provider] === appt.source) continue;
    const adapter = getBookingAdapter(it.provider);
    if (!adapter?.pushBooking && !adapter?.pushAvailability) continue;
    try {
      await prisma.syncEvent.create({
        data: {
          organizationId: appt.organizationId, integrationId: it.id, provider: it.provider, direction: 'OUTBOUND',
          externalEventId: `out:${it.id}:${appt.id}:${appt.updatedAt.getTime()}`, type: 'booking.push',
          payload: { appointmentId: appt.id }, status: 'PENDING', appointmentId: appt.id,
        },
      });
      n++;
    } catch (e) { if (!isUniqueViolation(e)) throw e; }
  }
  return n;
}

async function processOutbound(ev: { id: string; appointmentId: string | null; organizationId: string }, integration: { id: string; provider: string; configEnc: string | null } | null, now: Date): Promise<ProcessResult> {
  const adapter = integration ? getBookingAdapter(integration.provider) : null;
  const appt = ev.appointmentId ? await prisma.appointment.findFirst({ where: { id: ev.appointmentId, organizationId: ev.organizationId }, include: { customer: true, menus: true, shop: true } }) : null;
  if (!integration || !adapter || !appt) {
    await prisma.syncEvent.update({ where: { id: ev.id }, data: { status: 'DONE', processedAt: now, lastError: null, normalized: { outcome: { at: now.toISOString(), items: [], note: '送信対象なし' } } as unknown as Prisma.InputJsonValue } });
    return { claimed: true, status: 'DONE' };
  }
  const config = readConfig(integration.configEnc);
  const staffReverse = Object.fromEntries(Object.entries((config.staffMap ?? {}) as Record<string, string>).map(([k, v]) => [v, k]));
  let action: Outcome['items'][number]['action'] = 'noop';
  if (appt.status === 'CANCELLED' || appt.status === 'NO_SHOW') {
    if (adapter.cancelBooking && appt.externalProvider === integration.provider && appt.externalRef) { await adapter.cancelBooking(providerBookingId(integration.provider, appt.externalRef), config); action = 'pushed'; }
  } else if (adapter.pushBooking) {
    await adapter.pushBooking({
      externalId: appt.id, customer: { name: appt.customer ? `${appt.customer.lastName} ${appt.customer.firstName}`.trim() : appt.guestName ?? 'ゲスト' },
      staffExternalId: appt.staffId ? staffReverse[appt.staffId] : undefined,
      startAt: appt.startAt.toISOString(), endAt: appt.endAt.toISOString(), status: 'confirmed', menuNames: appt.menus.map((m) => m.name),
    }, config);
    action = 'pushed';
  }
  if (adapter.pushAvailability) { await adapter.pushAvailability(appt.startAt.toISOString(), appt.endAt.toISOString(), config); action = 'pushed'; }
  await prisma.syncEvent.update({
    where: { id: ev.id },
    data: { status: 'DONE', processedAt: now, lastError: null, normalized: { outcome: { at: now.toISOString(), items: [{ externalId: appt.id, action, appointmentId: appt.id }] } } as unknown as Prisma.InputJsonValue },
  });
  await prisma.integration.update({ where: { id: integration.id }, data: { lastSyncAt: now, lastError: null } });
  return { claimed: true, status: 'DONE' };
}

// ───────────────────────── Reconciliation (staff actions) ─────────────────────────

async function eventInOrg(orgId: string, id: string) {
  const ev = await prisma.syncEvent.findFirst({ where: { id, organizationId: orgId } });
  if (!ev) throw new NotFoundError('同期イベントが見つかりません');
  return ev;
}

/** Retry now. DEAD/CONFLICT events get a fresh attempt budget. */
export async function retrySyncEvent(orgId: string, id: string, now = new Date()) {
  const ev = await eventInOrg(orgId, id);
  if (ev.status === 'DONE' || ev.status === 'PROCESSING') throw new AppError('この同期イベントは再試行できません');
  await prisma.syncEvent.update({ where: { id }, data: { status: 'PENDING', nextAttemptAt: now, attempts: ev.status === 'DEAD' || ev.status === 'CONFLICT' ? 0 : ev.attempts } });
  return processSyncEvent(id, { now });
}

/** Reconciliation: apply a CONFLICT event allowing seat overrun (and optionally without staff). */
export async function forceApplySyncEvent(orgId: string, id: string, opts: { dropStaff?: boolean } = {}, now = new Date()) {
  const ev = await eventInOrg(orgId, id);
  if (ev.status !== 'CONFLICT' && ev.status !== 'FAILED' && ev.status !== 'DEAD') throw new AppError('競合・失敗状態のイベントのみ強制登録できます');
  return processSyncEvent(id, { now, force: true, dropStaff: opts.dropStaff, alsoFrom: ['CONFLICT', 'DEAD'] });
}

/** Mark as handled without applying. */
export async function ignoreSyncEvent(orgId: string, id: string, note: string, now = new Date()) {
  const ev = await eventInOrg(orgId, id);
  if (ev.status === 'DONE' || ev.status === 'PROCESSING') throw new AppError('このイベントは無視できません');
  const n = (ev.normalized ?? {}) as unknown as StoredNormalized;
  await prisma.syncEvent.update({
    where: { id },
    data: {
      status: 'DONE', processedAt: now, lastError: `無視: ${note || '手動で対応済み'}`.slice(0, 2000),
      normalized: { ...n, outcome: { at: now.toISOString(), items: (n.bookings ?? []).map((b) => ({ externalId: b.externalId, action: 'ignored' as const })), note: note || '手動で対応済み' } } as unknown as Prisma.InputJsonValue,
    },
  });
}

/** Reconciliation: attach the external booking to an existing appointment instead of creating one. */
export async function linkSyncEventToAppointment(orgId: string, id: string, appointmentId: string, now = new Date()) {
  const ev = await eventInOrg(orgId, id);
  if (ev.status === 'DONE' || ev.status === 'PROCESSING') throw new AppError('このイベントは処理済みです');
  const n = ev.normalized as unknown as StoredNormalized | null;
  const b = n?.bookings?.[0];
  if (!b) throw new AppError('正規化済みの予約データがありません');
  const appt = await prisma.appointment.findFirst({ where: { id: appointmentId, organizationId: orgId } });
  if (!appt) throw new NotFoundError('紐付け先の予約が見つかりません');
  const ref = externalRefFor(ev.provider, ev.integrationId, b.externalId);
  if (appt.externalRef && !(appt.externalProvider === ev.provider && appt.externalRef === ref)) throw new AppError('この予約は既に別の外部予約と紐付いています');
  const clash = await prisma.appointment.findFirst({ where: { externalProvider: ev.provider, externalRef: ref, id: { not: appt.id } } });
  if (clash) throw new AppError('この外部予約は既に別の予約と紐付いています');
  await prisma.$transaction(async (tx) => {
    await tx.appointment.update({ where: { id: appt.id }, data: { externalProvider: ev.provider, externalRef: ref } });
    await tx.syncEvent.update({
      where: { id },
      data: {
        status: 'DONE', processedAt: now, lastError: null, appointmentId: appt.id,
        normalized: { ...n, applied: { ...(n?.applied ?? {}), [b.externalId]: b.version ?? 0 }, outcome: { at: now.toISOString(), items: [{ externalId: b.externalId, action: 'linked', appointmentId: appt.id }] } } as unknown as Prisma.InputJsonValue,
      },
    });
  });
  return appt.id;
}

/** Existing appointments overlapping a CONFLICT event's booking window (for the reconciliation screen). */
export async function conflictCandidates(orgId: string, ev: { normalized: Prisma.JsonValue | null; integrationId: string | null }) {
  const n = ev.normalized as unknown as StoredNormalized | null;
  const b = n?.bookings?.[0];
  if (!b) return [];
  const c = n?.outcome?.conflict;
  let shopId = c?.shopId ?? null;
  if (!shopId && ev.integrationId) shopId = (await prisma.integration.findFirst({ where: { id: ev.integrationId, organizationId: orgId } }))?.shopId ?? null;
  const start = new Date(b.startAt), end = new Date(b.endAt);
  const margin = 60 * 60_000;
  return prisma.appointment.findMany({
    where: {
      organizationId: orgId, ...(shopId ? { shopId } : {}), status: { in: [...ACTIVE_STATUSES] },
      startAt: { lt: new Date(end.getTime() + margin) }, endAt: { gt: new Date(start.getTime() - margin) },
    },
    include: { customer: { select: { id: true, lastName: true, firstName: true } }, menus: { select: { name: true } }, staff: { select: { name: true } } },
    orderBy: { startAt: 'asc' }, take: 30,
  });
}

export type { StoredNormalized, Outcome as SyncOutcome };
