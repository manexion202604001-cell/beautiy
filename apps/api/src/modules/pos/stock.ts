import { sql } from 'kysely';
import { auditUserId, type Ctx } from '../../auth/actor.js';

export type StockReason = 'sale' | 'return' | 'cancel';

/**
 * Adjust shop stock for a product and record the movement. Negative stock is allowed (sale is
 * never blocked at the counter) — callers report it as a warning.
 */
export async function adjustStock(
  ctx: Ctx,
  input: { productId: string; shopId: string; delta: number; reason: StockReason; transactionId: string; note?: string },
): Promise<number> {
  const res = await sql<{ quantity: number }>`
    INSERT INTO product_stocks (organization_id, product_id, shop_id, quantity)
    VALUES (${ctx.actor.organizationId}, ${input.productId}, ${input.shopId}, ${input.delta})
    ON CONFLICT (product_id, coalesce(shop_id, '00000000-0000-0000-0000-000000000000'::uuid))
    DO UPDATE SET quantity = product_stocks.quantity + EXCLUDED.quantity
    RETURNING quantity`.execute(ctx.trx);
  await ctx.trx
    .insertInto('stock_movements')
    .values({
      organization_id: ctx.actor.organizationId,
      product_id: input.productId,
      shop_id: input.shopId,
      delta: input.delta,
      reason: input.reason,
      transaction_id: input.transactionId,
      note: input.note ?? null,
      created_by: auditUserId(ctx.actor),
    })
    .execute();
  return res.rows[0]!.quantity;
}
