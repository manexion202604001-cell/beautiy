import type { Ctx } from '../../auth/actor.js';
import { withSystem } from '../../db/tenant.js';
import { resolveAccessToken } from '../../lib/access-tokens.js';
import { audit } from '../../lib/audit.js';
import { decrypt, hmacSha256, safeEqual, sha256 } from '../../lib/crypto.js';
import { emit } from '../../lib/events.js';
import { registerWebhookProvider, type IncomingWebhook, type VerifiedWebhook } from '../../lib/webhooks.js';
import { linkIdentity, resolveCustomer } from '../customers/identity.js';
import { queueMessage } from './api.js';
import { channelById, type ActiveChannel } from './channels.js';
import { setChannelPreference } from './preferences.js';
import { lineGetProfile } from './providers/line.js';
import { resolveTemplateByKey } from './templates.js';

/**
 * LINE Messaging API webhook (provider 'line').
 *  verify: x-line-signature = base64(HMAC-SHA256(channelSecret, rawBody)); the channel is resolved by
 *          body.destination (bot userId). One delivery is split into one record per LINE event
 *          (eventId = webhookEventId) so each is deduped / retried independently.
 *  process: follow / unfollow / message / postback / accountLink.
 */
interface LineSource {
  type: 'user' | 'group' | 'room';
  userId?: string;
}

interface LineEvent {
  type: string;
  webhookEventId?: string;
  timestamp?: number;
  source?: LineSource;
  replyToken?: string;
  mode?: string;
  message?: { id: string; type: string; text?: string; packageId?: string; stickerId?: string; contentProvider?: unknown; fileName?: string };
  postback?: { data: string; params?: Record<string, string> };
  link?: { result: 'ok' | 'failed'; nonce: string };
  follow?: { isUnblocked?: boolean };
  deliveryContext?: { isRedelivery?: boolean };
}

export interface LineEventPayload extends LineEvent {
  destination: string;
  lineChannelId: string;
}

function header(headers: IncomingWebhook['headers'], name: string): string | undefined {
  const v = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

function signatureMatches(encryptedSecret: string, rawBody: string, signature: string): boolean {
  try {
    return safeEqual(hmacSha256(decrypt(encryptedSecret), rawBody, 'base64'), signature);
  } catch {
    return false; // undecryptable secret (key rotation) → treat as invalid, never throw
  }
}

export async function verifyLineWebhook(req: IncomingWebhook): Promise<VerifiedWebhook> {
  const body = (req.body ?? {}) as { destination?: string; events?: LineEvent[] };
  const fallbackId = `delivery:${sha256(req.rawBody)}`;
  const destination = typeof body.destination === 'string' ? body.destination : null;
  const channel = destination
    ? await withSystem((trx) =>
        trx.selectFrom('line_channels').select(['id', 'organization_id', 'encrypted_channel_secret', 'status']).where('bot_user_id', '=', destination).executeTakeFirst(),
      )
    : undefined;
  if (!channel || channel.status === 'disabled') return { eventId: fallbackId, organizationId: null, signatureValid: false };

  const signature = header(req.headers, 'x-line-signature');
  if (!signature || !signatureMatches(channel.encrypted_channel_secret, req.rawBody, signature)) return { eventId: fallbackId, organizationId: channel.organization_id, signatureValid: false };

  const events = Array.isArray(body.events) ? body.events : [];
  if (events.length === 0) {
    // LINE console "Verify" sends an empty event list
    await withSystem((trx) => trx.updateTable('line_channels').set({ webhook_verified_at: new Date() }).where('id', '=', channel.id).execute());
  }
  return {
    eventId: fallbackId,
    eventType: 'delivery',
    organizationId: channel.organization_id,
    signatureValid: true,
    events: events.map((e, i) => ({
      eventId: e.webhookEventId ?? `${fallbackId}:${i}`,
      eventType: e.type,
      payload: { ...e, destination: destination!, lineChannelId: channel.id } satisfies LineEventPayload,
    })),
  };
}

async function upsertLineCustomer(ctx: Ctx, channel: ActiveChannel, userId: string, opts: { following?: boolean }) {
  // profile enrichment is best-effort
  const profile = await lineGetProfile(channel.accessToken(), userId).catch(() => null);
  const resolved = await resolveCustomer(ctx, {
    provider: 'line',
    providerAccountId: channel.channelId,
    externalId: userId,
    displayName: profile?.displayName,
    profile: profile?.pictureUrl ? { pictureUrl: profile.pictureUrl } : {},
    shopId: channel.shopId,
    acquisitionSource: 'line',
  });
  const patch: { is_following?: boolean; display_name?: string; unlinked_at?: null } = { unlinked_at: null };
  if (opts.following !== undefined) patch.is_following = opts.following;
  if (profile?.displayName) patch.display_name = profile.displayName;
  await ctx.trx
    .updateTable('customer_identities')
    .set(patch)
    .where('provider', '=', 'line')
    .where('provider_account_id', '=', channel.channelId)
    .where('external_id', '=', userId)
    .execute();
  return resolved;
}

async function findLineIdentity(ctx: Ctx, channel: ActiveChannel, userId: string) {
  return ctx.trx
    .selectFrom('customer_identities')
    .innerJoin('customers', 'customers.id', 'customer_identities.customer_id')
    .select(['customer_identities.id', 'customer_identities.customer_id', 'customers.status', 'customers.merged_into_id'])
    .where('customer_identities.provider', '=', 'line')
    .where('customer_identities.provider_account_id', '=', channel.channelId)
    .where('customer_identities.external_id', '=', userId)
    .where('customer_identities.unlinked_at', 'is', null)
    .executeTakeFirst();
}

function inboundBody(e: LineEvent): { type: string; body: string } {
  if (e.type === 'postback') return { type: 'postback', body: e.postback?.data ?? '' };
  const m = e.message;
  switch (m?.type) {
    case 'text':
      return { type: 'text', body: m.text ?? '' };
    case 'image':
      return { type: 'image', body: '[画像]' };
    case 'sticker':
      return { type: 'sticker', body: '[スタンプ]' };
    case 'video':
      return { type: 'video', body: '[動画]' };
    case 'audio':
      return { type: 'audio', body: '[音声]' };
    case 'file':
      return { type: 'file', body: `[ファイル] ${m.fileName ?? ''}`.trim() };
    case 'location':
      return { type: 'location', body: '[位置情報]' };
    default:
      return { type: m?.type ?? 'unknown', body: '' };
  }
}

export async function processLineEvent(ctx: Ctx, event: { eventId: string; eventType: string | null; payload: unknown }): Promise<'processed' | 'ignored'> {
  const e = event.payload as LineEventPayload;
  const channel = await channelById(ctx, e.lineChannelId);
  if (!channel) return 'ignored';
  const userId = e.source?.userId;
  if (!userId) return 'ignored'; // group/room events without a user

  switch (e.type) {
    case 'follow': {
      const resolved = await upsertLineCustomer(ctx, channel, userId, { following: true });
      // re-follow restores LINE delivery that an earlier unfollow disabled
      await ctx.trx
        .updateTable('customer_channel_preferences')
        .set({ marketing_allowed: true, transactional_allowed: true, source: 'follow', updated_at: new Date() })
        .where('customer_id', '=', resolved.customerId)
        .where('channel', '=', 'line')
        .where('source', '=', 'unfollow')
        .execute();
      const welcome = await resolveTemplateByKey(ctx, 'welcome', 'line', channel.shopId);
      if (welcome?.status === 'active') {
        await queueMessage(ctx, {
          customerId: resolved.customerId,
          shopId: channel.shopId,
          category: 'transactional',
          channel: 'line',
          templateKey: 'welcome',
          dedupeKey: `line:welcome:${event.eventId}`,
        });
      }
      return 'processed';
    }
    case 'unfollow': {
      const identity = await findLineIdentity(ctx, channel, userId);
      if (!identity) return 'ignored';
      await ctx.trx.updateTable('customer_identities').set({ is_following: false }).where('id', '=', identity.id).execute();
      const customerId = identity.status === 'merged' && identity.merged_into_id ? identity.merged_into_id : identity.customer_id;
      await setChannelPreference(ctx, customerId, 'line', { marketingAllowed: false, transactionalAllowed: false }, 'unfollow');
      return 'processed';
    }
    case 'message':
    case 'postback': {
      const identity = await findLineIdentity(ctx, channel, userId);
      const customerId = identity
        ? identity.status === 'merged' && identity.merged_into_id
          ? identity.merged_into_id
          : identity.customer_id
        : (await upsertLineCustomer(ctx, channel, userId, { following: true })).customerId;
      const { type, body } = inboundBody(e);
      const row = await ctx.trx
        .insertInto('messages')
        .values({
          organization_id: ctx.actor.organizationId,
          shop_id: channel.shopId,
          customer_id: customerId,
          channel: 'line',
          direction: 'inbound',
          category: 'conversation',
          message_type: type,
          body,
          payload: JSON.stringify({ message: e.message ?? null, postback: e.postback ?? null, replyToken: e.replyToken ?? null, timestamp: e.timestamp ?? null }),
          line_channel_id: channel.id,
          recipient: userId,
          status: 'received',
          provider_message_id: e.message?.id ?? null,
          dedupe_key: `line:in:${event.eventId}`,
        })
        .onConflict((oc) => oc.columns(['organization_id', 'dedupe_key']).where('dedupe_key', 'is not', null).doNothing())
        .returning('id')
        .executeTakeFirst();
      if (!row) return 'ignored'; // redelivery
      await emit(ctx, { type: 'message.received', aggregateType: 'message', aggregateId: row.id, payload: { messageId: row.id, customerId, channel: 'line', shopId: channel.shopId } });
      return 'processed';
    }
    case 'accountLink': {
      // nonce = line_link access token issued by staff (POST /customers/:id/line-link-token)
      if (e.link?.result !== 'ok' || !e.link.nonce) return 'ignored';
      let token;
      try {
        token = await resolveAccessToken(e.link.nonce, 'line_link');
      } catch {
        return 'ignored';
      }
      if (token.organizationId !== ctx.actor.organizationId || !token.customerId) return 'ignored';
      const existing = await findLineIdentity(ctx, channel, userId);
      if (existing && existing.customer_id !== token.customerId) {
        await audit(ctx, {
          action: 'customer.line_link_conflict',
          resourceType: 'customer',
          resourceId: token.customerId,
          metadata: { existingCustomerId: existing.customer_id, suggestion: 'merge' },
        });
        return 'processed';
      }
      await linkIdentity(ctx, token.customerId, { provider: 'line', providerAccountId: channel.channelId, externalId: userId });
      await ctx.trx
        .updateTable('customer_identities')
        .set({ is_following: true })
        .where('provider', '=', 'line')
        .where('provider_account_id', '=', channel.channelId)
        .where('external_id', '=', userId)
        .execute();
      await resolveAccessToken(e.link.nonce, 'line_link', { consume: true }).catch(() => undefined);
      return 'processed';
    }
    default:
      return 'ignored';
  }
}

registerWebhookProvider('line', { verify: verifyLineWebhook, process: processLineEvent });
