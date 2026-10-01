import { sql, type ExpressionBuilder } from 'kysely';
import { accessibleShopIds, can, requirePermission, type Ctx } from '../../auth/actor.js';
import type { DB } from '../../db/types.js';
import { Errors } from '../../lib/errors.js';

/**
 * Customer visibility (Resource Authorization, 要件 2.1 / FR-09):
 *  - customers are organization-level records
 *  - staff with scope.all_shops or customer.read_all_shops see every customer
 *  - other staff see customers whose primary shop, or any shop relation, is one of their shops
 */
export function canSeeAllCustomers(ctx: Ctx): boolean {
  return accessibleShopIds(ctx.actor) === null || can(ctx.actor, 'customer.read_all_shops');
}

export function visibleCustomerFilter(ctx: Ctx) {
  if (canSeeAllCustomers(ctx)) return null;
  const shopIds = [...(accessibleShopIds(ctx.actor) ?? [])];
  const ids = shopIds.length ? shopIds : ['00000000-0000-0000-0000-000000000000'];
  return (eb: ExpressionBuilder<DB, 'customers'>) =>
    eb.or([
      eb('customers.primary_shop_id', 'in', ids),
      eb.exists(
        eb
          .selectFrom('customer_shop_relations as csr')
          .select(sql`1`.as('x'))
          .whereRef('csr.customer_id', '=', 'customers.id')
          .where('csr.shop_id', 'in', ids),
      ),
    ]);
}

/** Throws 404 when the customer does not exist / is not visible (no existence leak) */
export async function assertCustomerAccess(ctx: Ctx, customerId: string, opts: { allowMerged?: boolean } = {}) {
  requirePermission(ctx.actor, 'customer.read');
  let q = ctx.trx
    .selectFrom('customers')
    .select(['customers.id', 'customers.status', 'customers.merged_into_id', 'customers.primary_shop_id'])
    .where('customers.id', '=', customerId)
    .where('customers.deleted_at', 'is', null);
  const filter = visibleCustomerFilter(ctx);
  if (filter) q = q.where(filter);
  const row = await q.executeTakeFirst();
  if (!row) throw Errors.notFound('顧客', customerId);
  if (row.status === 'merged' && !opts.allowMerged) {
    throw Errors.business('CUSTOMER_MERGED', 'この顧客は統合済みです', { mergedIntoId: row.merged_into_id });
  }
  return row;
}
