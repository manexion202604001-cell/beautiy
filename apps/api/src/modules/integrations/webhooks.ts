import type { FastifyReply, FastifyRequest } from 'fastify';
import { systemActor } from '../../auth/actor.js';
import { withSystem, withTenant } from '../../db/tenant.js';
import { enqueue, PermanentJobError, registerJob, type JobRow } from '../../jobs/queue.js';
import { decryptJson, hmacSha256, safeEqual, sha256 } from '../../lib/crypto.js';
import { Errors } from '../../lib/errors.js';
import { getWebhookProvider, registerWebhookProvider, type VerifiedWebhook } from '../../lib/webhooks.js';
import { loadAccountRow } from './accounts.js';
import { MOCK_PROVIDER } from './adapters/mock-booking.js';
import { enqueueSync } from './sync.js';

/**
 * Generic inbound webhook pipeline (要件 9.1 / 21):
 *   verify signature → persist one webhook_events row per contained event (unique provider+event_id = dedupe)
 *   → 200 immediately → 'webhook.process' job runs provider.process in the tenant (retries, then DLQ 'dead').
 * Invalid signatures are stored (status ignored, signature_valid=false) and answered with 401.
 */
export const WEBHOOK_JOB = 'webhook.process';
export const WEBHOOK_MAX_ATTEMPTS = 5;
export const WEBHOOK_BODY_LIMIT = 1024 * 1024;

const DROP_HEADERS = new Set(['authorization', 'cookie', 'x-api-key', 'proxy-authorization']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function storableHeaders(headers: FastifyRequest['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (DROP_HEADERS.has(k.toLowerCase()) || v === undefined) continue;
    out[k] = Array.isArray(v) ? v.join(', ') : String(v).slice(0, 1000);
  }
  return out;
}

export async function receiveWebhook(req: FastifyRequest<{ Params: { provider: string; key?: string } }>, reply: FastifyReply) {
  const name = req.params.provider;
  const provider = getWebhookProvider(name);
  if (!provider) throw Errors.notFound('Webhookプロバイダ', name);
  const rawBody = (req as unknown as { rawBody?: string }).rawBody ?? (typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? null));
  const body = req.body ?? null;

  let verified: VerifiedWebhook;
  try {
    verified = await provider.verify({ provider: name, headers: req.headers, rawBody, body, pathParams: req.params.key ? { key: req.params.key } : undefined });
  } catch {
    verified = { eventId: sha256(rawBody), signatureValid: false };
  }
  const headers = JSON.stringify(storableHeaders(req.headers));

  if (!verified.signatureValid) {
    // keyed by body hash with a prefix: a forged delivery can never squat a legitimate event id
    await withSystem((trx) =>
      trx
        .insertInto('webhook_events')
        .values({
          organization_id: null,
          provider: name,
          event_id: `invalid:${sha256(rawBody)}`,
          event_type: verified.eventType ?? null,
          signature_valid: false,
          headers,
          payload: JSON.stringify(body),
          status: 'ignored',
          last_error: 'invalid signature',
        })
        .onConflict((oc) => oc.columns(['provider', 'event_id']).doNothing())
        .execute(),
    );
    throw Errors.unauthenticated('署名が不正です', 'INVALID_SIGNATURE');
  }

  const events = verified.events?.length ? verified.events : [{ eventId: verified.eventId, eventType: verified.eventType, payload: body }];
  const result = await withSystem(async (trx) => {
    let received = 0;
    let duplicates = 0;
    for (const ev of events) {
      const row = await trx
        .insertInto('webhook_events')
        .values({
          organization_id: verified.organizationId ?? null,
          provider: name,
          event_id: ev.eventId,
          event_type: ev.eventType ?? null,
          signature_valid: true,
          headers,
          payload: JSON.stringify(ev.payload ?? null),
          status: 'received',
        })
        .onConflict((oc) => oc.columns(['provider', 'event_id']).doNothing())
        .returning('id')
        .executeTakeFirst();
      if (!row) {
        duplicates++;
        continue;
      }
      received++;
      await enqueue(trx, {
        type: WEBHOOK_JOB,
        organizationId: verified.organizationId ?? null,
        payload: { webhookEventId: row.id },
        dedupeKey: `webhook:${row.id}`,
        maxAttempts: WEBHOOK_MAX_ATTEMPTS,
        priority: 5,
        traceId: req.meta.traceId,
      });
    }
    return { received, duplicates };
  });
  return reply.status(200).send({ ok: true, ...result });
}

async function markEvent(id: string, patch: Record<string, unknown>) {
  await withSystem((trx) => trx.updateTable('webhook_events').set(patch).where('id', '=', id).execute());
}

export async function processWebhookEvent(webhookEventId: string, job: Pick<JobRow, 'attempts' | 'max_attempts' | 'trace_id' | 'id'>): Promise<string> {
  const ev = await withSystem((trx) => trx.selectFrom('webhook_events').selectAll().where('id', '=', webhookEventId).executeTakeFirst());
  if (!ev || !ev.signature_valid || ['processed', 'ignored', 'dead'].includes(ev.status)) return ev?.status ?? 'missing';
  const provider = getWebhookProvider(ev.provider);
  if (!provider) {
    await markEvent(ev.id, { status: 'dead', last_error: `provider not registered: ${ev.provider}`, attempts: job.attempts });
    throw new PermanentJobError(`webhook provider not registered: ${ev.provider}`);
  }
  if (!ev.organization_id) {
    await markEvent(ev.id, { status: 'ignored', last_error: 'テナントを特定できません', processed_at: new Date(), attempts: job.attempts });
    return 'ignored';
  }
  const orgId = ev.organization_id;
  await markEvent(ev.id, { status: 'processing', attempts: job.attempts });
  try {
    const status = await withTenant(
      orgId,
      (trx) =>
        provider.process(
          { actor: systemActor(orgId, `webhook:${ev.provider}`), trx, meta: { traceId: job.trace_id ?? job.id } },
          { eventId: ev.event_id, eventType: ev.event_type, payload: ev.payload },
        ),
      { traceId: job.trace_id ?? job.id },
    );
    await markEvent(ev.id, { status, last_error: null, processed_at: new Date() });
    return status;
  } catch (err) {
    const final = err instanceof PermanentJobError || job.attempts >= job.max_attempts;
    await markEvent(ev.id, { status: final ? 'dead' : 'failed', last_error: (err instanceof Error ? err.message : String(err)).slice(0, 2000) });
    throw err;
  }
}

registerJob<{ webhookEventId: string }>(WEBHOOK_JOB, async (p, jc) => {
  await processWebhookEvent(p.webhookEventId, jc.job);
});

// ------------------------------------------------------------------ mock_booking webhook
// POST /v1/webhooks/mock_booking/:integrationAccountId, header x-mock-signature = hex HMAC-SHA256(rawBody, credentials.webhookSecret)
// → triggers an immediate delta sync of that account.

registerWebhookProvider(MOCK_PROVIDER, {
  async verify(req) {
    const body = (req.body ?? {}) as { eventId?: unknown; type?: unknown };
    const providerEventId = typeof body.eventId === 'string' && body.eventId ? body.eventId.slice(0, 200) : sha256(req.rawBody);
    const eventType = typeof body.type === 'string' ? body.type : undefined;
    const key = req.pathParams?.key;
    const invalid = { eventId: providerEventId, eventType, signatureValid: false };
    if (!key || !UUID_RE.test(key)) return invalid;
    const acc = await withSystem((trx) =>
      trx.selectFrom('integration_accounts').select(['id', 'organization_id', 'encrypted_credentials']).where('id', '=', key).where('provider', '=', MOCK_PROVIDER).executeTakeFirst(),
    );
    if (!acc?.encrypted_credentials) return invalid;
    let secret: unknown;
    try {
      secret = decryptJson<{ webhookSecret?: string }>(acc.encrypted_credentials).webhookSecret;
    } catch {
      return invalid;
    }
    const signature = req.headers['x-mock-signature'];
    if (typeof secret !== 'string' || !secret || typeof signature !== 'string') return invalid;
    if (!safeEqual(signature, hmacSha256(secret, req.rawBody))) return invalid;
    // account-scoped id: unique (provider, event_id) must never collide across tenants
    const eventId = `${acc.id}:${providerEventId}`;
    return {
      eventId,
      eventType,
      organizationId: acc.organization_id,
      signatureValid: true,
      events: [{ eventId, eventType, payload: { ...(req.body as object), integrationAccountId: acc.id } }],
    };
  },
  async process(ctx, event) {
    const accountId = (event.payload as { integrationAccountId?: string } | null)?.integrationAccountId;
    if (!accountId) return 'ignored';
    const row = await loadAccountRow(ctx.trx, accountId);
    if (!row || row.status === 'disabled') return 'ignored';
    await enqueueSync(ctx, { id: row.id, organizationId: row.organization_id }, 'delta', 'webhook', `intg-sync:${row.id}:delta:wh:${Math.floor(Date.now() / 10_000)}`);
    return 'processed';
  },
});
