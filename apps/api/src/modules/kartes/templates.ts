import type { Selectable } from 'kysely';
import { accessibleShopIds, assertShopAccess, requireAnyPermission, requirePermission, type Ctx } from '../../auth/actor.js';
import type { KarteTemplates } from '../../db/types.js';
import { audit, diff } from '../../lib/audit.js';
import { Errors } from '../../lib/errors.js';
import type { CreateKarteTemplateInput, KarteField, UpdateKarteTemplateInput } from './schemas.js';

export type KarteTemplateRow = Selectable<KarteTemplates>;

export function templateFields(t: Pick<KarteTemplateRow, 'fields'>): KarteField[] {
  return (Array.isArray(t.fields) ? t.fields : []) as unknown as KarteField[];
}

export async function listKarteTemplates(ctx: Ctx, input: { shopId?: string; includeInactive?: boolean }) {
  requireAnyPermission(ctx.actor, 'karte.read', 'form.manage');
  let q = ctx.trx.selectFrom('karte_templates').selectAll();
  if (!input.includeInactive) q = q.where('status', '=', 'active');
  if (input.shopId) {
    assertShopAccess(ctx.actor, input.shopId);
    q = q.where((eb) => eb.or([eb('shop_id', 'is', null), eb('shop_id', '=', input.shopId!)]));
  } else {
    const shops = accessibleShopIds(ctx.actor);
    if (shops) q = q.where((eb) => eb.or([eb('shop_id', 'is', null), ...(shops.length ? [eb('shop_id', 'in', [...shops])] : [])]));
  }
  return q.orderBy('is_default', 'desc').orderBy('name').execute();
}

async function loadTemplate(ctx: Ctx, id: string) {
  const row = await ctx.trx.selectFrom('karte_templates').selectAll().where('id', '=', id).executeTakeFirst();
  if (!row || (row.shop_id && accessibleShopIds(ctx.actor) && !accessibleShopIds(ctx.actor)!.includes(row.shop_id))) {
    throw Errors.notFound('カルテテンプレート', id);
  }
  return row;
}

export async function getKarteTemplate(ctx: Ctx, id: string) {
  requireAnyPermission(ctx.actor, 'karte.read', 'form.manage');
  return loadTemplate(ctx, id);
}

/** Template usable for a karte in the given shop (active, org-wide or same shop) */
export async function usableKarteTemplate(ctx: Ctx, id: string, shopId: string) {
  const row = await ctx.trx.selectFrom('karte_templates').selectAll().where('id', '=', id).executeTakeFirst();
  if (!row) throw Errors.notFound('カルテテンプレート', id);
  if (row.shop_id && row.shop_id !== shopId) throw Errors.validation('このテンプレートは指定の店舗では使用できません');
  return row;
}

async function clearOtherDefaults(ctx: Ctx, keepId: string, shopId: string | null) {
  let q = ctx.trx.updateTable('karte_templates').set({ is_default: false }).where('id', '<>', keepId).where('is_default', '=', true);
  q = shopId ? q.where('shop_id', '=', shopId) : q.where('shop_id', 'is', null);
  await q.execute();
}

export async function createKarteTemplate(ctx: Ctx, input: CreateKarteTemplateInput) {
  requirePermission(ctx.actor, 'form.manage');
  if (input.shopId) assertShopAccess(ctx.actor, input.shopId);
  else if (accessibleShopIds(ctx.actor)) throw Errors.forbidden('法人共通テンプレートの作成は全店舗権限が必要です');
  const row = await ctx.trx
    .insertInto('karte_templates')
    .values({
      organization_id: ctx.actor.organizationId,
      shop_id: input.shopId ?? null,
      name: input.name,
      category: input.category ?? null,
      fields: JSON.stringify(input.fields),
      is_default: input.isDefault,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  if (row.is_default) await clearOtherDefaults(ctx, row.id, row.shop_id);
  await audit(ctx, { action: 'karte_template.create', resourceType: 'karte_template', resourceId: row.id, shopId: row.shop_id, after: row });
  return row;
}

export async function updateKarteTemplate(ctx: Ctx, id: string, input: UpdateKarteTemplateInput) {
  requirePermission(ctx.actor, 'form.manage');
  const before = await loadTemplate(ctx, id);
  if (before.shop_id) assertShopAccess(ctx.actor, before.shop_id);
  else if (accessibleShopIds(ctx.actor)) throw Errors.forbidden('法人共通テンプレートの編集は全店舗権限が必要です');
  const after = await ctx.trx
    .updateTable('karte_templates')
    .set({
      name: input.name,
      category: input.category,
      fields: input.fields ? JSON.stringify(input.fields) : undefined,
      is_default: input.isDefault,
      status: input.status,
    })
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirstOrThrow();
  if (input.isDefault) await clearOtherDefaults(ctx, id, after.shop_id);
  await audit(ctx, { action: 'karte_template.update', resourceType: 'karte_template', resourceId: id, shopId: after.shop_id, ...diff(before, after) });
  return after;
}

/** Templates are referenced by kartes, so "delete" deactivates */
export async function deactivateKarteTemplate(ctx: Ctx, id: string) {
  return updateKarteTemplate(ctx, id, { status: 'inactive', isDefault: false });
}
