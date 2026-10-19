/**
 * Import one SALOGIC shop (export JSON + downloaded images) into Salon OS: the shop, its business
 * hours and 予約受付設定, equipment, menu categories, menus / coupons (with pictures, 対応スタッフ,
 * 対応設備) and staff (with photos, スタッフ別 営業時間 / 予約設定). Customer data is not imported.
 *
 *   pnpm --filter @salon/api exec tsx src/scripts/import-salogic.ts \
 *     --file <export.json> --images <dir with manifest.json> --slug fein-omotesando
 *
 * The shop's Hot Pepper Beauty (SALON BOARD) connector is set up as well: booking-notification
 * mails are taken in, slots booked in Salon OS become 枠止め requests (ADR 0010), and the SALON BOARD
 * staff names SALOGIC recorded are mapped to the imported staff. Add --connect-only to set up just
 * the connector for a shop imported earlier.
 *
 * The organization (slug "fein") is created on the first run with a development login
 * (FEIN_OWNER_EMAIL / FEIN_OWNER_PASSWORD); later runs add a shop to it. A shop slug that already
 * exists is refused, so a run never duplicates data. Real staff get no login account: managers set
 * one up later from the staff screen.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { sql } from 'kysely';
import { systemActor, type Ctx } from '../auth/actor.js';
import { db } from '../db/client.js';
import { withSystem, withTenant } from '../db/tenant.js';
import '../modules/index.js';
import { createEquipment } from '../modules/catalog/equipment.js';
import { createCategory, createMenu } from '../modules/catalog/service.js';
import { createFileRecord } from '../modules/files/api.js';
import { createIntegration } from '../modules/integrations/accounts.js';
import { createShop, createStaff, listRoles, signup, updateShop, updateStaff } from '../modules/org/service.js';
import { updateStaffExtras } from '../modules/org/staff-screen.js';
import { replaceBusinessHours, replaceStaffBusinessHours, replaceStaffReservationSettings } from '../modules/schedules/service.js';

const ORG_SLUG = 'fein';

interface SgStaff {
  id: string;
  name: string;
  nickname: string | null;
  email: string | null;
  role: 'owner' | 'manager' | 'staff';
  is_active: number;
  retired_at: string | null;
  is_visible_to_customer: number;
  sort_order: number;
  salonboard_name: string | null;
  avatar_url: string | null;
}
interface SgMenu {
  id: string;
  name: string;
  description: string | null;
  category: string;
  sub_categories: string | string[] | null;
  duration: number;
  price: number;
  sort_order: number;
  is_active: number;
  is_bookable: number;
  menu_type: 'regular' | 'coupon';
  coupon_type: 'all' | 'new' | 'repeat' | null;
  presentation_condition: string | null;
  usage_condition: string | null;
  expiry_date: string | null;
  price_tilde: number;
  image_url: string | null;
  assigned_staff_ids: string[];
  assigned_equipment_ids: string[];
}
interface SgHours {
  day_of_week: number;
  open_time: string;
  close_time: string;
  is_closed: number;
  max_concurrent?: number;
}
interface SgExport {
  store: Record<string, unknown> & { name: string; address: string | null; phone: string | null; email: string | null };
  business_hours: SgHours[];
  equipment: { id: string; name: string; quantity: number; is_active: number; sort_order: number }[];
  categories: { categories: { id: string; name: string; color: string | null; sort_order: number; parent_id: string | null }[] };
  menus: SgMenu[];
  staff: SgStaff[];
  staff_store_assignments: { id: string; stores: { id: string; is_primary: number; is_visible_to_customer: number }[] }[];
  per_staff: Record<string, { hours: { business_hours?: SgHours[] }; rs: { settings?: Record<string, unknown> | null } }>;
  store_id: string;
}

const { values: args } = parseArgs({
  options: { file: { type: 'string' }, images: { type: 'string' }, slug: { type: 'string' }, 'connect-only': { type: 'boolean' } },
});
if (!args.file || !args.images || !args.slug) {
  console.error('usage: import-salogic.ts --file <export.json> --images <dir> --slug <shop slug>');
  process.exit(1);
}

const tx = <T>(organizationId: string, fn: (ctx: Ctx) => Promise<T>) =>
  withTenant(organizationId, (trx) => fn({ actor: systemActor(organizationId, 'salogic-import'), trx, meta: { traceId: 'salogic-import' } }));

/** 「東京都渋谷区神宮前４-3-4 …」 → 都道府県 / 市区町村 / それ以降 */
function splitAddress(address: string | null) {
  const s = (address ?? '').trim();
  const m = s.match(/^(東京都|北海道|(?:京都|大阪)府|.{2,3}県)?(.+?[市区町村](?:.+?[区町村])?)?(.*)$/);
  return { prefecture: m?.[1] ?? null, city: m?.[2] ?? null, addressLine: (m?.[3] ?? s).trim() || null };
}

const bool = (v: unknown) => v === 1 || v === true;

/**
 * Hot Pepper Beauty connector of the shop (booking-notification mails in, 枠止め requests out). SALON BOARD
 * staff names come from SALOGIC; staff are found by their name in the shop.
 */
async function connectSalonBoard(orgId: string, shopId: string, data: SgExport) {
  return tx(orgId, async (ctx) => {
    const existing = await ctx.trx.selectFrom('integration_accounts').select('id').where('shop_id', '=', shopId).where('provider', '=', 'hotpepper_mail').executeTakeFirst();
    if (existing) return { integrationAccountId: existing.id, created: false, staffMap: 0 };
    const staff = await ctx.trx
      .selectFrom('staffs')
      .innerJoin('staff_shop_assignments as a', 'a.staff_id', 'staffs.id')
      .select(['staffs.id', 'staffs.display_name'])
      .where('a.shop_id', '=', shopId)
      .where('staffs.deleted_at', 'is', null)
      .execute();
    const byName = new Map(staff.map((s) => [s.display_name, s.id]));
    const staffMap: Record<string, string> = {};
    for (const s of data.staff) {
      const id = byName.get(s.name);
      if (s.salonboard_name && id && !s.retired_at) staffMap[s.salonboard_name.trim()] = id;
    }
    const row = await createIntegration(ctx, {
      provider: 'hotpepper_mail',
      shopId,
      displayName: 'ホットペッパービューティー（サロンボード）',
      config: { staffMap, menuMap: {}, conflictPolicy: 'manual', pushBlocks: true },
    });
    return { integrationAccountId: row.id, created: true, staffMap: Object.keys(staffMap).length };
  });
}

async function main() {
  const data = JSON.parse(await readFile(args.file!, 'utf8')) as SgExport;
  const manifest = JSON.parse(await readFile(path.join(args.images!, 'manifest.json'), 'utf8')) as Record<string, { file: string }>;
  const image = async (key: string) => {
    const m = manifest[key];
    if (!m) return null;
    return readFile(path.join(args.images!, path.basename(m.file)));
  };
  const store = data.store;
  const slug = args.slug!;

  if (args['connect-only']) {
    const shop = await withSystem((trx) =>
      trx.selectFrom('shops').innerJoin('organizations as o', 'o.id', 'shops.organization_id').select(['shops.id', 'shops.organization_id']).where('o.slug', '=', ORG_SLUG).where('shops.slug', '=', slug).executeTakeFirst(),
    );
    if (!shop) throw new Error(`shop "${slug}" not found in ${ORG_SLUG}`);
    console.log(JSON.stringify(await connectSalonBoard(shop.organization_id, shop.id, data), null, 1));
    return;
  }

  // ------------------------------------------------------------ organization + shop
  const org = await withSystem((trx) => trx.selectFrom('organizations').select('id').where('slug', '=', ORG_SLUG).executeTakeFirst());
  const sgOwner = data.staff.find((s) => s.role === 'owner');
  let orgId: string;
  let shopId: string;
  let ownerStaffId: string | null = null;
  const addr = splitAddress(store.address);
  if (!org) {
    const email = process.env.FEIN_OWNER_EMAIL;
    const password = process.env.FEIN_OWNER_PASSWORD;
    if (!email || !password) throw new Error('FEIN_OWNER_EMAIL / FEIN_OWNER_PASSWORD are required to create the organization');
    const created = await signup({
      organizationName: 'fein.',
      organizationSlug: ORG_SLUG,
      shopName: store.name,
      shopSlug: slug,
      ownerName: sgOwner?.name ?? 'オーナー',
      email,
      password,
      phone: store.phone?.trim() || undefined,
    });
    orgId = created.organizationId;
    shopId = created.shopId;
    ownerStaffId = created.staffId;
  } else {
    orgId = org.id;
    const exists = await withSystem((trx) => trx.selectFrom('shops').select('id').where('organization_id', '=', orgId).where('slug', '=', slug).executeTakeFirst());
    if (exists) throw new Error(`shop "${slug}" already exists in ${ORG_SLUG}; nothing imported`);
    shopId = (await tx(orgId, (ctx) => createShop(ctx, { name: store.name, slug, phone: store.phone?.trim() || null }))).id;
  }

  const hours = new Map(data.business_hours.map((h) => [h.day_of_week, h]));
  const holiday = hours.get(7);
  const capacity = (h: SgHours | undefined) => (h && h.max_concurrent ? Math.min(20, h.max_concurrent) : null);
  await tx(orgId, async (ctx) => {
    await updateShop(ctx, shopId, {
      name: store.name,
      phone: store.phone?.trim() || null,
      email: (store.email as string | null) || null,
      postalCode: (store.postal_code as string | null) || null,
      ...addr,
      settings: {
        booking: {
          horizonDays: Math.min(365, Number(store.advance_booking_days) || 60),
          advanceMonths: store.advance_booking_months ? Number(store.advance_booking_months) : null,
          leadTimeMin: (Number(store.booking_cutoff_same_day_minutes) || 0) + (Number(store.same_day_cutoff_hours) || 0) * 60,
          cutoffType: store.booking_cutoff_type === 'days_before' ? 'days_before' : 'same_day',
          cutoffDaysBefore: Math.max(1, Number(store.booking_cutoff_days_before) || 1),
          cutoffTime: (store.booking_cutoff_time as string) || '24:00',
          calcMethod: store.booking_calc_method === 'business_days' ? 'business_days' : 'calendar',
          acceptSameStartTime: bool(store.accept_same_start_time),
          acceptOutsideHours: bool(store.accept_outside_hours),
        },
        hours: {
          holidayEnabled: bool(store.holiday_hours_enabled) && !!holiday,
          holidayClosed: holiday ? bool(holiday.is_closed) : false,
          holidayOpenTime: holiday?.open_time ?? '10:00',
          holidayCloseTime: holiday?.close_time ?? '19:00',
        },
        capacity: {
          default: Number(store.max_concurrent) ? Math.min(20, Number(store.max_concurrent)) : null,
          weekdays: [0, 1, 2, 3, 4, 5, 6].map((d) => capacity(hours.get(d))),
          holiday: capacity(holiday),
        },
        seats: { alertEnabled: bool(store.enable_seat_alert), limit: Number(store.seat_limit) || 0 },
      },
    });
    await replaceBusinessHours(
      ctx,
      shopId,
      [0, 1, 2, 3, 4, 5, 6]
        .map((d) => hours.get(d))
        .filter((h): h is SgHours => !!h && !bool(h.is_closed))
        .map((h) => ({ weekday: h.day_of_week, openTime: h.open_time, closeTime: h.close_time })),
    );
  });

  // ------------------------------------------------------------ equipment
  const equipmentType = new Map<string, string>();
  await tx(orgId, async (ctx) => {
    for (const e of [...data.equipment].sort((a, b) => a.sort_order - b.sort_order)) {
      if (!bool(e.is_active)) continue;
      await createEquipment(ctx, { shopId, name: e.name, quantity: Math.min(99, e.quantity) });
      equipmentType.set(e.id, e.name);
    }
  });

  // ------------------------------------------------------------ staff
  const roleKey = { owner: 'owner', manager: 'manager', staff: 'stylist' } as const;
  const staffMap = new Map<string, string>();
  const assignment = new Map(data.staff_store_assignments.map((a) => [a.id, a.stores.find((s) => s.id === data.store_id)]));
  await tx(orgId, async (ctx) => {
    const roles = new Map((await listRoles(ctx)).map((r) => [r.key, r.id]));
    // staff already imported with another shop (SALOGIC staff can work at several shops): found by the
    // SALOGIC id kept in public_profile, or by name for shops imported before that id was kept
    const existing = await ctx.trx.selectFrom('staffs').select(['id', 'display_name', 'public_profile']).where('deleted_at', 'is', null).execute();
    const bySalogicId = new Map(existing.flatMap((e) => { const sid = (e.public_profile as { salogicId?: string } | null)?.salogicId; return sid ? [[sid, e.id] as const] : []; }));
    const byName = new Map(existing.map((e) => [e.display_name, e.id]));
    for (const s of [...data.staff].sort((a, b) => a.sort_order - b.sort_order)) {
      const retired = !!s.retired_at;
      let id: string;
      const known = bySalogicId.get(s.id) ?? (ownerStaffId ? undefined : byName.get(s.name));
      if (known) {
        // add this shop to the staff member; their photo, nickname and login stay as they are
        id = known;
        await ctx.trx
          .insertInto('staff_shop_assignments')
          .values({ organization_id: orgId, staff_id: id, shop_id: shopId, is_primary: false })
          .onConflict((oc) => oc.doNothing())
          .execute();
      } else if (s.role === 'owner' && ownerStaffId && s.id === sgOwner?.id) {
        id = ownerStaffId;
        await updateStaff(ctx, id, { displayName: s.name, sortOrder: s.sort_order, isBookable: true });
      } else {
        id = (
          await createStaff(ctx, {
            displayName: s.name,
            roleId: roles.get(roleKey[s.role] ?? 'stylist')!,
            shopIds: [shopId],
            isBookable: !retired,
            sortOrder: s.sort_order,
          })
        ).staff.id;
        // no login account for real staff: the address is kept for the staff screen only
        await ctx.trx.updateTable('staffs').set({ email: s.email }).where('id', '=', id).execute();
        await updateStaff(ctx, id, {
          status: retired ? 'retired' : bool(s.is_active) ? 'active' : 'inactive',
          ...(retired ? { retiredOn: s.retired_at!.slice(0, 10) } : {}),
        });
      }
      staffMap.set(s.id, id);
      const a = assignment.get(s.id);
      await ctx.trx
        .updateTable('staff_shop_assignments')
        .set({ is_visible_to_customer: a ? bool(a.is_visible_to_customer) : bool(s.is_visible_to_customer) })
        .where('staff_id', '=', id)
        .where('shop_id', '=', shopId)
        .execute();

      if (!known) {
        const photo = await image(`staff-${s.id}`);
        const file = photo ? await createFileRecord(ctx, { purpose: 'staff_photo', contentType: 'image/jpeg', body: photo, fileName: `${s.name}.jpg` }) : null;
        await updateStaffExtras(ctx, id, { nickname: s.nickname || null, ...(file ? { photoFileId: file.id } : {}) });
      }
      // remember the SALOGIC id so the next shop finds this staff member
      await ctx.trx
        .updateTable('staffs')
        .set({ public_profile: sql`coalesce(public_profile, '{}'::jsonb) || ${JSON.stringify({ salogicId: s.id })}::jsonb` })
        .where('id', '=', id)
        .execute();

      const own = data.per_staff[s.id];
      const weekly = (own?.hours.business_hours ?? []).filter((h) => h.day_of_week <= 6);
      if (weekly.length) {
        await replaceStaffBusinessHours(
          ctx,
          id,
          shopId,
          [0, 1, 2, 3, 4, 5, 6].map((d) => {
            const h = weekly.find((w) => w.day_of_week === d);
            return { weekday: d, openTime: h?.open_time ?? '10:00', closeTime: h?.close_time ?? '19:00', isClosed: !h || bool(h.is_closed) };
          }),
        );
      }
      const rs = own?.rs.settings;
      if (rs) {
        await replaceStaffReservationSettings(ctx, id, shopId, {
          advanceBookingDays: Math.min(730, Math.max(1, Number(rs.advance_booking_days) || 60)),
          sameDayCutoffHours: Math.min(24, Number(rs.same_day_cutoff_hours) || 0),
          maxConcurrent: Math.min(10, Math.max(1, Number(rs.max_concurrent) || 1)),
          acceptSameStartTime: bool(rs.accept_same_start_time),
          acceptOutsideHours: bool(rs.accept_outside_hours),
        });
      }
    }
  });

  // ------------------------------------------------------------ categories
  const categoryByName = new Map<string, string>();
  /** SALOGIC menus write 「親 ： 子」 with or without spaces / full-width forms */
  const catKey = (name: string) => name.normalize('NFKC').replace(/\s+/g, '').replace(/:/g, '：');
  await tx(orgId, async (ctx) => {
    const cats = data.categories.categories;
    const byId = new Map<string, string>();
    for (const parent of cats.filter((c) => !c.parent_id)) {
      const row = await createCategory(ctx, { shopId, name: parent.name, sortOrder: parent.sort_order, color: parent.color });
      byId.set(parent.id, row.id);
      categoryByName.set(catKey(parent.name), row.id);
    }
    for (const child of cats.filter((c) => c.parent_id)) {
      const row = await createCategory(ctx, { shopId, name: child.name, sortOrder: child.sort_order, parentId: byId.get(child.parent_id!)! });
      categoryByName.set(catKey(child.name), row.id);
    }
  });

  // ------------------------------------------------------------ menus / coupons
  const missing: string[] = [];
  await tx(orgId, async (ctx) => {
    /** a category a menu names that the shop's category list lacks is created (parent first) */
    const categoryFor = async (name: string): Promise<string | undefined> => {
      const key = catKey(name);
      if (!key) return undefined;
      const hit = categoryByName.get(key);
      if (hit) return hit;
      const [parentName, childName] = key.split('：');
      let parentId = categoryByName.get(parentName!);
      if (!parentId) {
        parentId = (await createCategory(ctx, { shopId, name: parentName!, sortOrder: 900 })).id;
        categoryByName.set(parentName!, parentId);
      }
      if (!childName) return parentId;
      const id = (await createCategory(ctx, { shopId, name: childName, sortOrder: 900, parentId })).id;
      categoryByName.set(key, id);
      return id;
    };
    for (const m of [...data.menus].sort((a, b) => a.sort_order - b.sort_order)) {
      const subNames = typeof m.sub_categories === 'string' ? (JSON.parse(m.sub_categories) as string[]) : (m.sub_categories ?? []);
      const subs: string[] = [];
      for (const n of subNames) {
        const id = await categoryFor(n);
        if (id) subs.push(id);
      }
      const primary = m.category ? await categoryFor(m.category) : undefined;
      if (m.category && !primary) missing.push(`${m.name}: カテゴリ「${m.category}」`);
      const pic = await image(`menu-${m.id}`);
      const file = pic ? await createFileRecord(ctx, { purpose: 'menu_image', contentType: 'image/jpeg', body: pic, fileName: `${m.id}.jpg` }) : null;
      await createMenu(ctx, {
        shopId,
        categoryId: primary ?? subs[0] ?? null,
        subCategoryIds: [...new Set([...(primary ? [primary] : []), ...subs])],
        name: m.name,
        description: m.description || null,
        durationMin: Math.max(5, m.duration),
        price: m.price,
        priceTaxIncluded: true,
        isPublic: bool(m.is_bookable),
        status: bool(m.is_active) ? 'active' : 'inactive',
        sortOrder: m.sort_order,
        menuType: m.menu_type,
        couponType: m.menu_type === 'coupon' ? (m.coupon_type ?? 'all') : null,
        presentationCondition: m.presentation_condition,
        usageCondition: m.usage_condition,
        expiryDate: m.expiry_date ? m.expiry_date.slice(0, 10) : null,
        priceTilde: bool(m.price_tilde),
        imageFileId: file?.id ?? null,
        staffIds: m.assigned_staff_ids.map((s) => staffMap.get(s)).filter((x): x is string => !!x),
        resourceRequirements: [...new Set(m.assigned_equipment_ids.map((e) => equipmentType.get(e)).filter((x): x is string => !!x))].map((resourceType) => ({ resourceType, offsetMin: 0 })),
      });
    }
  });

  const salonboard = await connectSalonBoard(orgId, shopId, data);
  console.log(
    JSON.stringify(
      { organizationId: orgId, shopId, shop: store.name, staff: staffMap.size, categories: categoryByName.size, menus: data.menus.length, equipment: equipmentType.size, salonboard, missing },
      null,
      1,
    ),
  );
}

main()
  .then(() => db.destroy())
  .catch(async (e) => {
    console.error(e);
    await db.destroy();
    process.exit(1);
  });
