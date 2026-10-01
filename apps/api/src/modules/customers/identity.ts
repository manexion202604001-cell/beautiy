import type { Ctx } from '../../auth/actor.js';
import { normalizeEmail, normalizePhone } from '../../lib/normalize.js';
import { emit } from '../../lib/events.js';
import { audit } from '../../lib/audit.js';

/**
 * Identity resolution used by channels that create customers without staff (LINE / web booking /
 * external booking import). Auto-links ONLY on strong uniqueness (要件 4.1):
 *   1. existing identity (provider + account + external id)
 *   2. exactly one active customer with the same normalized phone
 *   3. exactly one active customer with the same email
 * Otherwise a new customer is created (staff can merge later from duplicate candidates).
 */
export interface ResolveCustomerInput {
  provider?: string;
  providerAccountId?: string;
  externalId?: string;
  displayName?: string;
  profile?: Record<string, unknown>;
  lastName?: string;
  firstName?: string;
  lastNameKana?: string;
  firstNameKana?: string;
  phone?: string | null;
  email?: string | null;
  shopId?: string | null;
  acquisitionSource?: string;
}

export interface ResolveResult {
  customerId: string;
  created: boolean;
  matchedBy: 'identity' | 'phone' | 'email' | 'new';
}

export async function resolveCustomer(ctx: Ctx, input: ResolveCustomerInput): Promise<ResolveResult> {
  const orgId = ctx.actor.organizationId;
  if (input.provider && input.externalId) {
    const identity = await ctx.trx
      .selectFrom('customer_identities')
      .innerJoin('customers', 'customers.id', 'customer_identities.customer_id')
      .select(['customer_identities.customer_id', 'customers.status', 'customers.merged_into_id'])
      .where('customer_identities.provider', '=', input.provider)
      .where('customer_identities.provider_account_id', '=', input.providerAccountId ?? '')
      .where('customer_identities.external_id', '=', input.externalId)
      .where('customer_identities.unlinked_at', 'is', null)
      .executeTakeFirst();
    if (identity) {
      const id = identity.status === 'merged' && identity.merged_into_id ? identity.merged_into_id : identity.customer_id;
      return { customerId: id, created: false, matchedBy: 'identity' };
    }
  }

  const phone = normalizePhone(input.phone);
  const email = normalizeEmail(input.email);
  let matchedId: string | null = null;
  let matchedBy: ResolveResult['matchedBy'] = 'new';
  if (phone) {
    const rows = await ctx.trx.selectFrom('customers').select('id').where('phone_normalized', '=', phone).where('status', '=', 'active').where('deleted_at', 'is', null).limit(2).execute();
    if (rows.length === 1) {
      matchedId = rows[0]!.id;
      matchedBy = 'phone';
    }
  }
  if (!matchedId && email) {
    const rows = await ctx.trx.selectFrom('customers').select('id').where('email', '=', email).where('status', '=', 'active').where('deleted_at', 'is', null).limit(2).execute();
    if (rows.length === 1) {
      matchedId = rows[0]!.id;
      matchedBy = 'email';
    }
  }

  let created = false;
  if (!matchedId) {
    const row = await ctx.trx
      .insertInto('customers')
      .values({
        organization_id: orgId,
        last_name: input.lastName ?? '',
        first_name: input.firstName ?? (input.lastName ? '' : (input.displayName ?? '')),
        last_name_kana: input.lastNameKana ?? '',
        first_name_kana: input.firstNameKana ?? '',
        phone: input.phone ?? null,
        phone_normalized: phone,
        email,
        primary_shop_id: input.shopId ?? null,
        acquisition_source: input.acquisitionSource ?? input.provider ?? null,
        trace_id: ctx.meta.traceId ?? null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    matchedId = row.id;
    created = true;
    await audit(ctx, { action: 'customer.create', resourceType: 'customer', resourceId: row.id, shopId: input.shopId ?? null, metadata: { via: input.provider ?? 'resolve' } });
    await emit(ctx, { type: 'customer.created', aggregateType: 'customer', aggregateId: row.id, payload: { shopId: input.shopId ?? null, via: input.provider } });
  } else {
    // enrich missing contact info on the matched record
    await ctx.trx
      .updateTable('customers')
      .set((eb) => ({
        phone: eb.fn.coalesce('phone', eb.val(input.phone ?? null)),
        phone_normalized: eb.fn.coalesce('phone_normalized', eb.val(phone)),
        email: eb.fn.coalesce('email', eb.val(email)),
      }))
      .where('id', '=', matchedId)
      .execute();
  }

  if (input.provider && input.externalId) {
    await ctx.trx
      .insertInto('customer_identities')
      .values({
        organization_id: orgId,
        customer_id: matchedId,
        provider: input.provider,
        provider_account_id: input.providerAccountId ?? '',
        external_id: input.externalId,
        display_name: input.displayName ?? null,
        profile: JSON.stringify(input.profile ?? {}),
      })
      .onConflict((oc) =>
        oc.columns(['organization_id', 'provider', 'provider_account_id', 'external_id']).doUpdateSet({ customer_id: matchedId, unlinked_at: null }),
      )
      .execute();
  }
  if (input.shopId) {
    await ctx.trx
      .insertInto('customer_shop_relations')
      .values({ organization_id: orgId, customer_id: matchedId, shop_id: input.shopId, relation_type: 'visited' })
      .onConflict((oc) => oc.doNothing())
      .execute();
  }
  return { customerId: matchedId, created, matchedBy };
}

/** Link an identity to an existing customer explicitly (e.g. LINE account linking via token) */
export async function linkIdentity(ctx: Ctx, customerId: string, identity: { provider: string; providerAccountId?: string; externalId: string; displayName?: string; profile?: Record<string, unknown> }) {
  await ctx.trx
    .insertInto('customer_identities')
    .values({
      organization_id: ctx.actor.organizationId,
      customer_id: customerId,
      provider: identity.provider,
      provider_account_id: identity.providerAccountId ?? '',
      external_id: identity.externalId,
      display_name: identity.displayName ?? null,
      profile: JSON.stringify(identity.profile ?? {}),
    })
    .onConflict((oc) =>
      oc.columns(['organization_id', 'provider', 'provider_account_id', 'external_id']).doUpdateSet({ customer_id: customerId, unlinked_at: null, display_name: identity.displayName ?? null }),
    )
    .execute();
  await audit(ctx, { action: 'customer.identity_link', resourceType: 'customer', resourceId: customerId, metadata: { provider: identity.provider } });
}
