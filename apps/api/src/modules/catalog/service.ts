import { sql } from 'kysely';
import { assertShopAccess, auditUserId, requirePermission, type Ctx } from '../../auth/actor.js';
import { audit, diff } from '../../lib/audit.js';
import { Errors } from '../../lib/errors.js';
import { percentOf } from '../../lib/money.js';
import { storage } from '../../lib/storage.js';
import { getAttachableFile, markFileDeleted } from '../files/api.js';
import type { CreateCouponInput, CreateMenuInput, EquipmentAssignmentsInput, StaffAssignmentsInput, UpdateCouponInput, UpdateMenuInput } from './schemas.js';

// ================================================================ categories

const categoryCols = ['id', 'shop_id', 'name', 'sort_order', 'color', 'parent_id'] as const;

/** Separator between the parent and the child part of a category name (「まつげ：上」) */
export const CATEGORY_SEPARATOR = '：';

export async function listCategories(ctx: Ctx, shopId?: string) {
  let q = ctx.trx.selectFrom('menu_categories').select(categoryCols).where('deleted_at', 'is', null).orderBy('sort_order').orderBy('name');
  if (shopId) q = q.where((eb) => eb.or([eb('shop_id', 'is', null), eb('shop_id', '=', shopId)]));
  return q.execute();
}

async function loadCategory(ctx: Ctx, id: string) {
  const row = await ctx.trx.selectFrom('menu_categories').select(categoryCols).where('id', '=', id).where('deleted_at', 'is', null).executeTakeFirst();
  if (!row) throw Errors.notFound('カテゴリ', id);
  return row;
}

/** A parent must be a live top-level category usable from the child's shop */
async function loadParentCategory(ctx: Ctx, parentId: string, child: { id?: string; shopId: string | null }) {
  const parent = await ctx.trx.selectFrom('menu_categories').select(categoryCols).where('id', '=', parentId).where('deleted_at', 'is', null).executeTakeFirst();
  if (!parent) throw Errors.validation('親カテゴリが見つかりません');
  if (parent.id === child.id) throw Errors.validation('自分自身を親カテゴリにはできません');
  if (parent.parent_id) throw Errors.validation('親カテゴリに指定できるのは最上位のカテゴリだけです');
  if (parent.shop_id && parent.shop_id !== child.shopId) throw Errors.validation('他店舗のカテゴリを親カテゴリにはできません');
  return parent;
}

/** 「親：子」: the child part of a category name (the whole name when it has no such prefix) */
function childPart(name: string, parentName: string | null | undefined): string {
  const prefix = parentName ? parentName + CATEGORY_SEPARATOR : null;
  const part = prefix && name.startsWith(prefix) ? name.slice(prefix.length) : name;
  return part.trim();
}

export async function createCategory(ctx: Ctx, input: { shopId?: string | null; name: string; sortOrder?: number; color?: string | null; parentId?: string | null }) {
  requirePermission(ctx.actor, 'menu.manage');
  if (input.shopId) assertShopAccess(ctx.actor, input.shopId);
  const parent = input.parentId ? await loadParentCategory(ctx, input.parentId, { shopId: input.shopId ?? null }) : null;
  let name = input.name.trim();
  if (parent) {
    const part = childPart(name, parent.name);
    if (!part) throw Errors.validation('カテゴリ名を入力してください');
    name = parent.name + CATEGORY_SEPARATOR + part;
  }
  if (!name) throw Errors.validation('カテゴリ名を入力してください');
  return ctx.trx
    .insertInto('menu_categories')
    .values({
      organization_id: ctx.actor.organizationId,
      shop_id: input.shopId ?? null,
      name,
      sort_order: input.sortOrder ?? 0,
      // a child always carries its parent's colour (the calendar colours by the menu's own category)
      color: parent ? parent.color : (input.color ?? null),
      parent_id: parent?.id ?? null,
    })
    .returning(categoryCols)
    .executeTakeFirstOrThrow();
}

export async function updateCategory(ctx: Ctx, id: string, input: { name?: string; sortOrder?: number; color?: string | null; parentId?: string | null }) {
  requirePermission(ctx.actor, 'menu.manage');
  const before = await loadCategory(ctx, id);
  if (before.shop_id) assertShopAccess(ctx.actor, before.shop_id);
  const parentId = input.parentId === undefined ? before.parent_id : input.parentId;
  const oldParent = before.parent_id ? await ctx.trx.selectFrom('menu_categories').select(['id', 'name']).where('id', '=', before.parent_id).executeTakeFirst() : null;
  const parent = parentId ? await loadParentCategory(ctx, parentId, { id, shopId: before.shop_id }) : null;
  if (parent && !before.parent_id) {
    const child = await ctx.trx.selectFrom('menu_categories').select('id').where('parent_id', '=', id).where('deleted_at', 'is', null).executeTakeFirst();
    if (child) throw Errors.validation('子カテゴリを持つカテゴリは、他のカテゴリの子にできません');
  }

  let name: string | undefined;
  if (input.name !== undefined || parentId !== before.parent_id) {
    // strip the previous and the new parent prefix, then put the current parent in front
    const part = childPart(childPart(input.name ?? before.name, oldParent?.name), parent?.name);
    if (!part) throw Errors.validation('カテゴリ名を入力してください');
    name = parent ? parent.name + CATEGORY_SEPARATOR + part : part;
  }
  const color = parent ? parent.color : input.color;

  const row = await ctx.trx
    .updateTable('menu_categories')
    .set({ name, sort_order: input.sortOrder, color, parent_id: input.parentId === undefined ? undefined : (parent?.id ?? null), updated_at: new Date() })
    .where('id', '=', id)
    .returning(categoryCols)
    .executeTakeFirstOrThrow();

  // children follow their parent: 「親：子」 prefix and colour
  if (!row.parent_id && (row.name !== before.name || row.color !== before.color)) {
    const children = await ctx.trx.selectFrom('menu_categories').select(['id', 'name']).where('parent_id', '=', id).where('deleted_at', 'is', null).execute();
    for (const c of children) {
      await ctx.trx
        .updateTable('menu_categories')
        .set({ name: row.name + CATEGORY_SEPARATOR + childPart(c.name, before.name), color: row.color, updated_at: new Date() })
        .where('id', '=', c.id)
        .execute();
    }
  }
  await audit(ctx, { action: 'menu_category.update', resourceType: 'menu_category', resourceId: id, shopId: row.shop_id, ...diff(before as never, row as never) });
  return row;
}

export async function reorderCategories(ctx: Ctx, items: { id: string; sortOrder: number }[]) {
  requirePermission(ctx.actor, 'menu.manage');
  const rows = await ctx.trx.selectFrom('menu_categories').select(['id', 'shop_id']).where('id', 'in', items.map((i) => i.id)).where('deleted_at', 'is', null).execute();
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const it of items) {
    const row = byId.get(it.id);
    if (!row) throw Errors.notFound('カテゴリ', it.id);
    if (row.shop_id) assertShopAccess(ctx.actor, row.shop_id);
    await ctx.trx.updateTable('menu_categories').set({ sort_order: it.sortOrder, updated_at: new Date() }).where('id', '=', it.id).execute();
  }
  return { updated: items.length };
}

/**
 * Soft-delete categories. Menus keep existing: a deleted category is taken off them, and the next
 * category ticked on the menu (if any) becomes its main one — otherwise the menu is uncategorised.
 */
async function removeCategories(ctx: Ctx, ids: string[]) {
  if (!ids.length) return;
  const gone = new Set(ids);
  const menus = await ctx.trx
    .selectFrom('menus')
    .select(['id', 'category_id', 'sub_category_ids'])
    .where((eb) => eb.or([eb('category_id', 'in', ids), sql<boolean>`sub_category_ids && ${ids}::uuid[]`]))
    .execute();
  for (const m of menus) {
    const rest = m.sub_category_ids.filter((c) => !gone.has(c));
    await ctx.trx
      .updateTable('menus')
      .set({ sub_category_ids: rest, category_id: m.category_id && gone.has(m.category_id) ? (rest[0] ?? null) : m.category_id })
      .where('id', '=', m.id)
      .execute();
  }
  await ctx.trx.updateTable('menu_categories').set({ deleted_at: new Date() }).where('id', 'in', ids).execute();
}

/** Deletes a category; a parent goes together with its child categories */
export async function deleteCategory(ctx: Ctx, id: string) {
  requirePermission(ctx.actor, 'menu.manage');
  const row = await ctx.trx.selectFrom('menu_categories').select(['id', 'shop_id', 'name']).where('id', '=', id).where('deleted_at', 'is', null).executeTakeFirst();
  if (!row) return;
  if (row.shop_id) assertShopAccess(ctx.actor, row.shop_id);
  const children = await ctx.trx.selectFrom('menu_categories').select('id').where('parent_id', '=', id).where('deleted_at', 'is', null).execute();
  await removeCategories(ctx, [id, ...children.map((c) => c.id)]);
  await audit(ctx, { action: 'menu_category.delete', resourceType: 'menu_category', resourceId: id, shopId: row.shop_id, before: { name: row.name, children: children.length } });
}

/**
 * 全削除: every category of the shop. Organization-wide categories (shared with the other shops) are
 * deleted too only by an actor allowed to act for all shops; otherwise they are kept and counted.
 */
export async function deleteAllCategories(ctx: Ctx, shopId: string): Promise<{ deleted: number; kept: number }> {
  requirePermission(ctx.actor, 'menu.manage');
  assertShopAccess(ctx.actor, shopId);
  const rows = await ctx.trx
    .selectFrom('menu_categories')
    .select(['id', 'shop_id'])
    .where('deleted_at', 'is', null)
    .where((eb) => eb.or([eb('shop_id', '=', shopId), eb('shop_id', 'is', null)]))
    .execute();
  const shared = ctx.actor.kind !== 'staff' || ctx.actor.allShops;
  const remove = rows.filter((r) => r.shop_id === shopId || shared).map((r) => r.id);
  await removeCategories(ctx, remove);
  const result = { deleted: remove.length, kept: rows.length - remove.length };
  await audit(ctx, { action: 'menu_category.delete_all', resourceType: 'shop', resourceId: shopId, shopId, after: result });
  return result;
}

// ================================================================ menus

export interface EffectiveMenu {
  id: string;
  shopId: string | null;
  categoryId: string | null;
  categoryName: string | null;
  name: string;
  description: string | null;
  durationMin: number;
  bufferBeforeMin: number;
  bufferAfterMin: number;
  price: number;
  priceTaxIncluded: boolean;
  taxRateBp: number;
  isPublic: boolean;
  isConsultation: boolean;
  newCustomerOnly: boolean;
  sortOrder: number;
  status: string;
  isOverridden: boolean;
  resourceRequirements: { resourceType: string; offsetMin: number; durationMin: number | null }[];
  staffIds: string[];
  /** 'regular' 通常メニュー / 'coupon' クーポン */
  menuType: 'regular' | 'coupon';
  couponType: 'all' | 'new' | 'repeat' | null;
  presentationCondition: string | null;
  usageCondition: string | null;
  /** last bookable day (shop-local 'YYYY-MM-DD'); null = no expiry */
  expiryDate: string | null;
  priceTilde: boolean;
  subCategoryIds: string[];
  imageFileId: string | null;
  /** short-lived signed URL of the menu picture */
  imageUrl: string | null;
}

/** Menu pictures are not personal data: one hour so a list left open keeps its thumbnails */
const MENU_IMAGE_URL_TTL_SEC = 3600;

/** Signed URLs of uploaded menu pictures, by file id */
async function menuImageUrls(ctx: Ctx, fileIds: (string | null)[]): Promise<Map<string, string>> {
  const ids = [...new Set(fileIds.filter((f): f is string => !!f))];
  const out = new Map<string, string>();
  if (!ids.length) return out;
  const files = await ctx.trx.selectFrom('files').select(['id', 'object_key']).where('id', 'in', ids).where('status', '=', 'uploaded').execute();
  for (const f of files) out.set(f.id, await storage.presignDownload(f.object_key, MENU_IMAGE_URL_TTL_SEC));
  return out;
}

/**
 * Effective menus for a shop: org-common menus (shop_id NULL) + the shop's own menus,
 * with per-shop overrides (price/duration/availability) applied (要件 FR-09 共通/店舗独自メニュー).
 */
export async function effectiveMenus(ctx: Ctx, shopId: string, opts: { publicOnly?: boolean; includeInactive?: boolean; menuIds?: string[] } = {}): Promise<EffectiveMenu[]> {
  let q = ctx.trx
    .selectFrom('menus')
    .leftJoin('menu_shop_overrides as o', (j) => j.onRef('o.menu_id', '=', 'menus.id').on('o.shop_id', '=', shopId))
    .leftJoin('menu_categories as c', 'c.id', 'menus.category_id')
    .leftJoin('menu_categories as pc', 'pc.id', 'c.parent_id')
    .select([
      'menus.id',
      'menus.shop_id',
      'menus.category_id',
      'c.name as category_name',
      'c.sort_order as category_sort',
      'menus.name',
      'menus.description',
      sql<number>`coalesce(o.duration_min, menus.duration_min)`.as('duration_min'),
      'menus.buffer_before_min',
      'menus.buffer_after_min',
      sql<number>`coalesce(o.price, menus.price)`.as('price'),
      'menus.price_tax_included',
      'menus.tax_rate_bp',
      'menus.is_public',
      'menus.is_consultation',
      'menus.new_customer_only',
      'menus.sort_order',
      'menus.status',
      sql<boolean>`coalesce(o.is_available, true)`.as('is_available'),
      sql<boolean>`o.id IS NOT NULL`.as('is_overridden'),
      'menus.menu_type',
      'menus.coupon_type',
      'menus.presentation_condition',
      'menus.usage_condition',
      'menus.expiry_date',
      'menus.price_tilde',
      'menus.sub_category_ids',
      'menus.image_file_id',
    ])
    .where('menus.deleted_at', 'is', null)
    .where((eb) => eb.or([eb('menus.shop_id', 'is', null), eb('menus.shop_id', '=', shopId)]))
    // a child category sorts with its parent (the screens group 「親：子」 under 「親」); inside a group
    // the menu's own order comes first, as the up/down buttons of the menu list set it
    .orderBy(sql`coalesce(pc.sort_order, c.sort_order, 9999)`)
    .orderBy('menus.sort_order')
    .orderBy(sql`coalesce(c.sort_order, 9999)`)
    .orderBy('menus.name');
  if (!opts.includeInactive) {
    q = q
      .where('menus.status', '=', 'active')
      .where(sql<boolean>`coalesce(o.is_available, true)`)
      // 有効期限: bookable up to and including the expiry date, in the shop's timezone
      .where(sql<boolean>`(menus.expiry_date IS NULL OR menus.expiry_date >= (now() AT TIME ZONE coalesce((SELECT s.timezone FROM shops s WHERE s.id = ${shopId}), 'Asia/Tokyo'))::date)`);
  }
  if (opts.publicOnly) q = q.where('menus.is_public', '=', true);
  if (opts.menuIds) q = q.where('menus.id', 'in', opts.menuIds.length ? opts.menuIds : ['00000000-0000-0000-0000-000000000000']);
  const rows = await q.execute();
  const ids = rows.map((r) => r.id);
  const [reqs, staffMenus, images] = await Promise.all([
    ids.length ? ctx.trx.selectFrom('menu_resource_requirements').select(['menu_id', 'resource_type', 'offset_min', 'duration_min']).where('menu_id', 'in', ids).execute() : [],
    ids.length ? ctx.trx.selectFrom('staff_menus').select(['menu_id', 'staff_id']).where('menu_id', 'in', ids).execute() : [],
    menuImageUrls(ctx, rows.map((r) => r.image_file_id)),
  ]);
  return rows.map((r) => ({
    id: r.id,
    shopId: r.shop_id,
    categoryId: r.category_id,
    categoryName: r.category_name,
    name: r.name,
    description: r.description,
    durationMin: r.duration_min,
    bufferBeforeMin: r.buffer_before_min,
    bufferAfterMin: r.buffer_after_min,
    price: r.price,
    priceTaxIncluded: r.price_tax_included,
    taxRateBp: r.tax_rate_bp,
    isPublic: r.is_public,
    isConsultation: r.is_consultation,
    newCustomerOnly: r.new_customer_only,
    sortOrder: r.sort_order,
    status: r.is_available ? r.status : 'unavailable',
    isOverridden: r.is_overridden,
    resourceRequirements: reqs.filter((x) => x.menu_id === r.id).map((x) => ({ resourceType: x.resource_type, offsetMin: x.offset_min, durationMin: x.duration_min })),
    staffIds: staffMenus.filter((x) => x.menu_id === r.id).map((x) => x.staff_id),
    menuType: r.menu_type === 'coupon' ? 'coupon' : 'regular',
    couponType: r.coupon_type as EffectiveMenu['couponType'],
    presentationCondition: r.presentation_condition,
    usageCondition: r.usage_condition,
    expiryDate: r.expiry_date,
    priceTilde: r.price_tilde,
    subCategoryIds: r.sub_category_ids,
    imageFileId: r.image_file_id,
    imageUrl: r.image_file_id ? (images.get(r.image_file_id) ?? null) : null,
  }));
}

/** Staff-specific duration/price (ランク別料金) on top of effective menu values */
export async function menuForStaff(ctx: Ctx, menu: EffectiveMenu, staffId: string | null) {
  if (!staffId) return { durationMin: menu.durationMin, price: menu.price };
  const sm = await ctx.trx.selectFrom('staff_menus').select(['duration_min', 'price']).where('staff_id', '=', staffId).where('menu_id', '=', menu.id).executeTakeFirst();
  return { durationMin: sm?.duration_min ?? menu.durationMin, price: sm?.price ?? menu.price };
}

/** Can this staff perform the menu? (no staff_menus rows for a staff = can do everything) */
export async function staffCanPerform(ctx: Ctx, staffId: string, menuIds: string[]): Promise<boolean> {
  const rows = await ctx.trx.selectFrom('staff_menus').select('menu_id').where('staff_id', '=', staffId).execute();
  if (rows.length === 0) return true;
  const set = new Set(rows.map((r) => r.menu_id));
  return menuIds.every((m) => set.has(m));
}

export async function getMenu(ctx: Ctx, menuId: string) {
  const menu = await ctx.trx.selectFrom('menus').selectAll().where('id', '=', menuId).where('deleted_at', 'is', null).executeTakeFirst();
  if (!menu) throw Errors.notFound('メニュー', menuId);
  const [reqs, staff, overrides, images] = await Promise.all([
    ctx.trx.selectFrom('menu_resource_requirements').select(['resource_type', 'offset_min', 'duration_min']).where('menu_id', '=', menuId).execute(),
    ctx.trx.selectFrom('staff_menus').select(['staff_id', 'duration_min', 'price']).where('menu_id', '=', menuId).execute(),
    ctx.trx.selectFrom('menu_shop_overrides').select(['shop_id', 'price', 'duration_min', 'is_available']).where('menu_id', '=', menuId).execute(),
    menuImageUrls(ctx, [menu.image_file_id]),
  ]);
  return { ...menu, image_url: menu.image_file_id ? (images.get(menu.image_file_id) ?? null) : null, resourceRequirements: reqs, staff, overrides };
}

/**
 * Categories ticked on the edit form → { category_id, sub_category_ids }.
 * `subCategoryIds` wins (its first entry is the main category); a bare `categoryId` keeps working.
 */
async function resolveMenuCategories(ctx: Ctx, input: Pick<UpdateMenuInput, 'categoryId' | 'subCategoryIds'>): Promise<{ category_id?: string | null; sub_category_ids?: string[] }> {
  if (input.subCategoryIds === undefined && input.categoryId === undefined) return {};
  const ids = input.subCategoryIds !== undefined ? [...new Set(input.subCategoryIds)] : input.categoryId ? [input.categoryId] : [];
  if (ids.length) {
    const found = await ctx.trx.selectFrom('menu_categories').select('id').where('id', 'in', ids).where('deleted_at', 'is', null).execute();
    if (found.length !== ids.length) throw Errors.validation('カテゴリが見つかりません');
  }
  const main = input.subCategoryIds !== undefined ? (ids[0] ?? null) : (input.categoryId ?? null);
  return { category_id: main, sub_category_ids: ids };
}

/** Coupon-only fields are cleared on regular menus so a menu switched back keeps no stale conditions */
function couponColumns(menuType: string, input: Pick<UpdateMenuInput, 'couponType' | 'presentationCondition' | 'usageCondition' | 'expiryDate'>) {
  if (menuType !== 'coupon') return { coupon_type: null, presentation_condition: null, usage_condition: null, expiry_date: null };
  return {
    coupon_type: input.couponType === undefined ? undefined : (input.couponType ?? 'all'),
    presentation_condition: input.presentationCondition === undefined ? undefined : input.presentationCondition || null,
    usage_condition: input.usageCondition === undefined ? undefined : input.usageCondition || null,
    expiry_date: input.expiryDate === undefined ? undefined : input.expiryDate || null,
  };
}

async function assertMenuImage(ctx: Ctx, fileId: string | null | undefined) {
  if (fileId) await getAttachableFile(ctx, fileId, ['menu_image']);
}

async function replaceMenuRelations(ctx: Ctx, menuId: string, input: Pick<CreateMenuInput, 'resourceRequirements' | 'staffIds'>) {
  if (input.resourceRequirements) {
    await ctx.trx.deleteFrom('menu_resource_requirements').where('menu_id', '=', menuId).execute();
    if (input.resourceRequirements.length) {
      await ctx.trx
        .insertInto('menu_resource_requirements')
        .values(
          input.resourceRequirements.map((r) => ({
            organization_id: ctx.actor.organizationId,
            menu_id: menuId,
            resource_type: r.resourceType,
            offset_min: r.offsetMin ?? 0,
            duration_min: r.durationMin ?? null,
          })),
        )
        .execute();
    }
  }
  if (input.staffIds) {
    const existing = await ctx.trx.selectFrom('staff_menus').select(['staff_id']).where('menu_id', '=', menuId).execute();
    const keep = new Set(input.staffIds);
    const remove = existing.filter((e) => !keep.has(e.staff_id)).map((e) => e.staff_id);
    if (remove.length) await ctx.trx.deleteFrom('staff_menus').where('menu_id', '=', menuId).where('staff_id', 'in', remove).execute();
    const add = input.staffIds.filter((s) => !existing.some((e) => e.staff_id === s));
    if (add.length) {
      await ctx.trx.insertInto('staff_menus').values(add.map((staffId) => ({ staff_id: staffId, menu_id: menuId, organization_id: ctx.actor.organizationId }))).execute();
    }
  }
}

export async function createMenu(ctx: Ctx, input: CreateMenuInput) {
  requirePermission(ctx.actor, 'menu.manage');
  if (input.shopId) assertShopAccess(ctx.actor, input.shopId);
  else if (ctx.actor.kind === 'staff' && !ctx.actor.allShops) throw Errors.forbidden('共通メニューの作成には全店舗権限が必要です');
  const menuType = input.menuType ?? 'regular';
  const categories = await resolveMenuCategories(ctx, input);
  await assertMenuImage(ctx, input.imageFileId);
  const coupon = couponColumns(menuType, { couponType: input.couponType ?? 'all', presentationCondition: input.presentationCondition ?? null, usageCondition: input.usageCondition ?? null, expiryDate: input.expiryDate ?? null });
  const row = await ctx.trx
    .insertInto('menus')
    .values({
      organization_id: ctx.actor.organizationId,
      shop_id: input.shopId ?? null,
      category_id: categories.category_id ?? null,
      sub_category_ids: categories.sub_category_ids ?? [],
      menu_type: menuType,
      ...coupon,
      price_tilde: input.priceTilde ?? false,
      image_file_id: input.imageFileId ?? null,
      status: input.status ?? 'active',
      name: input.name,
      description: input.description ?? null,
      duration_min: input.durationMin,
      buffer_before_min: input.bufferBeforeMin ?? 0,
      buffer_after_min: input.bufferAfterMin ?? 0,
      price: input.price,
      price_tax_included: input.priceTaxIncluded ?? true,
      tax_rate_bp: input.taxRateBp ?? 1000,
      is_public: input.isPublic ?? true,
      is_consultation: input.isConsultation ?? false,
      // a 新規 coupon is a new-customer-only menu unless the caller says otherwise
      new_customer_only: input.newCustomerOnly ?? (menuType === 'coupon' && input.couponType === 'new'),
      sort_order: input.sortOrder ?? 0,
      created_by: auditUserId(ctx.actor),
      trace_id: ctx.meta.traceId ?? null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await replaceMenuRelations(ctx, row.id, input);
  await audit(ctx, { action: 'menu.create', resourceType: 'menu', resourceId: row.id, shopId: input.shopId ?? null, after: input });
  return getMenu(ctx, row.id);
}

export async function updateMenu(ctx: Ctx, menuId: string, input: UpdateMenuInput) {
  requirePermission(ctx.actor, 'menu.manage');
  const before = await getMenu(ctx, menuId);
  if (before.shop_id) assertShopAccess(ctx.actor, before.shop_id);
  else if (ctx.actor.kind === 'staff' && !ctx.actor.allShops) throw Errors.forbidden('共通メニューの編集には全店舗権限が必要です（店舗別上書きを使用してください）');
  const menuType = input.menuType ?? before.menu_type;
  const categories = await resolveMenuCategories(ctx, input);
  if (input.imageFileId && input.imageFileId !== before.image_file_id) await assertMenuImage(ctx, input.imageFileId);
  await ctx.trx
    .updateTable('menus')
    .set({
      ...categories,
      menu_type: input.menuType,
      // switching a regular menu to a coupon starts it as 全員 unless a type is given
      ...couponColumns(menuType, { ...input, couponType: input.couponType ?? (menuType === 'coupon' && !before.coupon_type ? 'all' : undefined) }),
      price_tilde: input.priceTilde,
      image_file_id: input.imageFileId,
      name: input.name,
      description: input.description,
      duration_min: input.durationMin,
      buffer_before_min: input.bufferBeforeMin,
      buffer_after_min: input.bufferAfterMin,
      price: input.price,
      price_tax_included: input.priceTaxIncluded,
      tax_rate_bp: input.taxRateBp,
      is_public: input.isPublic,
      is_consultation: input.isConsultation,
      new_customer_only: input.newCustomerOnly ?? (menuType === 'coupon' && input.couponType !== undefined ? input.couponType === 'new' : undefined),
      sort_order: input.sortOrder,
      status: input.status,
      updated_by: auditUserId(ctx.actor),
      trace_id: ctx.meta.traceId ?? null,
    })
    .where('id', '=', menuId)
    .execute();
  // the replaced / removed picture is no longer referenced by anything
  if (input.imageFileId !== undefined && before.image_file_id && before.image_file_id !== input.imageFileId) await markFileDeleted(ctx, before.image_file_id);
  await replaceMenuRelations(ctx, menuId, input);
  const after = await getMenu(ctx, menuId);
  // image_url is a freshly signed URL on every read: not a change
  await audit(ctx, { action: 'menu.update', resourceType: 'menu', resourceId: menuId, ...diff({ ...before, image_url: null } as never, { ...after, image_url: null } as never) });
  return after;
}

/**
 * Soft delete (reservation history keeps the menu name). With `checkUsage` a menu that reservations
 * refer to is refused with 409 MENU_IN_USE so the screen can ask before hiding it.
 */
export async function deleteMenu(ctx: Ctx, menuId: string, opts: { checkUsage?: boolean } = {}) {
  requirePermission(ctx.actor, 'menu.manage');
  const menu = await getMenu(ctx, menuId);
  if (menu.shop_id) assertShopAccess(ctx.actor, menu.shop_id);
  if (opts.checkUsage) {
    // read-only existence check on the reservation lines that point at this menu
    const used = await ctx.trx.selectFrom('appointment_services').select('id').where('menu_id', '=', menuId).limit(1).executeTakeFirst();
    if (used) throw Errors.conflict('MENU_IN_USE', 'このメニューは予約で使用されています。');
  }
  await ctx.trx.updateTable('menus').set({ deleted_at: new Date(), status: 'inactive' }).where('id', '=', menuId).execute();
  // a deleted menu must not keep restricting its staff to it ("no rows for a staff = every menu")
  await ctx.trx.deleteFrom('staff_menus').where('menu_id', '=', menuId).execute();
  await audit(ctx, { action: 'menu.delete', resourceType: 'menu', resourceId: menuId });
}

/** Menus that exist for a shop (its own + the organization-wide ones), by id */
async function shopMenusById(ctx: Ctx, shopId: string, menuIds: string[]) {
  if (!menuIds.length) return new Map<string, { id: string; shop_id: string | null }>();
  const rows = await ctx.trx
    .selectFrom('menus')
    .select(['id', 'shop_id'])
    .where('id', 'in', menuIds)
    .where('deleted_at', 'is', null)
    .where((eb) => eb.or([eb('shop_id', 'is', null), eb('shop_id', '=', shopId)]))
    .execute();
  return new Map(rows.map((r) => [r.id, r]));
}

/** Display order of menus (the up / down buttons of the menu list) */
export async function reorderMenus(ctx: Ctx, items: { id: string; sortOrder: number }[]) {
  requirePermission(ctx.actor, 'menu.manage');
  const rows = await ctx.trx.selectFrom('menus').select(['id', 'shop_id']).where('id', 'in', items.map((i) => i.id)).where('deleted_at', 'is', null).execute();
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const it of items) {
    const row = byId.get(it.id);
    if (!row) throw Errors.notFound('メニュー', it.id);
    if (row.shop_id) assertShopAccess(ctx.actor, row.shop_id);
    else if (ctx.actor.kind === 'staff' && !ctx.actor.allShops) throw Errors.forbidden('共通メニューの並び替えには全店舗権限が必要です');
  }
  for (const it of items) {
    await ctx.trx.updateTable('menus').set({ sort_order: it.sortOrder, updated_by: auditUserId(ctx.actor) }).where('id', '=', it.id).execute();
  }
  await audit(ctx, { action: 'menu.reorder', resourceType: 'menu', after: { items } });
  return { updated: items.length };
}

/**
 * 掲載 / 非掲載 of a menu as seen from one shop.
 *  - the shop's own menu: status active / inactive
 *  - an organization-wide menu: the shop's override (is_available), so other shops are not affected;
 *    listing it again also re-activates the menu itself when it was switched off for everyone
 */
export async function setMenuListing(ctx: Ctx, menuId: string, shopId: string, listed: boolean) {
  requirePermission(ctx.actor, 'menu.manage');
  assertShopAccess(ctx.actor, shopId);
  const menu = await getMenu(ctx, menuId);
  if (menu.shop_id && menu.shop_id !== shopId) throw Errors.validation('他店舗のメニューは変更できません');
  if (menu.shop_id) {
    await ctx.trx.updateTable('menus').set({ status: listed ? 'active' : 'inactive', updated_by: auditUserId(ctx.actor) }).where('id', '=', menuId).execute();
  } else {
    if (listed && menu.status !== 'active') {
      if (ctx.actor.kind === 'staff' && !ctx.actor.allShops) throw Errors.forbidden('共通メニューの掲載には全店舗権限が必要です');
      await ctx.trx.updateTable('menus').set({ status: 'active', updated_by: auditUserId(ctx.actor) }).where('id', '=', menuId).execute();
    }
    const override = menu.overrides.find((o) => o.shop_id === shopId);
    if (override) {
      await ctx.trx.updateTable('menu_shop_overrides').set({ is_available: listed, updated_at: new Date() }).where('menu_id', '=', menuId).where('shop_id', '=', shopId).execute();
    } else if (!listed) {
      await ctx.trx.insertInto('menu_shop_overrides').values({ organization_id: ctx.actor.organizationId, menu_id: menuId, shop_id: shopId, is_available: false }).execute();
    }
  }
  await audit(ctx, { action: 'menu.listing', resourceType: 'menu', resourceId: menuId, shopId, after: { listed } });
  const [effective] = await effectiveMenus(ctx, shopId, { includeInactive: true, menuIds: [menuId] });
  return effective!;
}

/**
 * 対応スタッフ matrix of one shop. Only the staff shown as columns are touched; a kept row keeps its
 * per-staff duration / price.
 */
export async function setStaffAssignments(ctx: Ctx, input: StaffAssignmentsInput) {
  requirePermission(ctx.actor, 'menu.manage');
  assertShopAccess(ctx.actor, input.shopId);
  const columns = [...new Set(input.staffIds)];
  const menus = await shopMenusById(ctx, input.shopId, input.assignments.map((a) => a.menuId));
  for (const a of input.assignments) {
    if (!menus.has(a.menuId)) throw Errors.notFound('メニュー', a.menuId);
    if (a.staffIds.some((s) => !columns.includes(s))) throw Errors.validation('対象外のスタッフが含まれています');
  }
  if (columns.length) {
    const staff = await ctx.trx.selectFrom('staffs').select('id').where('id', 'in', columns).where('deleted_at', 'is', null).execute();
    if (staff.length !== columns.length) throw Errors.validation('スタッフが見つかりません');
  }
  let added = 0;
  let removed = 0;
  if (columns.length) {
    for (const a of input.assignments) {
      const want = new Set(a.staffIds);
      const existing = await ctx.trx.selectFrom('staff_menus').select('staff_id').where('menu_id', '=', a.menuId).where('staff_id', 'in', columns).execute();
      const have = new Set(existing.map((e) => e.staff_id));
      const remove = [...have].filter((s) => !want.has(s));
      const add = [...want].filter((s) => !have.has(s));
      if (remove.length) await ctx.trx.deleteFrom('staff_menus').where('menu_id', '=', a.menuId).where('staff_id', 'in', remove).execute();
      if (add.length) await ctx.trx.insertInto('staff_menus').values(add.map((staffId) => ({ staff_id: staffId, menu_id: a.menuId, organization_id: ctx.actor.organizationId }))).execute();
      added += add.length;
      removed += remove.length;
    }
  }
  await audit(ctx, { action: 'menu.staff_assignments', resourceType: 'shop', resourceId: input.shopId, shopId: input.shopId, after: { menus: input.assignments.length, added, removed } });
  return { menus: input.assignments.length, added, removed };
}

/**
 * 対応設備 matrix of one shop: which kinds of equipment (resource types) a menu occupies. A ticked
 * kind becomes a resource requirement for the whole menu, so bookings are limited by the number of
 * units of that kind; a kept requirement keeps its offset / duration.
 */
export async function setEquipmentAssignments(ctx: Ctx, input: EquipmentAssignmentsInput) {
  requirePermission(ctx.actor, 'menu.manage');
  assertShopAccess(ctx.actor, input.shopId);
  const columns = [...new Set(input.resourceTypes)];
  const menus = await shopMenusById(ctx, input.shopId, input.assignments.map((a) => a.menuId));
  for (const a of input.assignments) {
    if (!menus.has(a.menuId)) throw Errors.notFound('メニュー', a.menuId);
    if (a.resourceTypes.some((r) => !columns.includes(r))) throw Errors.validation('対象外の設備が含まれています');
  }
  let added = 0;
  let removed = 0;
  if (columns.length) {
    for (const a of input.assignments) {
      const want = new Set(a.resourceTypes);
      const existing = await ctx.trx.selectFrom('menu_resource_requirements').select(['id', 'resource_type']).where('menu_id', '=', a.menuId).where('resource_type', 'in', columns).execute();
      const have = new Set(existing.map((e) => e.resource_type));
      const remove = existing.filter((e) => !want.has(e.resource_type)).map((e) => e.id);
      const add = [...want].filter((r) => !have.has(r));
      if (remove.length) await ctx.trx.deleteFrom('menu_resource_requirements').where('id', 'in', remove).execute();
      if (add.length) {
        await ctx.trx
          .insertInto('menu_resource_requirements')
          .values(add.map((resourceType) => ({ organization_id: ctx.actor.organizationId, menu_id: a.menuId, resource_type: resourceType, offset_min: 0, duration_min: null })))
          .execute();
      }
      added += add.length;
      removed += remove.length;
    }
  }
  await audit(ctx, { action: 'menu.equipment_assignments', resourceType: 'shop', resourceId: input.shopId, shopId: input.shopId, after: { menus: input.assignments.length, added, removed } });
  return { menus: input.assignments.length, added, removed };
}

export async function setMenuOverride(ctx: Ctx, menuId: string, shopId: string, input: { price?: number | null; durationMin?: number | null; isAvailable?: boolean }) {
  requirePermission(ctx.actor, 'menu.manage');
  assertShopAccess(ctx.actor, shopId);
  const menu = await getMenu(ctx, menuId);
  if (menu.shop_id && menu.shop_id !== shopId) throw Errors.validation('他店舗の独自メニューは上書きできません');
  const row = await ctx.trx
    .insertInto('menu_shop_overrides')
    .values({
      organization_id: ctx.actor.organizationId,
      menu_id: menuId,
      shop_id: shopId,
      price: input.price ?? null,
      duration_min: input.durationMin ?? null,
      is_available: input.isAvailable ?? true,
    })
    .onConflict((oc) => oc.columns(['menu_id', 'shop_id']).doUpdateSet({ price: input.price ?? null, duration_min: input.durationMin ?? null, is_available: input.isAvailable ?? true }))
    .returning(['menu_id', 'shop_id', 'price', 'duration_min', 'is_available'])
    .executeTakeFirstOrThrow();
  await audit(ctx, { action: 'menu.override', resourceType: 'menu', resourceId: menuId, shopId, after: input });
  return row;
}

export async function deleteMenuOverride(ctx: Ctx, menuId: string, shopId: string) {
  requirePermission(ctx.actor, 'menu.manage');
  assertShopAccess(ctx.actor, shopId);
  await ctx.trx.deleteFrom('menu_shop_overrides').where('menu_id', '=', menuId).where('shop_id', '=', shopId).execute();
}

export async function setStaffMenus(ctx: Ctx, staffId: string, menus: { menuId: string; durationMin?: number | null; price?: number | null }[]) {
  requirePermission(ctx.actor, 'menu.manage');
  await ctx.trx.deleteFrom('staff_menus').where('staff_id', '=', staffId).execute();
  if (menus.length) {
    await ctx.trx
      .insertInto('staff_menus')
      .values(menus.map((m) => ({ staff_id: staffId, menu_id: m.menuId, organization_id: ctx.actor.organizationId, duration_min: m.durationMin ?? null, price: m.price ?? null })))
      .execute();
  }
  await audit(ctx, { action: 'staff.menus_update', resourceType: 'staff', resourceId: staffId, after: menus });
  return ctx.trx.selectFrom('staff_menus').select(['menu_id', 'duration_min', 'price']).where('staff_id', '=', staffId).execute();
}

// ================================================================ resources

export async function listResources(ctx: Ctx, shopId: string) {
  assertShopAccess(ctx.actor, shopId);
  return ctx.trx
    .selectFrom('resources')
    .select(['id', 'shop_id', 'name', 'resource_type', 'sort_order', 'status'])
    .where('shop_id', '=', shopId)
    .where('deleted_at', 'is', null)
    .orderBy('resource_type')
    .orderBy('sort_order')
    .execute();
}

export async function createResource(ctx: Ctx, input: { shopId: string; name: string; resourceType: string; sortOrder?: number }) {
  requirePermission(ctx.actor, 'menu.manage');
  assertShopAccess(ctx.actor, input.shopId);
  return ctx.trx
    .insertInto('resources')
    .values({ organization_id: ctx.actor.organizationId, shop_id: input.shopId, name: input.name, resource_type: input.resourceType, sort_order: input.sortOrder ?? 0 })
    .returning(['id', 'shop_id', 'name', 'resource_type', 'sort_order', 'status'])
    .executeTakeFirstOrThrow();
}

export async function updateResource(ctx: Ctx, id: string, input: { name?: string; resourceType?: string; sortOrder?: number; status?: 'active' | 'inactive' }) {
  requirePermission(ctx.actor, 'menu.manage');
  const r = await ctx.trx.selectFrom('resources').select('shop_id').where('id', '=', id).executeTakeFirst();
  if (!r) throw Errors.notFound('設備', id);
  assertShopAccess(ctx.actor, r.shop_id);
  return ctx.trx
    .updateTable('resources')
    .set({ name: input.name, resource_type: input.resourceType, sort_order: input.sortOrder, status: input.status })
    .where('id', '=', id)
    .returning(['id', 'shop_id', 'name', 'resource_type', 'sort_order', 'status'])
    .executeTakeFirstOrThrow();
}

export async function deleteResource(ctx: Ctx, id: string) {
  requirePermission(ctx.actor, 'menu.manage');
  const r = await ctx.trx.selectFrom('resources').select('shop_id').where('id', '=', id).executeTakeFirst();
  if (!r) throw Errors.notFound('設備', id);
  assertShopAccess(ctx.actor, r.shop_id);
  await ctx.trx.updateTable('resources').set({ deleted_at: new Date(), status: 'inactive' }).where('id', '=', id).execute();
}

// ================================================================ coupons

const couponCols = [
  'id',
  'shop_id',
  'code',
  'name',
  'description',
  'discount_type',
  'discount_value',
  'applicable_menu_ids',
  'min_amount',
  'valid_from',
  'valid_until',
  'usage_limit',
  'per_customer_limit',
  'new_customer_only',
  'is_public',
  'status',
  'created_at',
] as const;

export async function listCoupons(ctx: Ctx, filter: { shopId?: string; publicOnly?: boolean; activeAt?: Date } = {}) {
  let q = ctx.trx.selectFrom('coupons').select(couponCols).where('deleted_at', 'is', null).orderBy('created_at', 'desc');
  if (filter.shopId) q = q.where((eb) => eb.or([eb('shop_id', 'is', null), eb('shop_id', '=', filter.shopId!)]));
  if (filter.publicOnly) q = q.where('is_public', '=', true).where('status', '=', 'active');
  if (filter.activeAt) {
    const at = filter.activeAt;
    q = q
      .where((eb) => eb.or([eb('valid_from', 'is', null), eb('valid_from', '<=', at)]))
      .where((eb) => eb.or([eb('valid_until', 'is', null), eb('valid_until', '>', at)]));
  }
  return q.execute();
}

export async function createCoupon(ctx: Ctx, input: CreateCouponInput) {
  requirePermission(ctx.actor, 'menu.manage');
  if (input.shopId) assertShopAccess(ctx.actor, input.shopId);
  const row = await ctx.trx
    .insertInto('coupons')
    .values({
      organization_id: ctx.actor.organizationId,
      shop_id: input.shopId ?? null,
      code: input.code ?? null,
      name: input.name,
      description: input.description ?? null,
      discount_type: input.discountType,
      discount_value: input.discountValue,
      applicable_menu_ids: input.applicableMenuIds ?? [],
      min_amount: input.minAmount ?? 0,
      valid_from: input.validFrom ? new Date(input.validFrom) : null,
      valid_until: input.validUntil ? new Date(input.validUntil) : null,
      usage_limit: input.usageLimit ?? null,
      per_customer_limit: input.perCustomerLimit ?? null,
      new_customer_only: input.newCustomerOnly ?? false,
      is_public: input.isPublic ?? true,
    })
    .returning(couponCols)
    .executeTakeFirstOrThrow();
  await audit(ctx, { action: 'coupon.create', resourceType: 'coupon', resourceId: row.id, after: input });
  return row;
}

export async function updateCoupon(ctx: Ctx, id: string, input: UpdateCouponInput) {
  requirePermission(ctx.actor, 'menu.manage');
  const row = await ctx.trx
    .updateTable('coupons')
    .set({
      code: input.code,
      name: input.name,
      description: input.description,
      discount_type: input.discountType,
      discount_value: input.discountValue,
      applicable_menu_ids: input.applicableMenuIds,
      min_amount: input.minAmount,
      valid_from: input.validFrom === undefined ? undefined : input.validFrom ? new Date(input.validFrom) : null,
      valid_until: input.validUntil === undefined ? undefined : input.validUntil ? new Date(input.validUntil) : null,
      usage_limit: input.usageLimit,
      per_customer_limit: input.perCustomerLimit,
      new_customer_only: input.newCustomerOnly,
      is_public: input.isPublic,
      status: input.status,
    })
    .where('id', '=', id)
    .where('deleted_at', 'is', null)
    .returning(couponCols)
    .executeTakeFirst();
  if (!row) throw Errors.notFound('クーポン', id);
  await audit(ctx, { action: 'coupon.update', resourceType: 'coupon', resourceId: id, after: input });
  return row;
}

export async function deleteCoupon(ctx: Ctx, id: string) {
  requirePermission(ctx.actor, 'menu.manage');
  await ctx.trx.updateTable('coupons').set({ deleted_at: new Date(), status: 'inactive' }).where('id', '=', id).execute();
}

export interface CouponEvaluation {
  couponId: string;
  name: string;
  valid: boolean;
  reason?: string;
  discountAmount: number;
}

/**
 * Validate a coupon for a booking/checkout and compute the discount (税込).
 *  amount:      fixed yen off
 *  percent:     % off applicable lines
 *  fixed_price: applicable lines are charged discount_value in total
 */
export async function evaluateCoupon(
  ctx: Ctx,
  input: {
    couponId?: string;
    code?: string;
    shopId: string;
    customerId?: string | null;
    lines: { menuId?: string | null; amount: number }[];
    at?: Date;
    excludeAppointmentId?: string;
    excludeTransactionId?: string;
  },
): Promise<CouponEvaluation> {
  let q = ctx.trx.selectFrom('coupons').selectAll().where('deleted_at', 'is', null);
  if (input.couponId) q = q.where('id', '=', input.couponId);
  else if (input.code) q = q.where('code', '=', input.code);
  else throw Errors.validation('couponIdまたはcodeが必要です');
  const c = await q.executeTakeFirst();
  if (!c) throw Errors.notFound('クーポン');
  const at = input.at ?? new Date();
  const fail = (reason: string): CouponEvaluation => ({ couponId: c.id, name: c.name, valid: false, reason, discountAmount: 0 });

  if (c.status !== 'active') return fail('無効なクーポンです');
  if (c.shop_id && c.shop_id !== input.shopId) return fail('この店舗では利用できません');
  if (c.valid_from && c.valid_from > at) return fail('利用開始前です');
  if (c.valid_until && c.valid_until <= at) return fail('有効期限切れです');

  const applicable = c.applicable_menu_ids.length ? input.lines.filter((l) => l.menuId && c.applicable_menu_ids.includes(l.menuId)) : input.lines;
  const base = applicable.reduce((s, l) => s + l.amount, 0);
  if (applicable.length === 0) return fail('対象メニューが含まれていません');
  if (base < c.min_amount) return fail(`${c.min_amount}円以上で利用できます`);

  if (c.usage_limit !== null || c.per_customer_limit !== null || c.new_customer_only) {
    const usedBase = ctx.trx
      .selectFrom('coupon_redemptions')
      .where('coupon_id', '=', c.id)
      .where('status', '!=', 'released')
      .$if(!!input.excludeAppointmentId, (qb) => qb.where((eb) => eb.or([eb('appointment_id', 'is', null), eb('appointment_id', '!=', input.excludeAppointmentId!)])))
      .$if(!!input.excludeTransactionId, (qb) => qb.where((eb) => eb.or([eb('transaction_id', 'is', null), eb('transaction_id', '!=', input.excludeTransactionId!)])));
    if (c.usage_limit !== null) {
      const used = await usedBase.select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow();
      if (used.n >= c.usage_limit) return fail('利用上限に達しました');
    }
    if (input.customerId) {
      if (c.per_customer_limit !== null) {
        const used = await usedBase.where('customer_id', '=', input.customerId).select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow();
        if (used.n >= c.per_customer_limit) return fail('お一人様の利用上限に達しました');
      }
      if (c.new_customer_only) {
        const cust = await ctx.trx.selectFrom('customers').select('visit_count').where('id', '=', input.customerId).executeTakeFirst();
        if (cust && cust.visit_count > 0) return fail('新規のお客様限定です');
      }
    }
  }

  let discount: number;
  if (c.discount_type === 'amount') discount = Math.min(c.discount_value, base);
  else if (c.discount_type === 'percent') discount = percentOf(base, c.discount_value);
  else discount = Math.max(0, base - c.discount_value);
  return { couponId: c.id, name: c.name, valid: true, discountAmount: discount };
}
