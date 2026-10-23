import { systemActor, type Ctx, type RequestMeta } from '../../auth/actor.js';
import { withSystem, withTenant } from '../../db/tenant.js';
import { resolveAccessToken } from '../../lib/access-tokens.js';
import { Errors } from '../../lib/errors.js';
import { channelForShop } from './channels.js';

/**
 * LIFF configuration for customer-facing pages (GET /public/line/liff).
 *
 * One LIFF app per LINE official account; its endpoint URL is the web root (WEB_BASE_URL), so a
 * single LIFF app serves every customer page: https://liff.line.me/<liffId>/<path> opens
 * <WEB_BASE_URL>/<path> (account link /line/link, walk-in reception /consent/<shop>, booking
 * /book/<shop>, my page /my/<shop>). The page finds the LIFF ID by the shop slug in its path or by
 * the account-link token. The shop's own channel wins over the organization channel.
 * Only public values are returned (LIFF ID, 友だち追加URL) — never secrets or channel ids.
 */
export interface PublicLiffConfig {
  liffId: string | null;
  friendUrl: string | null;
}

const NONE: PublicLiffConfig = { liffId: null, friendUrl: null };

async function shopBySlug(slug: string) {
  const shop = await withSystem((trx) =>
    trx
      .selectFrom('shops')
      .innerJoin('organizations', 'organizations.id', 'shops.organization_id')
      .select([
        'shops.id',
        'shops.organization_id',
        'shops.status',
        'organizations.status as org_status',
      ])
      .where('shops.slug', '=', slug)
      .where('shops.deleted_at', 'is', null)
      .executeTakeFirst(),
  );
  if (!shop || shop.status !== 'active' || !['active', 'trial'].includes(shop.org_status))
    throw Errors.notFound('店舗');
  return { organizationId: shop.organization_id, shopId: shop.id };
}

export async function publicLiffConfig(
  input: { shop?: string; linkToken?: string },
  meta: RequestMeta,
): Promise<PublicLiffConfig> {
  let organizationId: string;
  let shopId: string | null;
  let customerId: string | null = null;
  if (input.shop) {
    ({ organizationId, shopId } = await shopBySlug(input.shop));
  } else if (input.linkToken) {
    const t = await resolveAccessToken(input.linkToken, 'line_link');
    if (t.resourceType !== 'customer' || !t.customerId)
      throw Errors.unauthenticated('リンクが無効です', 'INVALID_LINK');
    organizationId = t.organizationId;
    shopId = null;
    customerId = t.customerId;
  } else {
    return NONE;
  }
  return withTenant(
    organizationId,
    async (trx) => {
      const ctx: Ctx = { actor: systemActor(organizationId, 'public:liff'), trx, meta };
      if (customerId) {
        const c = await trx
          .selectFrom('customers')
          .select('primary_shop_id')
          .where('id', '=', customerId)
          .executeTakeFirst();
        shopId = c?.primary_shop_id ?? null;
      }
      const channel = await channelForShop(ctx, shopId);
      return channel ? { liffId: channel.liffId, friendUrl: channel.friendUrl } : NONE;
    },
    { traceId: meta.traceId },
  );
}
