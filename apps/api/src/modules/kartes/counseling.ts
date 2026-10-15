import { assertShopAccess, auditUserId, requirePermission, type Ctx } from '../../auth/actor.js';
import { audit } from '../../lib/audit.js';
import { assertCustomerAccess } from '../customers/access.js';
import type { CounselingSheetData, SaveCounselingSheetInput } from './schemas.js';

/**
 * カウンセリングシート: the counselling sheet staff keep for a customer and edit over time
 * (髪 / 目 / エクステ / 眉 / ネイル / 顔 / 体). One sheet per customer; it is health-related
 * information, so reading and saving are audited like kartes.
 * Signed, immutable documents (同意書・事前問診) are form responses — see forms.ts.
 */
async function latestSheet(ctx: Ctx, customerId: string, forUpdate = false) {
  let q = ctx.trx
    .selectFrom('customer_counseling_sheets')
    .select(['id', 'customer_id', 'shop_id', 'data', 'updated_at', 'updated_by'])
    .where('customer_id', '=', customerId)
    .orderBy('updated_at', 'desc')
    .orderBy('id', 'desc')
    .limit(1);
  if (forUpdate) q = q.forUpdate();
  return q.executeTakeFirst();
}

export async function getCounselingSheet(ctx: Ctx, customerId: string) {
  requirePermission(ctx.actor, 'karte.read');
  await assertCustomerAccess(ctx, customerId, { allowMerged: true });
  const row = await latestSheet(ctx, customerId);
  if (row) await audit(ctx, { action: 'counseling_sheet.view', resourceType: 'customer', resourceId: customerId, shopId: ctx.meta.currentShopId ?? null });
  return { counseling_sheet: row ?? null };
}

async function writeSheet(ctx: Ctx, customerId: string, data: CounselingSheetData, shopId: string | null) {
  const existing = await latestSheet(ctx, customerId, true);
  if (existing) {
    return ctx.trx
      .updateTable('customer_counseling_sheets')
      .set({ data: JSON.stringify(data), shop_id: shopId ?? existing.shop_id, updated_at: new Date(), updated_by: auditUserId(ctx.actor) })
      .where('id', '=', existing.id)
      .returning(['id', 'customer_id', 'shop_id', 'data', 'updated_at', 'updated_by'])
      .executeTakeFirstOrThrow();
  }
  return ctx.trx
    .insertInto('customer_counseling_sheets')
    .values({
      organization_id: ctx.actor.organizationId,
      customer_id: customerId,
      shop_id: shopId,
      data: JSON.stringify(data),
      created_by: auditUserId(ctx.actor),
      updated_by: auditUserId(ctx.actor),
    })
    .returning(['id', 'customer_id', 'shop_id', 'data', 'updated_at', 'updated_by'])
    .executeTakeFirstOrThrow();
}

export async function saveCounselingSheet(ctx: Ctx, customerId: string, input: SaveCounselingSheetInput) {
  requirePermission(ctx.actor, 'karte.write');
  await assertCustomerAccess(ctx, customerId);
  if (input.shopId) assertShopAccess(ctx.actor, input.shopId);
  const row = await writeSheet(ctx, customerId, input.data, input.shopId ?? ctx.meta.currentShopId ?? null);
  await audit(ctx, { action: 'counseling_sheet.save', resourceType: 'customer', resourceId: customerId, shopId: row.shop_id, metadata: { sheetId: row.id, categories: Object.keys(input.data) } });
  return { counseling_sheet: row };
}

/**
 * Add answers collected elsewhere (e.g. a walk-in intake being linked to the customer) to the
 * customer's sheet: categories present in `data` replace the same categories of the sheet, the
 * other categories are kept. For other modules — see api.ts.
 */
export async function mergeIntoCounselingSheet(ctx: Ctx, customerId: string, data: CounselingSheetData, shopId: string | null) {
  const existing = await latestSheet(ctx, customerId, true);
  const merged = { ...((existing?.data ?? {}) as CounselingSheetData), ...data };
  const row = await writeSheet(ctx, customerId, merged, shopId);
  await audit(ctx, { action: 'counseling_sheet.save', resourceType: 'customer', resourceId: customerId, shopId: row.shop_id, metadata: { sheetId: row.id, categories: Object.keys(data), via: 'merge' } });
  return row;
}
