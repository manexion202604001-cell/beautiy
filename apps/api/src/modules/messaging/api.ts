import { sql } from 'kysely';
import type { Ctx } from '../../auth/actor.js';
import { enqueue } from '../../jobs/queue.js';

/**
 * PUBLIC CONTRACT of the messaging module — other modules MUST use this instead of writing
 * to `messages` directly. Signature is stable; internals are owned by the messaging module.
 *
 * Channel selection, consent/opt-out checks, quiet hours, template rendering, retries and
 * delivery logging happen asynchronously in the 'message.deliver' job.
 */
export type MessageCategory = 'transactional' | 'marketing' | 'conversation' | 'system';

export interface QueueMessageInput {
  customerId: string;
  shopId?: string | null;
  category: MessageCategory;
  /** system template key (e.g. 'booking_confirmed') resolved shop → org; or explicit body */
  templateKey?: string;
  templateId?: string;
  body?: string;
  /** template variables, merged with defaults (customer.name, shop.name, ...) at delivery */
  vars?: Record<string, unknown>;
  /** preferred channel; omitted = auto (LINE if linked & following → email → sms) */
  channel?: 'line' | 'email' | 'sms';
  appointmentId?: string | null;
  campaignId?: string | null;
  automationId?: string | null;
  /** send later (e.g. reminders). Defaults to now */
  scheduledAt?: Date;
  /** idempotency: the same dedupeKey is never queued twice per organization (a cancelled message releases its key) */
  dedupeKey?: string;
  sentByStaffId?: string | null;
}

export interface QueueMessageResult {
  messageId: string | null;
  /** set when not queued (duplicate dedupeKey) */
  skipped?: 'duplicate';
}

/** Shape of messages.payload for outbound messages (owned by this module) */
export interface OutboundPayload {
  templateKey: string | null;
  vars: Record<string, unknown>;
  channelPreference: 'auto' | 'line' | 'email' | 'sms';
  subject?: string | null;
  /** multicast batch this message was handed to (campaigns) */
  batchKey?: string;
}

/**
 * @internal insert the outbound message row (deduped). `deliver: false` leaves delivery to the caller
 * (campaign fan-out batches LINE messages into multicast requests).
 */
export async function insertOutboundMessage(ctx: Ctx, input: QueueMessageInput, opts: { deliver: boolean }): Promise<QueueMessageResult> {
  const payload: OutboundPayload = { templateKey: input.templateKey ?? null, vars: input.vars ?? {}, channelPreference: input.channel ?? 'auto' };
  const row = await ctx.trx
    .insertInto('messages')
    .values({
      organization_id: ctx.actor.organizationId,
      shop_id: input.shopId ?? null,
      customer_id: input.customerId,
      // provisional; the delivery job records the channel actually used
      channel: input.channel ?? 'line',
      direction: 'outbound',
      category: input.category,
      message_type: 'text',
      body: input.body ?? null,
      payload: JSON.stringify(payload),
      template_id: input.templateId ?? null,
      campaign_id: input.campaignId ?? null,
      automation_id: input.automationId ?? null,
      appointment_id: input.appointmentId ?? null,
      status: 'queued',
      scheduled_at: input.scheduledAt ?? null,
      sent_by_staff_id: input.sentByStaffId ?? null,
      dedupe_key: input.dedupeKey ?? null,
    })
    .onConflict((oc) => oc.columns(['organization_id', 'dedupe_key']).where('dedupe_key', 'is not', null).doNothing())
    .returning('id')
    .executeTakeFirst();
  if (!row) return { messageId: null, skipped: 'duplicate' };
  if (opts.deliver) await enqueueDelivery(ctx, row.id, input.scheduledAt);
  return { messageId: row.id };
}

/** @internal schedule the delivery job for a message */
export async function enqueueDelivery(ctx: Ctx, messageId: string, runAt?: Date, dedupeSuffix = '') {
  await enqueue(ctx, {
    type: 'message.deliver',
    payload: { messageId },
    runAt,
    dedupeKey: `message:${messageId}${dedupeSuffix}`,
    queue: 'default',
  });
}

export async function queueMessage(ctx: Ctx, input: QueueMessageInput): Promise<QueueMessageResult> {
  return insertOutboundMessage(ctx, input, { deliver: true });
}

function escapeLike(s: string) {
  return s.replace(/[\\%_]/g, '\\$&');
}

/** Cancel queued (not yet sent) messages, e.g. reminders of a cancelled appointment */
export async function cancelQueuedMessages(ctx: Ctx, filter: { appointmentId?: string; dedupeKeyPrefix?: string }): Promise<number> {
  if (!filter.appointmentId && !filter.dedupeKeyPrefix) return 0;
  let q = ctx.trx
    .updateTable('messages')
    // release the dedupe key so the same notification can be queued again later (e.g. restored appointment)
    .set({ status: 'cancelled', dedupe_key: sql`CASE WHEN dedupe_key IS NULL THEN NULL ELSE dedupe_key || '#cancelled:' || id::text END` })
    .where('status', '=', 'queued')
    .where('direction', '=', 'outbound');
  if (filter.appointmentId) q = q.where('appointment_id', '=', filter.appointmentId);
  if (filter.dedupeKeyPrefix) q = q.where(sql<boolean>`dedupe_key LIKE ${escapeLike(filter.dedupeKeyPrefix) + '%'}`);
  const rows = await q.returning('id').execute();
  if (rows.length) {
    // drop their pending delivery jobs as well (the job would no-op on a cancelled message anyway)
    await ctx.trx
      .updateTable('jobs')
      .set({ state: 'cancelled', finished_at: new Date() })
      .where('state', '=', 'queued')
      .where('type', '=', 'message.deliver')
      .where(sql<boolean>`payload->>'messageId' = ANY(${rows.map((r) => r.id)}::text[])`)
      .execute();
  }
  return rows.length;
}
