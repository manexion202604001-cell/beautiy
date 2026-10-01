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
  /** idempotency: the same dedupeKey is never queued twice per organization */
  dedupeKey?: string;
  sentByStaffId?: string | null;
}

export interface QueueMessageResult {
  messageId: string | null;
  /** set when not queued (duplicate dedupeKey) */
  skipped?: 'duplicate';
}

export async function queueMessage(ctx: Ctx, input: QueueMessageInput): Promise<QueueMessageResult> {
  const row = await ctx.trx
    .insertInto('messages')
    .values({
      organization_id: ctx.actor.organizationId,
      shop_id: input.shopId ?? null,
      customer_id: input.customerId,
      channel: input.channel ?? 'line',
      direction: 'outbound',
      category: input.category,
      message_type: 'text',
      body: input.body ?? null,
      payload: JSON.stringify({ templateKey: input.templateKey ?? null, vars: input.vars ?? {}, channelPreference: input.channel ?? 'auto' }),
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
  await enqueue(ctx, {
    type: 'message.deliver',
    payload: { messageId: row.id },
    runAt: input.scheduledAt,
    dedupeKey: `message:${row.id}`,
    queue: 'default',
  });
  return { messageId: row.id };
}

/** Cancel queued (not yet sent) messages, e.g. reminders of a cancelled appointment */
export async function cancelQueuedMessages(ctx: Ctx, filter: { appointmentId?: string; dedupeKeyPrefix?: string }): Promise<number> {
  let q = ctx.trx.updateTable('messages').set({ status: 'cancelled' }).where('status', '=', 'queued').where('direction', '=', 'outbound');
  if (filter.appointmentId) q = q.where('appointment_id', '=', filter.appointmentId);
  if (filter.dedupeKeyPrefix) q = q.where('dedupe_key', 'like', `${filter.dedupeKeyPrefix}%`);
  const res = await q.executeTakeFirst();
  return Number(res.numUpdatedRows);
}
