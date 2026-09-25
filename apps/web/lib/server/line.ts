// LINE Messaging API integration: webhook event processing (idempotent), profile
// lookup, reply helpers and a rich-menu generator for the "予約する" entry.
//
// Integration row: provider 'LINE', configEnc {channelSecret, channelAccessToken, channelId}, webhookKey.
// Webhook URL to register in the LINE Developers console: `${APP_URL}/api/webhooks/line/<webhookKey>`.
import { randomUUID } from 'node:crypto';
import type { Integration } from '@salonos/db';
import type { LineInbound } from '@salonos/core/integrations/line';
import { prisma } from './db';
import { env } from './env';
import { readConfig, type IntegrationConfig } from './integrations';
import { resolveCustomer } from './customers';
import { sendCustomerMessage } from './notify';
import { signLineLink } from './line-link';

const LINE_API = 'https://api.line.me/v2/bot';
const FETCH_TIMEOUT_MS = 4000;
export const LINE_FALLBACK_NAME = 'LINEのお客様';

export interface LineIntegrationRef { id: string; organizationId: string; shopId: string | null; status?: string; config: IntegrationConfig }

export function lineAccessToken(integration: Pick<LineIntegrationRef, 'config'>): string {
  return integration.config.channelAccessToken || env.line.accessToken || '';
}

/** Channel secret for signature verification; env fallback only when the integration has none. */
export function lineChannelSecret(integration: Pick<LineIntegrationRef, 'config'>): string {
  return integration.config.channelSecret || env.line.channelSecret || '';
}

export async function findLineIntegrationByKey(webhookKey: string): Promise<LineIntegrationRef | null> {
  if (!webhookKey || webhookKey.length > 64) return null;
  const it = await prisma.integration.findUnique({ where: { webhookKey } });
  if (!it || it.provider !== 'LINE') return null;
  return toRef(it);
}

export function toRef(it: Integration): LineIntegrationRef {
  return { id: it.id, organizationId: it.organizationId, shopId: it.shopId, status: it.status, config: readConfig(it.configEnc) };
}

// ───────────────────────── API helpers ─────────────────────────

export interface LineProfile { userId: string; displayName: string; pictureUrl?: string; statusMessage?: string }

/** GET /v2/bot/profile/{userId}. Returns null without a token or on any error. */
export async function fetchLineProfile(token: string, userId: string): Promise<LineProfile | null> {
  if (!token) return null;
  try {
    const res = await fetch(`${LINE_API}/profile/${encodeURIComponent(userId)}`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const j = await res.json();
    return typeof j?.displayName === 'string' ? j as LineProfile : null;
  } catch { return null; }
}

/** Reply API (free, single-use replyToken valid ~1 min). Prefer sendCustomerMessage for logged pushes. */
export async function lineReply(token: string, replyToken: string, texts: string[]): Promise<{ ok: boolean; error?: string }> {
  if (!token) return { ok: true };
  try {
    const res = await fetch(`${LINE_API}/message/reply`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ replyToken, messages: texts.slice(0, 5).map((text) => ({ type: 'text', text: text.slice(0, 5000) })) }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    return res.ok ? { ok: true } : { ok: false, error: `LINE API ${res.status}` };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/**
 * Rich menu definition with one full-width "予約する" area.
 * - mode 'postback' (recommended): sends `action=book`; the webhook replies with a personal,
 *   signed booking URL so the booking is attached to the customer's LINE identity.
 * - mode 'uri': opens the public booking page directly (no identity linkage).
 * Create via POST https://api.line.me/v2/bot/richmenu, upload a 2500x843 image to
 * /richmenu/{id}/content, then POST /user/all/richmenu/{id} to make it the default.
 */
export function buildBookingRichMenu(opts: { shopName: string; bookingUrl: string; mode?: 'postback' | 'uri' }) {
  const action = (opts.mode ?? 'postback') === 'postback'
    ? { type: 'postback', label: '予約する', data: 'action=book', displayText: '予約したい' }
    : { type: 'uri', label: '予約する', uri: `${opts.bookingUrl}${opts.bookingUrl.includes('?') ? '&' : '?'}src=line` };
  return {
    size: { width: 2500, height: 843 },
    selected: true,
    name: `${opts.shopName} 予約メニュー`.slice(0, 300),
    chatBarText: '予約はこちら',
    areas: [{ bounds: { x: 0, y: 0, width: 2500, height: 843 }, action }],
  };
}

export async function lineBookingUrl(orgId: string, shopId: string | null, lineUserId: string) {
  const shop = shopId
    ? await prisma.shop.findFirst({ where: { id: shopId, organizationId: orgId } })
    : await prisma.shop.findFirst({ where: { organizationId: orgId, active: true }, orderBy: { createdAt: 'asc' } });
  if (!shop) return null;
  return { url: `${env.appUrl}/book/${shop.slug}?lk=${signLineLink(orgId, lineUserId)}`, shopName: shop.name };
}

// ───────────────────────── Webhook processing ─────────────────────────

export interface RecordedEvent { rowId: string; event: LineInbound }
export interface LineHandleResult { received: number; duplicates: number; processed: number; failed: number }

/**
 * Persist events in WebhookEvent with unique (provider, eventId). Returns only events that
 * were not seen before — replays and LINE redeliveries are dropped here.
 */
export async function recordLineEvents(orgId: string, integration: Pick<LineIntegrationRef, 'id'>, events: LineInbound[]): Promise<{ fresh: RecordedEvent[]; duplicates: number }> {
  const fresh: RecordedEvent[] = [];
  let duplicates = 0;
  for (const ev of events) {
    const payload = JSON.stringify({ orgId, integrationId: integration.id, event: ev });
    // INSERT … ON CONFLICT DO NOTHING: the unique (provider, eventId) index is the idempotency guard.
    const rows = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO "WebhookEvent" (id, provider, "eventId", type, payload, status, "createdAt")
      VALUES (${`lwe_${randomUUID()}`}, 'LINE', ${ev.eventId}, ${ev.type}, ${payload}::jsonb, 'RECEIVED', NOW())
      ON CONFLICT (provider, "eventId") DO NOTHING
      RETURNING id`;
    if (rows.length) fresh.push({ rowId: rows[0].id, event: ev });
    else duplicates++;
  }
  return { fresh, duplicates };
}

async function ensureCustomer(integration: LineIntegrationRef, userId: string, opts: { fetchProfile: boolean }) {
  const orgId = integration.organizationId;
  const existing = await prisma.customerIdentity.findUnique({ where: { organizationId_provider_externalId: { organizationId: orgId, provider: 'LINE', externalId: userId } } });
  const profile = opts.fetchProfile || !existing ? await fetchLineProfile(lineAccessToken(integration), userId) : null;
  const displayName = profile?.displayName ?? existing?.displayName ?? LINE_FALLBACK_NAME;
  const { customerId } = await prisma.$transaction((tx) => resolveCustomer(tx, {
    orgId, shopId: integration.shopId, name: displayName, identity: { provider: 'LINE', externalId: userId, displayName },
  }));
  if (existing && profile && profile.displayName !== existing.displayName) {
    await prisma.customerIdentity.update({ where: { id: existing.id }, data: { displayName: profile.displayName } });
  }
  return customerId;
}

async function sendBookingLink(integration: LineIntegrationRef, customerId: string, userId: string) {
  const link = await lineBookingUrl(integration.organizationId, integration.shopId, userId);
  if (!link) return;
  await sendCustomerMessage({
    orgId: integration.organizationId, shopId: integration.shopId, customerId, channel: 'LINE',
    body: `${link.shopName}のご予約はこちらから承ります。\n${link.url}\n※このリンクはお客様専用です（7日間有効）。`,
  });
}

function wantsBooking(ev: LineInbound) {
  if (ev.type === 'postback') {
    const p = new URLSearchParams(ev.postbackData ?? '');
    return p.get('action') === 'book';
  }
  return ev.type === 'message' && !!ev.text && ev.text.includes('予約');
}

/** Apply one normalized LINE event to the domain. */
export async function processLineEvent(integration: LineIntegrationRef, ev: LineInbound): Promise<string> {
  const orgId = integration.organizationId;
  if (!ev.userId) return 'ignored:no-user';
  switch (ev.type) {
    case 'follow': {
      const customerId = await ensureCustomer(integration, ev.userId, { fetchProfile: true });
      await prisma.customer.update({ where: { id: customerId }, data: { lineOptIn: true } });
      return 'follow';
    }
    case 'unfollow': {
      const ident = await prisma.customerIdentity.findUnique({ where: { organizationId_provider_externalId: { organizationId: orgId, provider: 'LINE', externalId: ev.userId } } });
      if (!ident) return 'ignored:unknown-user';
      await prisma.customer.updateMany({ where: { id: ident.customerId, organizationId: orgId }, data: { lineOptIn: false } });
      return 'unfollow';
    }
    case 'message': {
      const customerId = await ensureCustomer(integration, ev.userId, { fetchProfile: false });
      await prisma.message.create({
        data: {
          organizationId: orgId, shopId: integration.shopId, customerId, channel: 'LINE', direction: 'INBOUND', status: 'RECEIVED',
          body: (ev.text ?? '[メッセージ]').slice(0, 5000), externalMessageId: ev.eventId, createdAt: new Date(ev.timestamp || Date.now()),
        },
      });
      if (wantsBooking(ev)) await sendBookingLink(integration, customerId, ev.userId);
      return 'message';
    }
    case 'postback': {
      if (!wantsBooking(ev)) return 'ignored:postback';
      const customerId = await ensureCustomer(integration, ev.userId, { fetchProfile: false });
      await sendBookingLink(integration, customerId, ev.userId);
      return 'postback:book';
    }
    default:
      return 'ignored';
  }
}

export async function processRecordedLineEvents(integration: LineIntegrationRef, recorded: RecordedEvent[]): Promise<{ processed: number; failed: number }> {
  let processed = 0, failed = 0;
  for (const r of recorded) {
    try {
      const outcome = await processLineEvent(integration, r.event);
      await prisma.webhookEvent.update({ where: { id: r.rowId }, data: { status: outcome.startsWith('ignored') ? 'IGNORED' : 'PROCESSED', processedAt: new Date(), error: null } });
      processed++;
    } catch (e: any) {
      failed++;
      console.error('[line-webhook]', r.event.eventId, e);
      await prisma.webhookEvent.update({ where: { id: r.rowId }, data: { status: 'FAILED', error: String(e?.message ?? e).slice(0, 500) } }).catch(() => undefined);
    }
  }
  return { processed, failed };
}

/**
 * Record (dedupe) and process a batch of normalized events for an integration.
 * The webhook route records synchronously and processes after responding; tests call this.
 */
export async function handleLineEvents(orgId: string, integration: LineIntegrationRef, events: LineInbound[]): Promise<LineHandleResult> {
  if (integration.organizationId !== orgId) throw new Error('integration/org mismatch');
  const { fresh, duplicates } = await recordLineEvents(orgId, integration, events);
  const r = await processRecordedLineEvents(integration, fresh);
  return { received: events.length, duplicates, ...r };
}

/**
 * Safety net for events recorded but never processed (e.g. the instance died after
 * responding 200). Called from the cron job.
 */
export async function retryPendingLineEvents(now = new Date()): Promise<{ processed: number; failed: number }> {
  const stuck = await prisma.webhookEvent.findMany({
    where: { provider: 'LINE', status: 'RECEIVED', createdAt: { lt: new Date(now.getTime() - 2 * 60_000) } },
    orderBy: { createdAt: 'asc' }, take: 100,
  });
  let processed = 0, failed = 0;
  const cache = new Map<string, LineIntegrationRef | null>();
  for (const row of stuck) {
    const p = row.payload as { orgId?: string; integrationId?: string; event?: LineInbound };
    if (!p?.integrationId || !p.event) {
      await prisma.webhookEvent.update({ where: { id: row.id }, data: { status: 'IGNORED', error: 'missing payload' } });
      continue;
    }
    if (!cache.has(p.integrationId)) {
      const it = await prisma.integration.findUnique({ where: { id: p.integrationId } });
      cache.set(p.integrationId, it && it.provider === 'LINE' ? toRef(it) : null);
    }
    const it = cache.get(p.integrationId);
    if (!it) {
      await prisma.webhookEvent.update({ where: { id: row.id }, data: { status: 'IGNORED', error: 'integration removed' } });
      continue;
    }
    const r = await processRecordedLineEvents(it, [{ rowId: row.id, event: p.event }]);
    processed += r.processed; failed += r.failed;
  }
  return { processed, failed };
}
