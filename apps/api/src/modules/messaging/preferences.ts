import { requirePermission, type Ctx } from '../../auth/actor.js';
import { config } from '../../config.js';
import { withTenant } from '../../db/tenant.js';
import { systemActor, type RequestMeta } from '../../auth/actor.js';
import { audit } from '../../lib/audit.js';
import { signPayload, verifySignedPayload } from '../../lib/crypto.js';
import { Errors } from '../../lib/errors.js';
import { assertCustomerAccess } from '../customers/access.js';
import { CHANNELS, type Channel, type UpdatePreferencesInput } from './schemas.js';

/**
 * Opt-out management (FR-03 配信ログ・失敗再送・オプトアウト).
 *  - customers.marketing_opt_in: global marketing consent
 *  - customer_channel_preferences: per channel marketing/transactional consent (no row = allowed)
 */
export type PreferenceSource = 'unfollow' | 'customer_request' | 'staff' | 'follow' | 'unsubscribe_link';

export interface ChannelPreference {
  channel: Channel;
  marketingAllowed: boolean;
  transactionalAllowed: boolean;
  source: string | null;
  updatedAt: Date | null;
}

export async function channelPreferences(ctx: Ctx, customerId: string): Promise<Record<Channel, ChannelPreference>> {
  const rows = await ctx.trx.selectFrom('customer_channel_preferences').selectAll().where('customer_id', '=', customerId).execute();
  const out = {} as Record<Channel, ChannelPreference>;
  for (const ch of CHANNELS) {
    const r = rows.find((x) => x.channel === ch);
    out[ch] = { channel: ch, marketingAllowed: r?.marketing_allowed ?? true, transactionalAllowed: r?.transactional_allowed ?? true, source: r?.source ?? null, updatedAt: r?.updated_at ?? null };
  }
  return out;
}

export async function setChannelPreference(
  ctx: Ctx,
  customerId: string,
  channel: Channel,
  patch: { marketingAllowed?: boolean; transactionalAllowed?: boolean },
  source: PreferenceSource,
) {
  if (patch.marketingAllowed === undefined && patch.transactionalAllowed === undefined) return;
  await ctx.trx
    .insertInto('customer_channel_preferences')
    .values({
      customer_id: customerId,
      organization_id: ctx.actor.organizationId,
      channel,
      marketing_allowed: patch.marketingAllowed ?? true,
      transactional_allowed: patch.transactionalAllowed ?? true,
      source,
      updated_at: new Date(),
    })
    .onConflict((oc) =>
      oc.columns(['customer_id', 'channel']).doUpdateSet((eb) => ({
        ...(patch.marketingAllowed !== undefined ? { marketing_allowed: eb.ref('excluded.marketing_allowed') } : {}),
        ...(patch.transactionalAllowed !== undefined ? { transactional_allowed: eb.ref('excluded.transactional_allowed') } : {}),
        source: eb.ref('excluded.source'),
        updated_at: eb.ref('excluded.updated_at'),
      })),
    )
    .execute();
}

async function preferencesView(ctx: Ctx, customerId: string) {
  const c = await ctx.trx.selectFrom('customers').select(['marketing_opt_in']).where('id', '=', customerId).executeTakeFirstOrThrow();
  const prefs = await channelPreferences(ctx, customerId);
  return { customerId, marketingOptIn: c.marketing_opt_in, channels: CHANNELS.map((ch) => prefs[ch]) };
}

async function applyPreferences(ctx: Ctx, customerId: string, input: UpdatePreferencesInput, source: PreferenceSource) {
  const before = await preferencesView(ctx, customerId);
  if (input.marketingOptIn !== undefined) {
    await ctx.trx.updateTable('customers').set({ marketing_opt_in: input.marketingOptIn }).where('id', '=', customerId).execute();
  }
  for (const item of input.channels ?? []) {
    await setChannelPreference(ctx, customerId, item.channel, item, source);
  }
  const after = await preferencesView(ctx, customerId);
  await audit(ctx, { action: 'customer.channel_preferences_update', resourceType: 'customer', resourceId: customerId, before, after, metadata: { source } });
  return after;
}

// ---- staff

export async function getCustomerPreferences(ctx: Ctx, customerId: string) {
  requirePermission(ctx.actor, 'customer.read');
  await assertCustomerAccess(ctx, customerId);
  return preferencesView(ctx, customerId);
}

export async function updateCustomerPreferences(ctx: Ctx, customerId: string, input: UpdatePreferencesInput) {
  requirePermission(ctx.actor, 'customer.write');
  await assertCustomerAccess(ctx, customerId);
  return applyPreferences(ctx, customerId, input, 'staff');
}

// ---- customer (self-service)

async function assertActiveCustomer(ctx: Ctx, customerId: string) {
  const c = await ctx.trx.selectFrom('customers').select(['status', 'deleted_at']).where('id', '=', customerId).executeTakeFirst();
  if (!c || c.deleted_at || c.status === 'merged' || c.status === 'deleted') throw Errors.unauthenticated();
}

export async function getMyPreferences(ctx: Ctx, customerId: string) {
  await assertActiveCustomer(ctx, customerId);
  return preferencesView(ctx, customerId);
}

export async function updateMyPreferences(ctx: Ctx, customerId: string, input: UpdatePreferencesInput) {
  await assertActiveCustomer(ctx, customerId);
  return applyPreferences(ctx, customerId, input, 'customer_request');
}

// ---- unsubscribe link (e-mail footer)

const UNSUB_TTL_SEC = 180 * 86_400;

export function unsubscribeToken(organizationId: string, customerId: string, channel: Channel): string {
  return signPayload({ k: 'unsub', o: organizationId, c: customerId, ch: channel }, UNSUB_TTL_SEC);
}

export function unsubscribeUrl(organizationId: string, customerId: string, channel: Channel): string {
  return `${config.WEB_BASE_URL}/unsubscribe?token=${encodeURIComponent(unsubscribeToken(organizationId, customerId, channel))}`;
}

function parseUnsubscribe(token: string) {
  let data: { k?: string; o?: string; c?: string; ch?: string } | null;
  try {
    data = verifySignedPayload(token);
  } catch {
    data = null; // malformed base64/JSON
  }
  if (!data || data.k !== 'unsub' || !data.o || !data.c || !CHANNELS.includes(data.ch as Channel)) {
    throw Errors.unauthenticated('リンクが無効か有効期限が切れています', 'INVALID_LINK');
  }
  return { organizationId: data.o, customerId: data.c, channel: data.ch as Channel };
}

function maskEmail(email: string | null) {
  if (!email) return null;
  const [user, domain] = email.split('@');
  return `${(user ?? '').slice(0, 2)}***@${domain ?? ''}`;
}

export async function unsubscribeInfo(token: string, meta: RequestMeta) {
  const t = parseUnsubscribe(token);
  return withTenant(t.organizationId, async (trx) => {
    const ctx: Ctx = { actor: systemActor(t.organizationId, 'public'), trx, meta };
    const c = await trx.selectFrom('customers').select(['email', 'marketing_opt_in', 'status']).where('id', '=', t.customerId).executeTakeFirst();
    if (!c || c.status === 'deleted') throw Errors.unauthenticated('リンクが無効か有効期限が切れています', 'INVALID_LINK');
    const prefs = await channelPreferences(ctx, t.customerId);
    return { channel: t.channel, email: maskEmail(c.email), marketingOptIn: c.marketing_opt_in, marketingAllowed: prefs[t.channel].marketingAllowed };
  });
}

export async function unsubscribe(token: string, scope: 'channel' | 'all', meta: RequestMeta) {
  const t = parseUnsubscribe(token);
  return withTenant(t.organizationId, async (trx) => {
    const ctx: Ctx = { actor: systemActor(t.organizationId, 'unsubscribe'), trx, meta };
    const c = await trx.selectFrom('customers').select(['id', 'status']).where('id', '=', t.customerId).executeTakeFirst();
    if (!c || c.status === 'deleted') throw Errors.unauthenticated('リンクが無効か有効期限が切れています', 'INVALID_LINK');
    await setChannelPreference(ctx, t.customerId, t.channel, { marketingAllowed: false }, 'unsubscribe_link');
    if (scope === 'all') await trx.updateTable('customers').set({ marketing_opt_in: false }).where('id', '=', t.customerId).execute();
    await audit(ctx, { action: 'customer.unsubscribe', resourceType: 'customer', resourceId: t.customerId, metadata: { channel: t.channel, scope } });
    return { ok: true as const, channel: t.channel, scope };
  });
}
