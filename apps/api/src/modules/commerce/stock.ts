import { sql } from 'kysely';
import { auditUserId, type Ctx } from '../../auth/actor.js';
import { Errors } from '../../lib/errors.js';

export type StockReason = 'sale' | 'order' | 'adjust' | 'return' | 'receive' | 'cancel' | 'transfer';

export interface StockMovementInput {
  productId: string;
  /** null = EC warehouse */
  shopId: string | null;
  delta: number;
  reason: StockReason;
  orderId?: string | null;
  transactionId?: string | null;
  note?: string | null;
  /** allow the resulting quantity to go below zero (POS sales of physically present goods) */
  allowNegative?: boolean;
  /** product name for error messages */
  productName?: string;
}

/**
 * Atomically apply a stock delta for one location and record the movement.
 * The conditional UPDATE makes concurrent reservations safe: it fails instead of overselling.
 */
export async function applyStockMovement(ctx: Ctx, input: StockMovementInput): Promise<{ quantity: number; reorderPoint: number | null }> {
  if (!Number.isInteger(input.delta) || input.delta === 0) throw Errors.validation('在庫数の増減は0以外の整数で指定してください');
  await sql`
    INSERT INTO product_stocks (organization_id, product_id, shop_id, quantity)
    VALUES (${ctx.actor.organizationId}, ${input.productId}, ${input.shopId}, 0)
    ON CONFLICT (product_id, coalesce(shop_id, '00000000-0000-0000-0000-000000000000'::uuid)) DO NOTHING`.execute(ctx.trx);
  let q = ctx.trx
    .updateTable('product_stocks')
    .set({ quantity: sql`quantity + ${input.delta}` })
    .where('product_id', '=', input.productId)
    .where(sql<boolean>`shop_id IS NOT DISTINCT FROM ${input.shopId}::uuid`);
  if (!input.allowNegative && input.delta < 0) q = q.where(sql<boolean>`quantity + ${input.delta} >= 0`);
  const row = await q.returning(['quantity', 'reorder_point']).executeTakeFirst();
  if (!row) {
    const current = await ctx.trx
      .selectFrom('product_stocks')
      .select('quantity')
      .where('product_id', '=', input.productId)
      .where(sql<boolean>`shop_id IS NOT DISTINCT FROM ${input.shopId}::uuid`)
      .executeTakeFirst();
    throw Errors.business('INSUFFICIENT_STOCK', `${input.productName ? `「${input.productName}」の` : ''}在庫が不足しています`, {
      productId: input.productId,
      shopId: input.shopId,
      available: current?.quantity ?? 0,
      requested: -input.delta,
    });
  }
  await ctx.trx
    .insertInto('stock_movements')
    .values({
      organization_id: ctx.actor.organizationId,
      product_id: input.productId,
      shop_id: input.shopId,
      delta: input.delta,
      reason: input.reason,
      order_id: input.orderId ?? null,
      transaction_id: input.transactionId ?? null,
      note: input.note ?? null,
      created_by: auditUserId(ctx.actor),
    })
    .execute();
  return { quantity: row.quantity, reorderPoint: row.reorder_point };
}
