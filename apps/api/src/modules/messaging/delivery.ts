import { sql, type Selectable } from 'kysely';
import { DateTime } from 'luxon';
import type { Ctx } from '../../auth/actor.js';
import type { Messages } from '../../db/types.js';
import { backoffMs, enqueue, registerJob, RetryLaterError, type JobContext } from '../../jobs/queue.js';
import { emit } from '../../lib/events.js';
import { sendEmail, sendSms } from '../../lib/mailer.js';
import { enqueueDelivery, type OutboundPayload } from './api.js';
import { channelById, lineRecipientFor, type ActiveChannel } from './channels.js';
import { clock } from './clock.js';
import { channelPreferences, unsubscribeUrl } from './preferences.js';
import { LineApiError, linePush, lineMulticast, textMessage } from './providers/line.js';
import type { Channel } from './schemas.js';
import { EMAIL_UNSUBSCRIBE_FOOTER } from './system-templates.js';
import {
  appointmentVars,
  customerVars,
  getTemplateRow,
  loadShop,
  mergeVars,
  orgTimezone,
  renderMessage,
  resolveTemplateByKey,
  shopVars,
  type TemplateRow,
} from './templates.js';

/**
 * Outbound delivery pipeline ('message.deliver'):
 *   load → customer state → channel selection (auto: LINE → email → SMS) → consent → quiet hours
 *   → template rendering → provider call → sent / retry (job backoff) / failed.
 * The provider call happens outside of any DB transaction; LINE pushes carry X-Line-Retry-Key = message id
 * so a retry after a crash never duplicates the message.
 */
export type MessageRow = Selectable<Messages>;

export const QUIET_START_HOUR = 21;
export const QUIET_END_HOUR = 9;

export type Prepared =
  | { kind: 'skip'; reason: string; channel?: Channel }
  | { kind: 'fail'; error: string; channel?: Channel }
  | { kind: 'defer'; until: Date }
  | { kind: 'send'; channel: Channel; recipient: string; body: string; subject: string | null; line: ActiveChannel | null; templateId: string | null };

/** Next 09:00 local when `now` falls inside quiet hours (21:00–09:00), else null */
export function quietHoursUntil(now: Date, tz: string): Date | null {
  const local = DateTime.fromJSDate(now, { zone: tz });
  if (local.hour >= QUIET_START_HOUR) return local.plus({ days: 1 }).set({ hour: QUIET_END_HOUR, minute: 0, second: 0, millisecond: 0 }).toJSDate();
  if (local.hour < QUIET_END_HOUR) return local.set({ hour: QUIET_END_HOUR, minute: 0, second: 0, millisecond: 0 }).toJSDate();
  return null;
}

function payloadOf(msg: MessageRow): OutboundPayload {
  const p = (msg.payload ?? {}) as Partial<OutboundPayload>;
  return { templateKey: p.templateKey ?? null, vars: (p.vars as Record<string, unknown>) ?? {}, channelPreference: p.channelPreference ?? (msg.channel as Channel), subject: p.subject ?? null, batchKey: p.batchKey };
}

/** Decide whether/how to send a queued message. Pure DB reads (no writes). */
export async function prepareDelivery(ctx: Ctx, msg: MessageRow, now: Date): Promise<Prepared> {
  if (!msg.customer_id) return { kind: 'skip', reason: 'no_customer' };
  const customer = await ctx.trx
    .selectFrom('customers')
    .select(['id', 'last_name', 'first_name', 'last_name_kana', 'first_name_kana', 'email', 'phone', 'phone_normalized', 'status', 'deleted_at', 'marketing_opt_in', 'primary_shop_id'])
    .where('id', '=', msg.customer_id)
    .executeTakeFirst();
  if (!customer) return { kind: 'skip', reason: 'customer_not_found' };
  if (customer.deleted_at || customer.status === 'deleted') return { kind: 'skip', reason: 'customer_deleted' };
  if (customer.status === 'merged') return { kind: 'skip', reason: 'customer_merged' };
  if (customer.status === 'blocked') return { kind: 'skip', reason: 'customer_blocked' };

  const marketing = msg.category === 'marketing';
  if (marketing && !customer.marketing_opt_in) return { kind: 'skip', reason: 'opted_out' };

  const payload = payloadOf(msg);
  const prefs = await channelPreferences(ctx, customer.id);
  const candidates: Channel[] = payload.channelPreference === 'auto' ? ['line', 'email', 'sms'] : [payload.channelPreference];

  let optedOut = false;
  let chosen: { channel: Channel; recipient: string; line: ActiveChannel | null } | null = null;
  for (const ch of candidates) {
    let recipient: string | null = null;
    let line: ActiveChannel | null = null;
    if (ch === 'line') {
      const r = await lineRecipientFor(ctx, customer.id, msg.shop_id);
      if (r) {
        recipient = r.userId;
        line = r.channel;
      }
    } else if (ch === 'email') {
      recipient = customer.email;
    } else {
      recipient = customer.phone_normalized ?? customer.phone;
    }
    if (!recipient) continue;
    const allowed = marketing ? prefs[ch].marketingAllowed : prefs[ch].transactionalAllowed;
    if (!allowed) {
      optedOut = true;
      continue;
    }
    chosen = { channel: ch, recipient, line };
    break;
  }
  if (!chosen) {
    const reason = optedOut ? 'opted_out' : payload.channelPreference === 'line' ? 'no_line_identity' : 'no_contact';
    return { kind: 'skip', reason, channel: candidates.length === 1 ? candidates[0] : undefined };
  }

  const shop = await loadShop(ctx, msg.shop_id ?? customer.primary_shop_id);
  const tz = shop?.timezone ?? (await orgTimezone(ctx));
  if (marketing) {
    const until = quietHoursUntil(now, tz);
    if (until) return { kind: 'defer', until };
  }

  // template
  let template: TemplateRow | null = null;
  if (msg.template_id) {
    template = await getTemplateRow(ctx, msg.template_id);
    if (!template && !msg.body) return { kind: 'fail', error: 'template_not_found', channel: chosen.channel };
  } else if (payload.templateKey) {
    template = await resolveTemplateByKey(ctx, payload.templateKey, chosen.channel, msg.shop_id ?? customer.primary_shop_id);
    if (!template && !msg.body) return { kind: 'fail', error: `template_not_found:${payload.templateKey}`, channel: chosen.channel };
    if (template && template.status !== 'active' && !msg.body) return { kind: 'skip', reason: 'template_disabled', channel: chosen.channel };
  }
  const source = msg.body ?? template?.body ?? '';
  if (!source.trim()) return { kind: 'fail', error: 'empty_body', channel: chosen.channel };

  // variables: defaults < payload vars
  const org = await ctx.trx.selectFrom('organizations').select('name').where('id', '=', ctx.actor.organizationId).executeTakeFirst();
  const defaults: Record<string, unknown> = { customer: customerVars(customer), shop: shopVars(shop, org?.name) };
  if (msg.appointment_id) {
    const a = await appointmentVars(ctx, msg.appointment_id, tz);
    if (a) defaults.appointment = a;
  }
  if (chosen.channel === 'email' && marketing) defaults.unsubscribeUrl = unsubscribeUrl(ctx.actor.organizationId, customer.id, 'email');
  const vars = mergeVars(defaults, payload.vars);

  let body = renderMessage(source, vars);
  let subject: string | null = null;
  if (chosen.channel === 'email') {
    const subjectSource = payload.subject ?? (template?.channel === 'email' ? template.subject : null);
    subject = subjectSource ? renderMessage(subjectSource, vars) : `${(vars.shop as { name?: string })?.name || 'サロン'}からのお知らせ`;
    if (marketing) body += `\n\n${renderMessage(EMAIL_UNSUBSCRIBE_FOOTER, vars)}`;
  }
  return { kind: 'send', channel: chosen.channel, recipient: chosen.recipient, body, subject, line: chosen.line, templateId: template?.id ?? msg.template_id };
}

// ---------------------------------------------------------------- state transitions

export async function markSkipped(ctx: Ctx, msg: MessageRow, reason: string, channel?: Channel) {
  await ctx.trx.updateTable('messages').set({ status: 'skipped', skip_reason: reason, channel: channel ?? msg.channel, next_attempt_at: null }).where('id', '=', msg.id).execute();
  await afterTerminal(ctx, msg);
}

export async function markFailed(ctx: Ctx, msg: Pick<MessageRow, 'id' | 'customer_id' | 'campaign_id' | 'channel'>, error: string, channel?: Channel) {
  await ctx.trx
    .updateTable('messages')
    .set({ status: 'failed', error: error.slice(0, 2000), channel: channel ?? msg.channel, next_attempt_at: null })
    .where('id', '=', msg.id)
    .execute();
  await emit(ctx, { type: 'message.failed', aggregateType: 'message', aggregateId: msg.id, payload: { messageId: msg.id, customerId: msg.customer_id, channel: channel ?? msg.channel, error } });
  await afterTerminal(ctx, msg);
}

export async function markSent(ctx: Ctx, msg: Pick<MessageRow, 'id' | 'customer_id' | 'campaign_id' | 'channel'>, providerMessageId: string | null) {
  await ctx.trx
    .updateTable('messages')
    .set({ status: 'sent', sent_at: new Date(), provider_message_id: providerMessageId, error: null, next_attempt_at: null })
    .where('id', '=', msg.id)
    .execute();
  await emit(ctx, { type: 'message.sent', aggregateType: 'message', aggregateId: msg.id, payload: { messageId: msg.id, customerId: msg.customer_id, channel: msg.channel } });
  await afterTerminal(ctx, msg);
}

async function afterTerminal(ctx: Ctx, msg: Pick<MessageRow, 'campaign_id'>) {
  if (msg.campaign_id) await enqueue(ctx, { type: 'campaign.stats', payload: { campaignId: msg.campaign_id }, dedupeKey: `campaign-stats:${msg.campaign_id}` });
}

function isRetryable(err: unknown): boolean {
  if (err instanceof LineApiError) return err.retryable;
  return true; // SMTP / SMS gateway / network errors are transient by default
}

function retryDelay(err: unknown, attempt: number): number {
  if (err instanceof LineApiError && err.retryAfterMs) return err.retryAfterMs;
  return backoffMs(attempt);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------- message.deliver

type SendStep = { msg: MessageRow; prep: Extract<Prepared, { kind: 'send' }>; accessToken: string | null };

async function sendVia(step: SendStep): Promise<string | null> {
  const { prep, msg } = step;
  if (prep.channel === 'line') {
    const res = await linePush(step.accessToken!, prep.recipient, [textMessage(prep.body)], msg.id);
    return res.sentMessageIds[0] ?? res.requestId ?? null;
  }
  if (prep.channel === 'email') {
    const res = await sendEmail({ to: prep.recipient, subject: prep.subject ?? 'お知らせ', text: prep.body });
    return res.id;
  }
  const res = await sendSms({ to: prep.recipient, text: prep.body });
  return res.id;
}

/** dedupe suffix for a re-scheduled delivery; includes the current job id so it never collides with the running job's own key */
function requeueSuffix(at: Date, jc: JobContext) {
  return `:at:${at.getTime()}:${jc.job.id.slice(0, 8)}`;
}

export async function deliverMessage(messageId: string, jc: JobContext) {
  const step = await jc.tx(async (ctx): Promise<SendStep | null> => {
    const msg = await ctx.trx.selectFrom('messages').selectAll().where('id', '=', messageId).forUpdate().executeTakeFirst();
    if (!msg || msg.direction !== 'outbound' || !['queued', 'sending'].includes(msg.status)) return null;
    const now = clock.now();
    if (msg.status === 'queued' && msg.scheduled_at && msg.scheduled_at.getTime() > now.getTime() + 60_000) {
      // woke up early (e.g. rescheduled) → come back at the scheduled time
      await enqueueDelivery(ctx, msg.id, msg.scheduled_at, requeueSuffix(msg.scheduled_at, jc));
      return null;
    }
    const prep = await prepareDelivery(ctx, msg, now);
    switch (prep.kind) {
      case 'skip':
        await markSkipped(ctx, msg, prep.reason, prep.channel);
        return null;
      case 'fail':
        await markFailed(ctx, msg, prep.error, prep.channel);
        return null;
      case 'defer':
        await ctx.trx.updateTable('messages').set({ scheduled_at: prep.until, next_attempt_at: prep.until }).where('id', '=', msg.id).execute();
        await enqueueDelivery(ctx, msg.id, prep.until, requeueSuffix(prep.until, jc));
        return null;
      case 'send':
        await ctx.trx
          .updateTable('messages')
          .set({
            status: 'sending',
            attempts: msg.attempts + 1,
            channel: prep.channel,
            recipient: prep.recipient,
            line_channel_id: prep.line?.id ?? null,
            body: prep.body,
            template_id: prep.templateId,
            payload: JSON.stringify({ ...payloadOf(msg), subject: prep.subject }),
            next_attempt_at: null,
          })
          .where('id', '=', msg.id)
          .execute();
        return { msg: { ...msg, channel: prep.channel }, prep, accessToken: prep.line ? prep.line.accessToken() : null };
    }
  });
  if (!step) return;

  let providerId: string | null = null;
  let error: unknown = null;
  try {
    providerId = await sendVia(step);
  } catch (err) {
    error = err;
  }

  const canRetry = !!error && isRetryable(error) && jc.job.attempts < jc.job.max_attempts;
  await jc.tx(async (ctx) => {
    if (!error) return markSent(ctx, step.msg, providerId);
    if (canRetry) {
      const delay = retryDelay(error, jc.job.attempts);
      await ctx.trx
        .updateTable('messages')
        .set({ status: 'queued', error: errorText(error).slice(0, 2000), next_attempt_at: new Date(Date.now() + delay) })
        .where('id', '=', step.msg.id)
        .where('status', '=', 'sending')
        .execute();
      return;
    }
    await markFailed(ctx, step.msg, errorText(error), step.prep.channel);
  });
  if (canRetry) throw new RetryLaterError(`message ${messageId}: ${errorText(error)}`, retryDelay(error, jc.job.attempts));
}

registerJob<{ messageId: string }>('message.deliver', (payload, jc) => deliverMessage(payload.messageId, jc));

// ---------------------------------------------------------------- line.multicast (campaign batches)

export interface MulticastPayload {
  lineChannelId: string;
  messageIds: string[];
  /** X-Line-Retry-Key: fixed per batch so retries of the same job are idempotent at LINE */
  retryKey: string;
}

registerJob<MulticastPayload>('line.multicast', async (payload, jc) => {
  const batch = await jc.tx(async (ctx) => {
    const msgs = await ctx.trx
      .selectFrom('messages')
      .select(['id', 'customer_id', 'campaign_id', 'channel', 'recipient', 'body'])
      .where('id', 'in', payload.messageIds)
      .where('status', '=', 'sending')
      .execute();
    if (!msgs.length) return null;
    const channel = await channelById(ctx, payload.lineChannelId);
    if (!channel) {
      for (const m of msgs) await markFailed(ctx, m, 'line_channel_unavailable', 'line');
      return null;
    }
    return { msgs, token: channel.accessToken() };
  });
  if (!batch) return;
  const body = batch.msgs[0]!.body ?? '';
  let error: unknown = null;
  let requestId: string | null = null;
  try {
    const res = await lineMulticast(batch.token, batch.msgs.map((m) => m.recipient!), [textMessage(body)], payload.retryKey);
    requestId = res.requestId;
  } catch (err) {
    error = err;
  }
  const canRetry = !!error && isRetryable(error) && jc.job.attempts < jc.job.max_attempts;
  await jc.tx(async (ctx) => {
    if (!error) {
      for (const m of batch.msgs) await markSent(ctx, m, requestId);
      return;
    }
    if (canRetry) {
      await ctx.trx
        .updateTable('messages')
        .set({ error: errorText(error).slice(0, 2000), attempts: sql`attempts + 1` })
        .where('id', 'in', batch.msgs.map((m) => m.id))
        .execute();
      return;
    }
    for (const m of batch.msgs) await markFailed(ctx, m, errorText(error), 'line');
  });
  if (canRetry) throw new RetryLaterError(`line multicast: ${errorText(error)}`, retryDelay(error, jc.job.attempts));
});
