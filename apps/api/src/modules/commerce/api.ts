import type { Ctx } from '../../auth/actor.js';
import { Errors } from '../../lib/errors.js';
import { applyStockMovement } from './stock.js';

/**
 * PUBLIC CONTRACT of the commerce module for in-store sales (店頭販売). POS calls these inside its
 * own transaction when a sale with product lines completes / is refunded. No permission checks here:
 * the caller (POS) has already authorized the sale.
 */
export interface StockSaleInput {
  productId: string;
  shopId: string;
  quantity: number;
  transactionId: string;
}

export interface StockSaleResult {
  /** false when the product is not stock managed (no movement recorded) */
  tracked: boolean;
  quantity: number | null;
  /** quantity at or below the shop's reorder point after this sale */
  belowReorderPoint: boolean;
}

async function product(ctx: Ctx, productId: string) {
  const p = await ctx.trx.selectFrom('products').select(['id', 'name', 'stock_managed']).where('id', '=', productId).executeTakeFirst();
  if (!p) throw Errors.notFound('商品', productId);
  return p;
}

/** Decrement shop stock for a POS sale (stock may go negative: the goods physically exist) */
export async function decrementStockForSale(ctx: Ctx, input: StockSaleInput): Promise<StockSaleResult> {
  if (!Number.isInteger(input.quantity) || input.quantity <= 0) throw Errors.validation('数量が不正です');
  const p = await product(ctx, input.productId);
  if (!p.stock_managed) return { tracked: false, quantity: null, belowReorderPoint: false };
  const res = await applyStockMovement(ctx, {
    productId: input.productId,
    shopId: input.shopId,
    delta: -input.quantity,
    reason: 'sale',
    transactionId: input.transactionId,
    allowNegative: true,
    productName: p.name,
  });
  return { tracked: true, quantity: res.quantity, belowReorderPoint: res.reorderPoint !== null && res.quantity <= res.reorderPoint };
}

/** Put goods back into shop stock (POS void/refund of a product line) */
export async function restockForReturn(ctx: Ctx, input: StockSaleInput): Promise<StockSaleResult> {
  if (!Number.isInteger(input.quantity) || input.quantity <= 0) throw Errors.validation('数量が不正です');
  const p = await product(ctx, input.productId);
  if (!p.stock_managed) return { tracked: false, quantity: null, belowReorderPoint: false };
  const res = await applyStockMovement(ctx, { productId: input.productId, shopId: input.shopId, delta: input.quantity, reason: 'return', transactionId: input.transactionId, productName: p.name });
  return { tracked: true, quantity: res.quantity, belowReorderPoint: res.reorderPoint !== null && res.quantity <= res.reorderPoint };
}
