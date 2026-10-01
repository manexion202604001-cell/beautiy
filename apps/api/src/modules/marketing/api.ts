import { auditUserId, type Ctx } from '../../auth/actor.js';
import { config } from '../../config.js';
import { referenceCode } from '../../lib/crypto.js';
import { Errors } from '../../lib/errors.js';

/**
 * PUBLIC CONTRACT of the marketing module (referral / tracking links). Other modules (commerce,
 * reviews) create attribution links and resolve referral codes only through these functions.
 */
export type ReferralTarget = 'booking' | 'product' | 'profile' | 'review';

export interface ReferralUtm {
  source?: string;
  medium?: string;
  campaign?: string;
}

export interface ReferralLinkInput {
  name: string;
  shopId?: string | null;
  staffId?: string | null;
  customerId?: string | null;
  target: ReferralTarget;
  targetId?: string | null;
  utm?: ReferralUtm;
}

export interface ReferralLinkRow {
  id: string;
  code: string;
  name: string;
  shop_id: string | null;
  staff_id: string | null;
  customer_id: string | null;
  target: string;
  target_id: string | null;
  utm: unknown;
  is_active: boolean;
  click_count: number;
  created_at: Date;
}

export const referralLinkColumns = ['id', 'code', 'name', 'shop_id', 'staff_id', 'customer_id', 'target', 'target_id', 'utm', 'is_active', 'click_count', 'created_at'] as const;

/** Public short URL that counts the click and redirects (GET /v1/public/r/:code) */
export function referralUrl(code: string): string {
  return `${config.API_BASE_URL.replace(/\/$/, '')}/v1/public/r/${encodeURIComponent(code)}`;
}

function cleanUtm(utm: ReferralUtm | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ['source', 'medium', 'campaign'] as const) {
    const v = utm?.[k]?.trim();
    if (v) out[k] = v;
  }
  return out;
}

/** Insert a link with a globally unique short code (no authorization: callers check permissions) */
export async function insertReferralLink(ctx: Ctx, input: ReferralLinkInput): Promise<ReferralLinkRow> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const row = await ctx.trx
      .insertInto('referral_links')
      .values({
        organization_id: ctx.actor.organizationId,
        shop_id: input.shopId ?? null,
        staff_id: input.staffId ?? null,
        customer_id: input.customerId ?? null,
        code: referenceCode(attempt < 3 ? 8 : 10),
        name: input.name,
        target: input.target,
        target_id: input.targetId ?? null,
        utm: JSON.stringify(cleanUtm(input.utm)),
        created_by: auditUserId(ctx.actor),
      })
      .onConflict((oc) => oc.column('code').doNothing())
      .returning(referralLinkColumns)
      .executeTakeFirst();
    if (row) return row;
  }
  throw Errors.system('紹介コードの生成に失敗しました');
}

/**
 * Find-or-create an attribution link (e.g. product share by a staff member, friend referral of a
 * customer). Matching is on (target, targetId, staffId, customerId); deleted/inactive links are not reused.
 */
export async function ensureReferralLink(ctx: Ctx, input: ReferralLinkInput): Promise<ReferralLinkRow> {
  let q = ctx.trx
    .selectFrom('referral_links')
    .select(referralLinkColumns)
    .where('target', '=', input.target)
    .where('is_active', '=', true)
    .where('deleted_at', 'is', null);
  q = input.targetId ? q.where('target_id', '=', input.targetId) : q.where('target_id', 'is', null);
  q = input.staffId ? q.where('staff_id', '=', input.staffId) : q.where('staff_id', 'is', null);
  q = input.customerId ? q.where('customer_id', '=', input.customerId) : q.where('customer_id', 'is', null);
  const existing = await q.orderBy('created_at').executeTakeFirst();
  if (existing) return existing;
  return insertReferralLink(ctx, input);
}

/** Resolve a referral code inside the current tenant (RLS-scoped). Unknown/deleted codes → null */
export async function resolveReferralCode(ctx: Ctx, code: string | null | undefined, opts: { activeOnly?: boolean } = {}) {
  const c = code?.trim();
  if (!c || c.length > 50) return null;
  let q = ctx.trx
    .selectFrom('referral_links')
    .select(referralLinkColumns)
    .where('code', '=', c.toUpperCase()) // codes are generated upper-case
    .where('deleted_at', 'is', null);
  if (opts.activeOnly) q = q.where('is_active', '=', true);
  return (await q.executeTakeFirst()) ?? null;
}
