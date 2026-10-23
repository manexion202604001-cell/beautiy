/**
 * サロンボードから取込 (SALON BOARD import) of the メニュー screens.
 *
 * SALON BOARD has no export: the screens give the owner a small script to run in the browser console on
 * the right SALON BOARD page (apps/web/src/routes/app/menus/sbImportScripts.ts). The script copies JSON
 * to the clipboard, the owner pastes it back, and these endpoints apply it:
 *
 *  - menus / coupons (一覧「SB取込」): a comparison table first (preview), then the rows the owner ticked
 *  - one coupon page at a time (「SB取込（個別）」): exact-name update or create, no comparison
 *  - 対応スタッフ / 対応設備 tables: per menu, which stylists / equipment SALON BOARD has ticked
 *  - search categories (カテゴリ管理「SBから取込」): missing 親 / 「親：子」 categories are created
 *
 * Nothing is ever deleted: a menu that SALON BOARD no longer has can only be set to 非掲載.
 */
import { sql } from 'kysely';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { assertShopAccess, requirePermission, type Ctx } from '../../auth/actor.js';
import { audit } from '../../lib/audit.js';
import { idParam, uuid } from '../../lib/schemas.js';
import { loadAccountRow, type AccountRow } from '../integrations/accounts.js';
import { resolveMappings } from '../integrations/mail/service.js';
import { listEquipment } from './equipment.js';
import { assertMenuImageWritable, fetchSbImage, setMenuImage } from './sbImage.js';
import { COUPON_TYPES, MENU_TYPES } from './schemas.js';
import {
  CATEGORY_SEPARATOR,
  createCategory,
  createMenu,
  effectiveMenus,
  listCategories,
  setEquipmentAssignments,
  setMenuListing,
  setStaffAssignments,
  updateMenu,
  type EffectiveMenu,
} from './service.js';

const tags = ['catalog'];

/** Colours given to new parent categories, in turn (the palette of カテゴリ管理) */
export const CATEGORY_PALETTE = [
  '#6B7280',
  '#EF4444',
  '#F97316',
  '#EAB308',
  '#22C55E',
  '#14B8A6',
  '#3B82F6',
  '#6366F1',
  '#A855F7',
  '#EC4899',
] as const;

// ================================================================ schemas

const text = (max: number) => z.string().max(max).nullable().optional();

/** One menu / coupon as the SALON BOARD scripts copy it */
export const sbMenuItemSchema = z.object({
  name: z.string().max(300),
  /** 「ジャンル：カテゴリ」 (menus) or the search category 「親：子」 (coupons) */
  category: text(200),
  description: text(5000),
  price: z.number().int().min(0).max(100_000_000).nullable().optional(),
  durationMin: z.number().int().min(0).max(10_000).nullable().optional(),
  /** 「～」 after the price */
  priceTilde: z.boolean().optional(),
  /** 掲載 on SALON BOARD (menus only; coupons are listed) */
  listed: z.boolean().optional(),
  couponType: z.enum(COUPON_TYPES).nullable().optional(),
  usageCondition: text(2000),
  presentationCondition: text(200),
  imageUrl: text(2000),
});
export type SbMenuItem = z.infer<typeof sbMenuItemSchema>;

const items = z.array(sbMenuItemSchema).max(2000);

export const sbPreviewSchema = z.object({ shopId: uuid, kind: z.enum(MENU_TYPES), items });

export const sbImportSchema = z.object({
  shopId: uuid,
  /**
   * 'compare': the rows ticked on the comparison table (`selected` = item indexes, `hideMenuIds` =
   * 「SBに無い」 rows to set 非掲載). 'single': 「SB取込（個別）」 — every item, exact name only, an existing
   * menu keeps its price / time / description.
   */
  mode: z.enum(['compare', 'single']),
  kind: z.enum(MENU_TYPES).default('regular'),
  items,
  selected: z.array(z.number().int().min(0)).max(2000).optional(),
  /** 「価格・時間・説明・カテゴリも上書き」 */
  overwriteDetails: z.boolean().default(true),
  hideMenuIds: z.array(uuid).max(2000).default([]),
});

const menuKind = z.enum(MENU_TYPES).optional();

export const sbStaffImportSchema = z.object({
  shopId: uuid,
  /** column headings of the SALON BOARD table (stylists ticked nowhere still count) */
  staffNames: z.array(z.string().max(100)).max(500).optional(),
  assignments: z
    .array(
      z.object({
        menuName: z.string().max(300),
        kind: menuKind,
        noStaffNeeded: z.boolean().optional(),
        assignedStaff: z.array(z.string().max(100)).max(500),
      }),
    )
    .max(2000),
});

export const sbEquipmentImportSchema = z.object({
  shopId: uuid,
  equipmentNames: z.array(z.string().max(100)).max(500).optional(),
  assignments: z
    .array(
      z.object({
        menuName: z.string().max(300),
        kind: menuKind,
        assignedEquipment: z.array(z.string().max(100)).max(500),
      }),
    )
    .max(2000),
});

export const sbCategoryImportSchema = z.object({
  shopId: uuid,
  groups: z
    .array(
      z.object({
        parent: z.string().max(200),
        children: z.array(z.string().max(200)).max(500).default([]),
      }),
    )
    .max(500),
});

// ================================================================ matching helpers

/** name without any spaces (half / full width — \s covers U+3000): 「カット + カラー」 = 「カット+カラー」 */
export const compactName = (s: string) => s.replace(/\s+/g, '');
/** looser key for equipment names: NFKC, case and spaces ignored */
const looseKey = (s: string) => compactName(s.normalize('NFKC')).toLowerCase();

const isListed = (m: EffectiveMenu) => m.status === 'active';
const typeOf = (item: Pick<SbMenuItem, 'couponType'>): 'regular' | 'coupon' =>
  item.couponType ? 'coupon' : 'regular';

/** Finds a menu by name: exact first, then without spaces; a menu of the preferred kind wins */
function menuFinder(menus: EffectiveMenu[], opts: { compact: boolean }) {
  const pick = (list: EffectiveMenu[] | undefined, kind?: string) =>
    list ? (list.find((m) => m.menuType === kind) ?? list[0]) : undefined;
  const exact = new Map<string, EffectiveMenu[]>();
  const loose = new Map<string, EffectiveMenu[]>();
  for (const m of menus) {
    exact.set(m.name, [...(exact.get(m.name) ?? []), m]);
    const k = compactName(m.name);
    loose.set(k, [...(loose.get(k) ?? []), m]);
  }
  return (name: string, kind?: string) =>
    pick(exact.get(name), kind) ??
    (opts.compact ? pick(loose.get(compactName(name)), kind) : undefined);
}

interface Prepared {
  name: string;
  category: string | null;
  description: string | null;
  price: number;
  durationMin: number;
  priceTilde: boolean;
  listed: boolean;
  couponType: 'all' | 'new' | 'repeat' | null;
  usageCondition: string | null;
  presentationCondition: string | null;
  imageUrl: string | null;
}

/** SALON BOARD values → what a Salon OS menu can hold; null when the item cannot be imported */
function prepare(item: SbMenuItem): Prepared | null {
  const name = item.name.trim();
  if (!name || name.length > 100) return null;
  const trim = (s: string | null | undefined, max: number) =>
    (s ?? '').trim().slice(0, max) || null;
  return {
    name,
    category: trim(item.category, 200),
    description: trim(item.description, 2000),
    price: item.price ?? 0,
    // a menu without a time on SALON BOARD takes 60 minutes; Salon OS keeps 5〜720 minutes
    durationMin: Math.min(720, Math.max(5, item.durationMin || 60)),
    priceTilde: item.priceTilde ?? false,
    listed: item.listed ?? true,
    couponType: item.couponType ?? null,
    usageCondition: trim(item.usageCondition, 500),
    presentationCondition: trim(item.presentationCondition, 100),
    imageUrl: trim(item.imageUrl, 2000),
  };
}

const yenText = (n: number | null | undefined) => `¥${(n ?? 0).toLocaleString('ja-JP')}`;
const minText = (n: number | null | undefined) => `${n ?? 0}分`;
const COUPON_LABEL: Record<string, string> = { all: '全員', new: '新規', repeat: '再来' };

export interface SbChange {
  label: '掲載' | '〜表示' | 'クーポン種別' | '価格' | '時間' | '説明' | 'カテゴリ' | '表記';
  from: string;
  to: string;
}

export interface SbPreviewRow {
  index: number;
  kind: 'new' | 'update' | 'same';
  item: Prepared;
  existing: {
    id: string;
    name: string;
    categoryName: string | null;
    price: number;
    durationMin: number;
    listed: boolean;
    priceTilde: boolean;
    couponType: string | null;
    description: string | null;
    hasImage: boolean;
  } | null;
  changes: SbChange[];
  /** ticked by default: new rows and rows with a change */
  selected: boolean;
}

function changesOf(existing: EffectiveMenu, item: Prepared): SbChange[] {
  const out: SbChange[] = [];
  const listed = isListed(existing);
  if (listed !== item.listed)
    out.push({
      label: '掲載',
      from: listed ? '掲載' : '非掲載',
      to: item.listed ? '掲載' : '非掲載',
    });
  if (!!existing.priceTilde !== item.priceTilde)
    out.push({
      label: '〜表示',
      from: existing.priceTilde ? 'あり' : 'なし',
      to: item.priceTilde ? 'あり' : 'なし',
    });
  if (item.couponType && existing.couponType !== item.couponType) {
    out.push({
      label: 'クーポン種別',
      from: existing.couponType ? (COUPON_LABEL[existing.couponType] ?? existing.couponType) : '—',
      to: COUPON_LABEL[item.couponType]!,
    });
  }
  if (existing.price !== item.price)
    out.push({ label: '価格', from: yenText(existing.price), to: yenText(item.price) });
  if (existing.durationMin !== item.durationMin)
    out.push({ label: '時間', from: minText(existing.durationMin), to: minText(item.durationMin) });
  if ((existing.description ?? '') !== (item.description ?? ''))
    out.push({ label: '説明', from: existing.description || '—', to: item.description || '—' });
  if (item.category && (existing.categoryName ?? '') !== item.category)
    out.push({ label: 'カテゴリ', from: existing.categoryName || '—', to: item.category });
  if (existing.name !== item.name) out.push({ label: '表記', from: existing.name, to: item.name });
  return out;
}

/** The comparison table: every importable item against the shop's menus, plus 「SBに無い」 */
function compare(menus: EffectiveMenu[], kind: 'regular' | 'coupon', input: SbMenuItem[]) {
  const find = menuFinder(menus, { compact: true });
  const matched = new Set<string>();
  const rows: SbPreviewRow[] = [];
  let invalid = 0;
  input.forEach((raw, index) => {
    const item = prepare(raw);
    if (!item) {
      invalid += 1;
      return;
    }
    const existing = find(
      item.name,
      typeOf(item) === 'coupon' || kind === 'coupon' ? 'coupon' : 'regular',
    );
    if (existing) matched.add(existing.id);
    const changes = existing ? changesOf(existing, item) : [];
    rows.push({
      index,
      kind: !existing ? 'new' : changes.length ? 'update' : 'same',
      item,
      existing: existing
        ? {
            id: existing.id,
            name: existing.name,
            categoryName: existing.categoryName,
            price: existing.price,
            durationMin: existing.durationMin,
            listed: isListed(existing),
            priceTilde: !!existing.priceTilde,
            couponType: existing.couponType,
            description: existing.description,
            hasImage: !!existing.imageFileId,
          }
        : null,
      changes,
      selected: !existing || changes.length > 0,
    });
  });
  // listed menus of the same kind that the pasted SALON BOARD data does not contain
  const missing = menus
    .filter((m) => m.menuType === kind && isListed(m) && !matched.has(m.id))
    .map((m) => ({
      id: m.id,
      name: m.name,
      categoryName: m.categoryName,
      price: m.price,
      durationMin: m.durationMin,
    }));
  return { rows, missing, invalid };
}

async function shopMenus(ctx: Ctx, shopId: string) {
  requirePermission(ctx.actor, 'menu.manage');
  assertShopAccess(ctx.actor, shopId);
  return effectiveMenus(ctx, shopId, { includeInactive: true });
}

export async function previewSbImport(ctx: Ctx, input: z.infer<typeof sbPreviewSchema>) {
  const menus = await shopMenus(ctx, input.shopId);
  return compare(menus, input.kind, input.items);
}

/** Runs `fn` so that a failing item is counted as skipped without aborting the whole import */
async function attempt(ctx: Ctx, fn: () => Promise<void>): Promise<boolean> {
  await sql`SAVEPOINT sb_import_item`.execute(ctx.trx);
  try {
    await fn();
    await sql`RELEASE SAVEPOINT sb_import_item`.execute(ctx.trx);
    return true;
  } catch {
    await sql`ROLLBACK TO SAVEPOINT sb_import_item`.execute(ctx.trx);
    return false;
  }
}

/**
 * 「親：子」 / 「名前」 → a category of the shop, created when missing (a new parent takes the next palette
 * colour). SALON BOARD's 「ジャンル：カテゴリ」 thus becomes the same two levels as カテゴリ管理.
 */
function categoryResolver(ctx: Ctx, shopId: string) {
  let cache: Awaited<ReturnType<typeof listCategories>> | null = null;
  const load = async () => (cache ??= await listCategories(ctx, shopId));
  return async (name: string | null): Promise<string | null> => {
    if (!name) return null;
    const all = await load();
    const found = all.find((c) => c.name === name);
    if (found) return found.id;
    const top = (n: string) => all.find((c) => !c.parent_id && c.name === n);
    const parents = () => all.filter((c) => !c.parent_id);
    const nextOrder = (list: { sort_order: number }[]) =>
      list.reduce((m, c) => Math.max(m, c.sort_order), -1) + 1;
    const at = name.indexOf(CATEGORY_SEPARATOR);
    const parentName = at > 0 ? name.slice(0, at).trim() : name.trim();
    const childName = at > 0 ? name.slice(at + 1).trim() : '';
    if (!parentName || parentName.length > 50 || name.length > 50) return null;
    let parent = top(parentName);
    if (!parent) {
      const p = parents();
      parent = await createCategory(ctx, {
        shopId,
        name: parentName,
        color: CATEGORY_PALETTE[p.length % CATEGORY_PALETTE.length],
        sortOrder: nextOrder(p),
      });
      all.push(parent);
    }
    if (!childName) return parent.id;
    const siblings = all.filter((c) => c.parent_id === parent.id);
    const child = await createCategory(ctx, {
      shopId,
      name: childName,
      parentId: parent.id,
      sortOrder: nextOrder(siblings),
    });
    all.push(child);
    return child.id;
  };
}

export interface SbImportResult {
  created: number;
  updated: number;
  hidden: number;
  skipped: number;
  /** menus that should take the SALON BOARD picture (they have none yet): the screen fetches them next */
  images: { menuId: string; url: string }[];
}

export async function runSbImport(
  ctx: Ctx,
  input: z.infer<typeof sbImportSchema>,
): Promise<SbImportResult> {
  const menus = await shopMenus(ctx, input.shopId);
  const resolveCategory = categoryResolver(ctx, input.shopId);
  const result: SbImportResult = { created: 0, updated: 0, hidden: 0, skipped: 0, images: [] };
  // imported menus go after everything the shop already has, in SALON BOARD's order
  const base = menus.reduce((m, x) => Math.max(m, x.sortOrder), -1) + 1;

  type Job = { index: number; item: Prepared; existing: EffectiveMenu | null };
  const jobs: Job[] = [];
  const byId = new Map(menus.map((m) => [m.id, m]));
  if (input.mode === 'compare') {
    const { rows } = compare(menus, input.kind, input.items);
    const selected = new Set(input.selected ?? rows.filter((r) => r.selected).map((r) => r.index));
    for (const r of rows) {
      if (!selected.has(r.index) || r.kind === 'same') continue;
      jobs.push({
        index: r.index,
        item: r.item,
        existing: r.existing ? byId.get(r.existing.id)! : null,
      });
    }
  } else {
    const find = menuFinder(menus, { compact: false });
    input.items.forEach((raw, index) => {
      const item = prepare(raw);
      if (!item) result.skipped += 1;
      else jobs.push({ index, item, existing: find(item.name, typeOf(item)) ?? null });
    });
  }
  const details = input.mode === 'compare' && input.overwriteDetails;

  for (const { index, item, existing } of jobs) {
    const coupon = item.couponType
      ? {
          menuType: 'coupon' as const,
          couponType: item.couponType,
          ...(item.usageCondition ? { usageCondition: item.usageCondition } : {}),
          ...(item.presentationCondition
            ? { presentationCondition: item.presentationCondition }
            : {}),
        }
      : {};
    if (existing) {
      const ok = await attempt(ctx, async () => {
        // 価格・時間・説明・カテゴリ only with the overwrite option; 掲載・〜表示・並び順・種別 always
        let categories = {};
        if (details && item.category) {
          const id = await resolveCategory(item.category);
          if (id)
            categories = {
              subCategoryIds: [
                id,
                ...(existing.subCategoryIds ?? []).filter(
                  (c) => c !== id && c !== existing.categoryId,
                ),
              ],
            };
        }
        await updateMenu(ctx, existing.id, {
          priceTilde: item.priceTilde,
          sortOrder: base + index,
          ...coupon,
          ...(details
            ? {
                price: item.price,
                durationMin: item.durationMin,
                description: item.description,
                ...categories,
              }
            : {}),
        });
        if (isListed(existing) !== item.listed)
          await setMenuListing(ctx, existing.id, input.shopId, item.listed);
      });
      if (!ok) {
        result.skipped += 1;
        continue;
      }
      result.updated += 1;
      if (item.imageUrl && !existing.imageFileId)
        result.images.push({ menuId: existing.id, url: item.imageUrl });
      continue;
    }
    let createdId: string | null = null;
    const ok = await attempt(ctx, async () => {
      const categoryId = await resolveCategory(item.category);
      const menu = await createMenu(ctx, {
        shopId: input.shopId,
        name: item.name,
        description: item.description,
        price: item.price,
        durationMin: item.durationMin,
        priceTilde: item.priceTilde,
        sortOrder: base + index,
        status: item.listed ? 'active' : 'inactive',
        subCategoryIds: categoryId ? [categoryId] : [],
        menuType: typeOf(item),
        ...coupon,
      });
      createdId = menu.id;
    });
    if (!ok || !createdId) {
      result.skipped += 1;
      continue;
    }
    result.created += 1;
    if (item.imageUrl) result.images.push({ menuId: createdId, url: item.imageUrl });
  }

  if (input.mode === 'compare' && input.hideMenuIds.length) {
    // only 「SBに無い」 rows can be hidden: listed menus of this kind absent from the data
    const { missing } = compare(menus, input.kind, input.items);
    const allowed = new Set(missing.map((m) => m.id));
    for (const id of new Set(input.hideMenuIds)) {
      const ok =
        allowed.has(id) &&
        (await attempt(ctx, () =>
          setMenuListing(ctx, id, input.shopId, false).then(() => undefined),
        ));
      if (ok) result.hidden += 1;
      else result.skipped += 1;
    }
  }

  await audit(ctx, {
    action: 'menu.sb_import',
    resourceType: 'shop',
    resourceId: input.shopId,
    shopId: input.shopId,
    after: {
      mode: input.mode,
      kind: input.kind,
      created: result.created,
      updated: result.updated,
      hidden: result.hidden,
      skipped: result.skipped,
    },
  });
  return result;
}

// ================================================================ 対応スタッフ / 対応設備

/** Menus of the SALON BOARD table → menus of the shop (exact name, then without spaces; same kind first) */
function tableMenuMatcher(menus: EffectiveMenu[]) {
  const find = menuFinder(menus, { compact: true });
  return (name: string, kind?: 'regular' | 'coupon') =>
    name.trim() ? find(name.trim(), kind) : undefined;
}

/** A way of recognising a SALON BOARD stylist name as a Salon OS staff; the first that answers wins */
type SbStaffMatcher = (sbName: string) => Promise<string | null>;

/** Connectors whose stylist names are SALON BOARD's (HOT PEPPER Beauty) */
const SALONBOARD_PROVIDERS = ['hotpepper_mail', 'hotpepper'];

/**
 * SALON BOARD stylist name → Salon OS staff id, tried in order:
 *  1. (to come) the staff's own SALON BOARD name (`staffs.salonboard_name`): add a matcher here once
 *     the column exists, ahead of the others
 *  2. the shop's SALON BOARD connector: its 対応表 (config.staffMap) and the automatic name matching the
 *     booking mails use (resolveMappings), with the connector's own settings
 *  3. no connector: the same automatic name matching against the shop's staff
 */
async function sbStaffMatchers(ctx: Ctx, shopId: string): Promise<SbStaffMatcher[]> {
  const ref = await ctx.trx
    .selectFrom('integration_accounts')
    .select('id')
    .where('shop_id', '=', shopId)
    .where('provider', 'in', SALONBOARD_PROVIDERS)
    .where('status', '!=', 'disabled')
    .orderBy('created_at')
    .executeTakeFirst();
  const connector = ref ? await loadAccountRow(ctx.trx, ref.id) : undefined;
  // without a connector the name matching runs on a stand-in with the default settings
  const account: AccountRow = connector ?? {
    id: '00000000-0000-0000-0000-000000000000',
    organization_id: ctx.actor.organizationId,
    shop_id: shopId,
    provider: 'hotpepper_mail',
    display_name: 'SALON BOARD',
    status: 'active',
    config: {},
    encrypted_credentials: null,
    sync_cursor: null,
    last_synced_at: null,
    last_success_at: null,
    last_error: null,
    last_error_at: null,
    consecutive_failures: 0,
    created_at: new Date(0),
    updated_at: new Date(0),
  };
  return [
    async (name) =>
      (await resolveMappings(ctx, account, { staffName: name, menuNames: [] })).staff.staffId,
  ];
}

const nameList = (names: string[]) =>
  names.slice(0, 10).join('、') + (names.length > 10 ? ` ほか${names.length - 10}件` : '');

export async function importSbStaffAssignments(
  ctx: Ctx,
  input: z.infer<typeof sbStaffImportSchema>,
) {
  const menus = await shopMenus(ctx, input.shopId);
  const findMenu = tableMenuMatcher(menus);
  const matchers = await sbStaffMatchers(ctx, input.shopId);
  const sbNames = [
    ...new Set(
      [...(input.staffNames ?? []), ...input.assignments.flatMap((a) => a.assignedStaff)]
        .map((n) => n.trim())
        .filter(Boolean),
    ),
  ];
  const staffOf = new Map<string, string>();
  const unmatchedStaff: string[] = [];
  for (const name of sbNames) {
    let id: string | null = null;
    for (const m of matchers) {
      id = await m(name);
      if (id) break;
    }
    if (id) staffOf.set(name, id);
    else unmatchedStaff.push(name);
  }
  // only the stylists SALON BOARD shows are changed; staff not on SALON BOARD keep their settings
  const columns = [...new Set(staffOf.values())];
  const unmatchedMenus: string[] = [];
  const assignments = new Map<string, Set<string>>();
  let noStaffNeeded = 0;
  for (const row of input.assignments) {
    const menu = findMenu(row.menuName, row.kind);
    if (!menu) {
      if (row.menuName.trim()) unmatchedMenus.push(row.menuName.trim());
      continue;
    }
    const set = assignments.get(menu.id) ?? new Set<string>();
    if (row.noStaffNeeded) {
      // 「スタッフ不要」: Salon OS books every menu on a stylist, so the menu is left open to every one of them
      noStaffNeeded += 1;
      for (const id of columns) set.add(id);
    } else {
      for (const n of row.assignedStaff) {
        const id = staffOf.get(n.trim());
        if (id) set.add(id);
      }
    }
    assignments.set(menu.id, set);
  }
  const saved =
    columns.length && assignments.size
      ? await setStaffAssignments(ctx, {
          shopId: input.shopId,
          staffIds: columns,
          assignments: [...assignments].map(([menuId, s]) => ({ menuId, staffIds: [...s] })),
        })
      : { menus: 0, added: 0, removed: 0 };
  const lines = [
    `${assignments.size}件のメニューの対応スタッフを取り込みました（スタッフ${columns.length}名）`,
  ];
  if (noStaffNeeded)
    lines.push(`スタッフ不要のメニュー${noStaffNeeded}件は全スタッフ対応にしました`);
  if (unmatchedMenus.length)
    lines.push(`一致するメニューが無いもの${unmatchedMenus.length}件: ${nameList(unmatchedMenus)}`);
  if (unmatchedStaff.length)
    lines.push(`一致するスタッフが無いもの${unmatchedStaff.length}名: ${nameList(unmatchedStaff)}`);
  return {
    menus: assignments.size,
    staff: columns.length,
    added: saved.added,
    removed: saved.removed,
    noStaffNeeded,
    unmatchedMenus,
    unmatchedStaff,
    message: lines.join('\n'),
  };
}

export async function importSbEquipmentAssignments(
  ctx: Ctx,
  input: z.infer<typeof sbEquipmentImportSchema>,
) {
  const menus = await shopMenus(ctx, input.shopId);
  const findMenu = tableMenuMatcher(menus);
  const equipment = await listEquipment(ctx, input.shopId);
  const byExact = new Map(equipment.map((e) => [e.name, e.name]));
  const byLoose = new Map(equipment.map((e) => [looseKey(e.name), e.name]));
  const isNoEquipment = (n: string) => n.includes('設備不要');
  const sbNames = [
    ...new Set(
      [...(input.equipmentNames ?? []), ...input.assignments.flatMap((a) => a.assignedEquipment)]
        .map((n) => n.trim())
        .filter((n) => n && !isNoEquipment(n)),
    ),
  ];
  const equipmentOf = new Map<string, string>();
  const unmatchedEquipment: string[] = [];
  for (const n of sbNames) {
    const found = byExact.get(n) ?? byLoose.get(looseKey(n));
    if (found) equipmentOf.set(n, found);
    else unmatchedEquipment.push(n);
  }
  const columns = [...new Set(equipmentOf.values())];
  const unmatchedMenus: string[] = [];
  const assignments = new Map<string, Set<string>>();
  for (const row of input.assignments) {
    const menu = findMenu(row.menuName, row.kind);
    if (!menu) {
      if (row.menuName.trim()) unmatchedMenus.push(row.menuName.trim());
      continue;
    }
    const set = assignments.get(menu.id) ?? new Set<string>();
    for (const n of row.assignedEquipment) {
      const t = equipmentOf.get(n.trim());
      if (t) set.add(t);
    }
    assignments.set(menu.id, set);
  }
  const saved =
    columns.length && assignments.size
      ? await setEquipmentAssignments(ctx, {
          shopId: input.shopId,
          resourceTypes: columns,
          assignments: [...assignments].map(([menuId, s]) => ({ menuId, resourceTypes: [...s] })),
        })
      : { menus: 0, added: 0, removed: 0 };
  const lines = [
    `${assignments.size}件のメニューの対応設備を取り込みました（設備${columns.length}件）`,
  ];
  if (unmatchedMenus.length)
    lines.push(`一致するメニューが無いもの${unmatchedMenus.length}件: ${nameList(unmatchedMenus)}`);
  if (unmatchedEquipment.length)
    lines.push(
      `一致する設備が無いもの${unmatchedEquipment.length}件: ${nameList(unmatchedEquipment)}（店舗設定 › 設備で登録してください）`,
    );
  return {
    menus: assignments.size,
    equipment: columns.length,
    added: saved.added,
    removed: saved.removed,
    unmatchedMenus,
    unmatchedEquipment,
    message: lines.join('\n'),
  };
}

// ================================================================ categories

/** SALON BOARD search categories → missing parents (palette colours in turn) and 「親：子」 children */
export async function importSbCategories(ctx: Ctx, input: z.infer<typeof sbCategoryImportSchema>) {
  requirePermission(ctx.actor, 'menu.manage');
  assertShopAccess(ctx.actor, input.shopId);
  const all = await listCategories(ctx, input.shopId);
  const names = new Set(all.map((c) => c.name));
  let parentCount = all.filter((c) => !c.parent_id).length;
  let parentOrder =
    all.filter((c) => !c.parent_id).reduce((m, c) => Math.max(m, c.sort_order), -1) + 1;
  let parents = 0;
  let children = 0;
  let skipped = 0;
  for (const g of input.groups) {
    const parentName = g.parent.trim();
    if (!parentName) continue;
    let parent = all.find((c) => !c.parent_id && c.name === parentName);
    if (!parent) {
      // the name is taken by a child category, or cannot be a category name
      if (names.has(parentName) || parentName.length > 50) {
        skipped += 1;
        continue;
      }
      parent = await createCategory(ctx, {
        shopId: input.shopId,
        name: parentName,
        color: CATEGORY_PALETTE[parentCount % CATEGORY_PALETTE.length],
        sortOrder: parentOrder++,
      });
      all.push(parent);
      names.add(parentName);
      parentCount += 1;
      parents += 1;
    }
    let childOrder =
      all.filter((c) => c.parent_id === parent.id).reduce((m, c) => Math.max(m, c.sort_order), -1) +
      1;
    for (const raw of g.children) {
      const child = raw.trim();
      if (!child) continue;
      const full = parentName + CATEGORY_SEPARATOR + child;
      if (names.has(full) || full.length > 50) {
        skipped += 1;
        continue;
      }
      const row = await createCategory(ctx, {
        shopId: input.shopId,
        name: child,
        parentId: parent.id,
        sortOrder: childOrder++,
      });
      all.push(row);
      names.add(full);
      children += 1;
    }
  }
  await audit(ctx, {
    action: 'menu_category.sb_import',
    resourceType: 'shop',
    resourceId: input.shopId,
    shopId: input.shopId,
    after: { parents, children, skipped },
  });
  return {
    parents,
    children,
    skipped,
    message: `親カテゴリ ${parents}件、子カテゴリ ${children}件を作成しました。${skipped > 0 ? `（${skipped}件スキップ）` : ''}`,
  };
}

// ================================================================ routes

export const sbImportRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/menus/sb-import/preview',
    { schema: { tags, summary: 'サロンボードから取込: 比較表', body: sbPreviewSchema } },
    (req) => req.tx((ctx) => previewSbImport(ctx, req.body)),
  );
  app.post(
    '/menus/sb-import',
    {
      schema: {
        tags,
        summary: 'サロンボードから取込: 実行（比較表で選んだ行 / 個別）',
        body: sbImportSchema,
      },
    },
    (req) => req.tx((ctx) => runSbImport(ctx, req.body)),
  );
  app.post(
    '/menus/import/staff-assignments',
    { schema: { tags, summary: 'サロンボードの対応スタッフ表を取込', body: sbStaffImportSchema } },
    (req) => req.tx((ctx) => importSbStaffAssignments(ctx, req.body)),
  );
  app.post(
    '/menus/import/equipment-assignments',
    { schema: { tags, summary: 'サロンボードの対応設備表を取込', body: sbEquipmentImportSchema } },
    (req) => req.tx((ctx) => importSbEquipmentAssignments(ctx, req.body)),
  );
  app.post(
    '/menu-categories/import',
    { schema: { tags, summary: 'サロンボードの検索カテゴリを取込', body: sbCategoryImportSchema } },
    (req) => req.tx((ctx) => importSbCategories(ctx, req.body)),
  );
  app.post(
    '/menus/:id/image-from-url',
    {
      schema: {
        tags,
        summary: 'メニュー画像をURL（サロンボードの画像）から取込',
        params: idParam,
        body: z.object({ url: z.string().min(1).max(2000) }),
      },
    },
    async (req) => {
      // permission first, then the download outside any transaction, then the store
      await req.tx((ctx) => assertMenuImageWritable(ctx, req.params.id));
      const image = await fetchSbImage(req.body.url);
      return req.tx((ctx) => setMenuImage(ctx, req.params.id, image));
    },
  );
};
