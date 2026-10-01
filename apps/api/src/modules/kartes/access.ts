import { accessibleShopIds, assertShopAccess, can, requirePermission, type Ctx } from '../../auth/actor.js';
import { Errors } from '../../lib/errors.js';
import { assertCustomerAccess } from '../customers/access.js';

/**
 * Karte visibility (Resource Authorization):
 *  - karte.read is required
 *  - staff limited to assigned shops see kartes written in those shops, unless they can read customers
 *    across shops (customer.read_all_shops / scope.all_shops)
 *  - the customer must be visible to the actor (assertCustomerAccess) — invisible → 404 (no existence leak)
 * Writes additionally need karte.write and an assignment to the karte's shop.
 */
export function karteShopFilter(ctx: Ctx): readonly string[] | null {
  const ids = accessibleShopIds(ctx.actor);
  if (ids === null || can(ctx.actor, 'customer.read_all_shops')) return null;
  return ids;
}

export async function assertKarteReadable(ctx: Ctx, karte: { id: string; shop_id: string; customer_id: string }) {
  requirePermission(ctx.actor, 'karte.read');
  const shops = karteShopFilter(ctx);
  if (shops && !shops.includes(karte.shop_id)) throw Errors.notFound('カルテ', karte.id);
  await assertCustomerAccess(ctx, karte.customer_id, { allowMerged: true });
}

export async function assertKarteWritable(ctx: Ctx, karte: { id: string; shop_id: string; customer_id: string }) {
  requirePermission(ctx.actor, 'karte.write');
  await assertKarteReadable(ctx, karte);
  assertShopAccess(ctx.actor, karte.shop_id);
}
