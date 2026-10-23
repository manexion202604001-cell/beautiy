import { requirePermission, systemActor, type Ctx, type RequestMeta } from '../../auth/actor.js';
import { config } from '../../config.js';
import { withTenant } from '../../db/tenant.js';
import { issueAccessToken, resolveAccessToken } from '../../lib/access-tokens.js';
import { audit } from '../../lib/audit.js';
import { Errors } from '../../lib/errors.js';
import { verifyLineIdToken } from '../../lib/line-auth.js';
import { assertCustomerAccess } from '../customers/access.js';
import { linkIdentity } from '../customers/identity.js';
import { channelForIdToken, channelForShop, type ActiveChannel } from './channels.js';
import { lineGetProfile } from './providers/line.js';

/**
 * LINE account linking for existing (e.g. walk-in / phone) customers:
 *   staff issues a one-time line_link token (URL / QR) → customer opens it in LIFF → POST /public/line-link
 *   with the LIFF id token → identity (provider line, account = channel id) is linked to that customer.
 */
/**
 * With a LIFF ID the link opens inside LINE: https://liff.line.me/<liffId>/line/link?linkToken=…
 * (the LIFF app's endpoint is the web root, see lib/liff.ts in the web app). The LIFF ID is repeated
 * as a parameter so the page initialises the very LIFF app of this channel even when the customer's
 * shop is served by another one. Without a LIFF ID the link is an ordinary web page.
 */
export function lineLinkUrl(token: string, liffId: string | null) {
  const t = encodeURIComponent(token);
  return liffId ? `https://liff.line.me/${liffId}/line/link?linkToken=${t}&liffId=${encodeURIComponent(liffId)}` : `${config.WEB_BASE_URL}/line/link?token=${t}`;
}

/** Customer currently linked to a LINE user of a channel (a merged record resolves to the one it was merged into) */
export async function lineUserOwner(ctx: Ctx, channelId: string, userId: string): Promise<string | null> {
  const existing = await ctx.trx
    .selectFrom('customer_identities')
    .innerJoin('customers', 'customers.id', 'customer_identities.customer_id')
    .select(['customer_identities.customer_id', 'customers.status', 'customers.merged_into_id'])
    .where('customer_identities.provider', '=', 'line')
    .where('customer_identities.provider_account_id', '=', channelId)
    .where('customer_identities.external_id', '=', userId)
    .where('customer_identities.unlinked_at', 'is', null)
    .executeTakeFirst();
  if (!existing) return null;
  return existing.status === 'merged' && existing.merged_into_id ? existing.merged_into_id : existing.customer_id;
}

/**
 * Link a verified LINE user to a customer. A LINE user that already is another customer record
 * (e.g. created by a follow or a LINE booking) is left alone and reported as a conflict: staff merge
 * the two records (統合候補) instead.
 */
export async function attachLineUser(
  ctx: Ctx,
  customerId: string,
  channel: Pick<ActiveChannel, 'channelId' | 'accessToken'>,
  user: { userId: string; displayName?: string | null },
): Promise<{ linked: true; following: boolean | null } | { linked: false; conflictCustomerId: string }> {
  const owner = await lineUserOwner(ctx, channel.channelId, user.userId);
  if (owner && owner !== customerId) return { linked: false, conflictCustomerId: owner };
  // friendship check is best-effort (null = unknown)
  const following: boolean | null = await lineGetProfile(channel.accessToken(), user.userId).then(
    (p) => !!p,
    () => null,
  );
  await linkIdentity(ctx, customerId, { provider: 'line', providerAccountId: channel.channelId, externalId: user.userId, displayName: user.displayName ?? undefined });
  if (following !== null) {
    await ctx.trx
      .updateTable('customer_identities')
      .set({ is_following: following })
      .where('provider', '=', 'line')
      .where('provider_account_id', '=', channel.channelId)
      .where('external_id', '=', user.userId)
      .execute();
  }
  return { linked: true, following };
}

export async function issueLineLinkToken(ctx: Ctx, customerId: string, input: { shopId?: string; ttlHours: number }) {
  requirePermission(ctx.actor, 'customer.write');
  const customer = await assertCustomerAccess(ctx, customerId);
  const shopId = input.shopId ?? ctx.meta.currentShopId ?? customer.primary_shop_id ?? null;
  const channel = await channelForShop(ctx, shopId);
  if (!channel) throw Errors.business('LINE_NOT_CONFIGURED', 'LINE公式アカウントが設定されていません');
  const { token, expiresAt } = await issueAccessToken(ctx, {
    purpose: 'line_link',
    resourceType: 'customer',
    resourceId: customerId,
    customerId,
    ttlSec: input.ttlHours * 3600,
    maxUses: 1,
  });
  const url = lineLinkUrl(token, channel.liffId);
  await audit(ctx, { action: 'customer.line_link_token', resourceType: 'customer', resourceId: customerId, shopId, metadata: { lineChannelId: channel.id, expiresAt } });
  return { token, url, qrPayload: url, expiresAt, lineChannelId: channel.id };
}

export async function linkLineAccount(input: { token: string; idToken: string }, meta: RequestMeta) {
  // validate without consuming first: a failed id-token check must not burn the one-time link
  const t = await resolveAccessToken(input.token, 'line_link');
  if (t.resourceType !== 'customer' || !t.customerId) throw Errors.unauthenticated('リンクが無効です', 'INVALID_LINK');
  const customerId = t.customerId;
  const result = await withTenant(t.organizationId, async (trx): Promise<{ conflict: string } | { linked: true; customerId: string; following: boolean | null }> => {
    const ctx: Ctx = { actor: systemActor(t.organizationId, 'line_link'), trx, meta };
    const customer = await trx.selectFrom('customers').select(['id', 'status', 'primary_shop_id', 'deleted_at']).where('id', '=', customerId).executeTakeFirst();
    if (!customer || customer.deleted_at || customer.status !== 'active') throw Errors.unauthenticated('リンクが無効です', 'INVALID_LINK');
    // the channel whose LIFF app issued the id token (the link may come from another shop's account)
    const channel = await channelForIdToken(ctx, input.idToken, customer.primary_shop_id, { anyShop: true });
    if (!channel) throw Errors.business('LINE_NOT_CONFIGURED', 'LINE公式アカウントが設定されていません');
    const profile = await verifyLineIdToken(input.idToken, channel.loginChannelId);

    const attached = await attachLineUser(ctx, customerId, channel, { userId: profile.userId, displayName: profile.displayName });
    // the LINE user is already another customer record (e.g. created by follow/LINE booking) → staff should merge
    if (!attached.linked) return { conflict: attached.conflictCustomerId };
    const following = attached.following;
    await resolveAccessToken(input.token, 'line_link', { consume: true });
    return { linked: true as const, customerId, following };
  });
  if ('conflict' in result) {
    // recorded in its own transaction so the 409 does not roll the audit trail back
    await withTenant(t.organizationId, (trx) =>
      audit(
        { actor: systemActor(t.organizationId, 'line_link'), trx, meta },
        { action: 'customer.line_link_conflict', resourceType: 'customer', resourceId: customerId, metadata: { existingCustomerId: result.conflict, suggestion: 'merge' } },
      ),
    );
    throw Errors.conflict('LINE_ALREADY_LINKED', 'このLINEアカウントは別のお客様情報に連携済みです。お手数ですが店舗スタッフにお申し付けください', { suggestion: 'merge' });
  }
  return result;
}
