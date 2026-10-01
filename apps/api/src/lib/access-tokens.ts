import { auditUserId, type Ctx } from '../auth/actor.js';
import { withSystem } from '../db/tenant.js';
import { hashToken, randomToken } from './crypto.js';
import { Errors } from './errors.js';

/**
 * Opaque single-purpose links (pre-visit forms, karte share, review requests, booking management...).
 * Only an HMAC of the token is stored; tokens are scoped to purpose + resource and expire.
 */
export type AccessTokenPurpose = 'pre_visit_form' | 'karte_share' | 'review_request' | 'line_link' | 'booking_manage' | 'product_share';

export async function issueAccessToken(
  ctx: Ctx,
  input: { purpose: AccessTokenPurpose; resourceType: string; resourceId: string; customerId?: string | null; ttlSec: number; maxUses?: number | null },
): Promise<{ token: string; id: string; expiresAt: Date }> {
  const token = randomToken(24);
  const expiresAt = new Date(Date.now() + input.ttlSec * 1000);
  const row = await ctx.trx
    .insertInto('access_tokens')
    .values({
      organization_id: ctx.actor.organizationId,
      purpose: input.purpose,
      token_hash: hashToken(token),
      resource_type: input.resourceType,
      resource_id: input.resourceId,
      customer_id: input.customerId ?? null,
      max_uses: input.maxUses ?? null,
      expires_at: expiresAt,
      created_by: auditUserId(ctx.actor),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { token, id: row.id, expiresAt };
}

export interface ResolvedAccessToken {
  id: string;
  organizationId: string;
  purpose: AccessTokenPurpose;
  resourceType: string;
  resourceId: string;
  customerId: string | null;
}

/**
 * Validate a token (system lookup, since the tenant is unknown until resolved).
 * consume=true increments use_count and enforces max_uses.
 */
export async function resolveAccessToken(token: string, purpose: AccessTokenPurpose, opts: { consume?: boolean } = {}): Promise<ResolvedAccessToken> {
  return withSystem(async (trx) => {
    const row = await trx.selectFrom('access_tokens').selectAll().where('token_hash', '=', hashToken(token)).forUpdate().executeTakeFirst();
    const invalid = Errors.unauthenticated('リンクが無効か有効期限が切れています', 'INVALID_LINK');
    if (!row || row.purpose !== purpose || row.revoked_at || row.expires_at < new Date()) throw invalid;
    if (row.max_uses !== null && row.use_count >= row.max_uses) throw invalid;
    if (opts.consume) {
      await trx.updateTable('access_tokens').set({ use_count: row.use_count + 1, last_used_at: new Date() }).where('id', '=', row.id).execute();
    } else {
      await trx.updateTable('access_tokens').set({ last_used_at: new Date() }).where('id', '=', row.id).execute();
    }
    return {
      id: row.id,
      organizationId: row.organization_id,
      purpose: row.purpose as AccessTokenPurpose,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      customerId: row.customer_id,
    };
  });
}

export async function revokeAccessTokens(ctx: Ctx, resourceType: string, resourceId: string, purpose?: AccessTokenPurpose) {
  let q = ctx.trx.updateTable('access_tokens').set({ revoked_at: new Date() }).where('resource_type', '=', resourceType).where('resource_id', '=', resourceId).where('revoked_at', 'is', null);
  if (purpose) q = q.where('purpose', '=', purpose);
  await q.execute();
}

export function assertTokenResource(t: ResolvedAccessToken, resourceType: string) {
  if (t.resourceType !== resourceType) throw Errors.unauthenticated('リンクが無効です', 'INVALID_LINK');
}
