/**
 * Bring SALOGIC's upcoming reservations (and the customers they belong to) into Salon OS, and bring
 * them up to date on later runs, until the salon switches over. Shops must have been imported with
 * import-salogic.ts first (staff carry their SALOGIC id).
 *
 *   pnpm --filter @salon/api exec tsx src/scripts/sync-salogic-reservations.ts --file <reservations.json>
 *
 * The file (written from SALOGIC's admin API) is { from, shops: { <slug>: { store_id, reservations[],
 * customers: { <salogic customer id>: customer } } } } and covers every reservation from `from` on.
 *
 * Per reservation:
 *  - new           → created (Hot Pepper ones linked to the shop's mail connector by the SALON BOARD
 *                    booking number, so later change / cancel mails find them; skipped when the mail
 *                    connector already took them in)
 *  - unchanged     → left alone
 *  - changed       → the old copy is withdrawn and a new one created
 *  - cancelled / no longer in SALOGIC → withdrawn
 * "Withdrawn" = cancelled and hidden without events, like undoing a data migration: SALOGIC already
 * told the customer and the media. Created appointments carry sourceDetail.migrated, so no customer
 * message and no SALON BOARD 枠止め request is sent for them (SALOGIC holds those slots already).
 */
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { sql } from 'kysely';
import { normalizeName } from '../lib/normalize.js';
import { systemActor, type Ctx } from '../auth/actor.js';
import { db } from '../db/client.js';
import { withSystem, withTenant } from '../db/tenant.js';
import '../modules/index.js';
import { createMenu } from '../modules/catalog/service.js';
import { ACTIVE_STATUSES, createAppointment } from '../modules/appointments/service.js';
import { createCustomer } from '../modules/customers/service.js';
import { sha256 } from '../lib/crypto.js';
import { addMinutes } from '../lib/time.js';

const ORG_SLUG = 'fein';
const KEY_RESERVATION = 'salogic_reservation';
const KEY_CUSTOMER = 'salogic_customer';

interface SgReservation {
  id: string;
  customer_id: string | null;
  staff_id: string | null;
  start_at: string;
  end_at: string;
  status: 'confirmed' | 'pending' | 'cancelled' | 'completed';
  memo: string | null;
  source: string;
  hotpepper_id: string | null;
  is_nominated: number | boolean;
  menu_name: string | null;
  menus: string | { id: string; name: string; duration: number; price: number }[] | null;
  customer_name: string | null;
  customer_name_kana: string | null;
  customer_phone: string | null;
}
interface SgCustomer {
  id: string;
  master_id: string | null;
  name: string | null;
  name_kana: string | null;
  last_name: string | null;
  first_name: string | null;
  last_name_kana: string | null;
  first_name_kana: string | null;
  phone: string | null;
  email: string | null;
  birthday: string | null;
  gender: string | null;
  occupation: string | null;
  postal_code: string | null;
  address: string | null;
  memo: string | null;
  member_no: string | null;
}
interface ShopExport {
  store_id: string;
  reservations: SgReservation[];
  customers: Record<string, SgCustomer>;
}

const SOURCE: Record<string, string> = { phone: 'phone', 'walk-in': 'walk_in', web: 'web', line: 'line', minimo: 'minimo', hotpepper: 'external' };

const { values: args } = parseArgs({ options: { file: { type: 'string' }, shop: { type: 'string' }, report: { type: 'string' } } });
if (!args.file) {
  console.error('usage: sync-salogic-reservations.ts --file <reservations.json> [--shop <slug>]');
  process.exit(1);
}

const tx = <T>(organizationId: string, fn: (ctx: Ctx) => Promise<T>) =>
  withTenant(organizationId, (trx) => fn({ actor: systemActor(organizationId, 'salogic-sync'), trx, meta: { traceId: 'salogic-sync' } }));

const split = (full: string | null) => {
  const parts = (full ?? '').trim().split(/[\s\u3000]+/).filter(Boolean);
  return [parts[0] ?? '', parts.slice(1).join(' ')] as const;
};
const menuEntries = (r: SgReservation): { name: string; duration: number | null; price: number | null }[] => {
  const list = typeof r.menus === 'string' ? (JSON.parse(r.menus) as { name: string; duration?: number; price?: number }[]) : (r.menus ?? []);
  const entries = list.filter((m) => m.name).map((m) => ({ name: m.name, duration: m.duration ?? null, price: m.price ?? null }));
  return entries.length ? entries : r.menu_name ? [{ name: r.menu_name, duration: null, price: null }] : [];
};
const menusOf = (r: SgReservation) => menuEntries(r).map((m) => m.name);
const GENDER: Record<string, 'female' | 'male' | 'other'> = { female: 'female', male: 'male', other: 'other', 女性: 'female', 男性: 'male' };

/** what the Salon OS copy must look like; a different fingerprint = the reservation changed */
function fingerprint(r: SgReservation) {
  return sha256(JSON.stringify([r.start_at, r.end_at, r.staff_id, r.customer_id, menusOf(r), r.status === 'pending', r.memo ?? '']));
}

async function withdraw(ctx: Ctx, appointmentId: string, reason: string) {
  const now = new Date();
  await ctx.trx
    .updateTable('appointments')
    .set({ status: 'cancelled', cancelled_at: now, cancelled_by_type: 'system', cancel_reason: reason, deleted_at: now })
    .where('id', '=', appointmentId)
    .where('deleted_at', 'is', null)
    .execute();
}

async function main() {
  const data = JSON.parse(await readFile(args.file!, 'utf8')) as { from: string; shops: Record<string, ShopExport> };
  const org = await withSystem((trx) => trx.selectFrom('organizations').select('id').where('slug', '=', ORG_SLUG).executeTakeFirst());
  if (!org) throw new Error(`organization ${ORG_SLUG} not found (import the shops first)`);
  const orgId = org.id;
  const from = new Date(`${data.from}T00:00:00+09:00`);
  const report: Record<string, Record<string, number>> = {};
  const problems: string[] = [];

  for (const [slug, shopData] of Object.entries(data.shops)) {
    if (args.shop && args.shop !== slug) continue;
    const r: Record<string, number> = { created: 0, linkedToMail: 0, unchanged: 0, changed: 0, withdrawn: 0, failed: 0, customersCreated: 0 };
    report[slug] = r;

    const shop = await tx(orgId, (ctx) => ctx.trx.selectFrom('shops').select(['id', 'name']).where('slug', '=', `fein-${slug}`).executeTakeFirst());
    if (!shop) {
      problems.push(`${slug}: 店舗 fein-${slug} がありません（先に import-salogic.ts で取り込み）`);
      continue;
    }
    const ref = await tx(orgId, async (ctx) => {
      const staff = await ctx.trx
        .selectFrom('staffs')
        .select(['id', 'display_name', sql<string>`public_profile->>'salogicId'`.as('sid')])
        .where(sql`public_profile->>'salogicId'`, 'is not', null)
        .where('deleted_at', 'is', null)
        .execute();
      const menus = await ctx.trx.selectFrom('menus').select(['id', 'name']).where('shop_id', '=', shop.id).where('deleted_at', 'is', null).orderBy('sort_order').execute();
      const hpb = await ctx.trx.selectFrom('integration_accounts').select('id').where('shop_id', '=', shop.id).where('provider', '=', 'hotpepper_mail').executeTakeFirst();
      const minimo = await ctx.trx.selectFrom('integration_accounts').select('id').where('shop_id', '=', shop.id).where('provider', '=', 'minimo_mail').executeTakeFirst();
      const keys = await ctx.trx.selectFrom('import_keys').select(['key', 'resource_id']).where('kind', '=', KEY_RESERVATION).execute();
      const shopStaff = await ctx.trx.selectFrom('staff_shop_assignments').select('staff_id').where('shop_id', '=', shop.id).where('ended_on', 'is', null).execute();
      return {
        staff: new Map(staff.map((s) => [s.sid, s.id])),
        staffNames: new Map(staff.map((s) => [s.id, s.display_name])),
        menus: menus.reduce((m, x) => (m.has(x.name) ? m : m.set(x.name, x.id)), new Map<string, string>()),
        hpbId: hpb?.id ?? null,
        minimoId: minimo?.id ?? null,
        keys: new Map(keys.map((k) => [k.key, k.resource_id])),
        shopStaffIds: shopStaff.map((x) => x.staff_id),
      };
    });

    // menus SALOGIC no longer lists (withdrawn, or named by SALON BOARD) are created first, in their own
    // transaction: hidden from online booking, with the reservation's duration and price, open to the
    // shop's staff
    await tx(orgId, async (ctx) => {
      for (const res of shopData.reservations) {
        if (res.status === 'cancelled' || new Date(res.start_at) < from) continue;
        const entries = menuEntries(res);
        for (const m of entries) {
          if (ref.menus.has(m.name)) continue;
          const total = Math.round((new Date(res.end_at).getTime() - new Date(res.start_at).getTime()) / 60000);
          const created = await createMenu(ctx, {
            shopId: shop.id,
            name: m.name.slice(0, 100),
            durationMin: Math.min(720, Math.max(5, m.duration ?? (entries.length === 1 ? total : 30))),
            price: Math.max(0, m.price ?? 0),
            priceTaxIncluded: true,
            isPublic: false,
            sortOrder: 9999,
            staffIds: ref.shopStaffIds,
          });
          ref.menus.set(m.name, created.id);
          r.legacyMenus = (r.legacyMenus ?? 0) + 1;
        }
      }
    });

    console.error(`== ${shop.name}: ${shopData.reservations.length}件を確認します`);
    const seen = new Set<string>();
    for (const res of shopData.reservations) {
      if (new Date(res.start_at) < from) continue;
      const key = `${shopData.store_id}:${res.id}`;
      seen.add(key);
      if (seen.size % 100 === 0) console.error(`   ${seen.size}件…`);
      const fp = fingerprint(res);
      const pending = { customersCreated: 0 };
      try {
        await tx(orgId, async (ctx) => {
          const existingId = ref.keys.get(key);
          const existing = existingId
            ? await ctx.trx.selectFrom('appointments').select(['id', 'source_detail', 'deleted_at']).where('id', '=', existingId).executeTakeFirst()
            : undefined;
          const live = existing && !existing.deleted_at ? existing : undefined;

          if (res.status === 'cancelled' || res.status === 'completed') {
            if (live && res.status === 'cancelled') {
              await withdraw(ctx, live.id, 'SALOGIC でキャンセル');
              r.withdrawn!++;
            }
            return;
          }
          const detail = (live?.source_detail ?? {}) as { salogicFingerprint?: string; migrated?: boolean };
          // a media booking staff typed into SALOGIC by hand (minimo, often filed as 電話), which the
          // mail connector took in under a customer record of its own: keep the mail's booking, drop the copy.
          // Same stylist and start, and either the minimo route or the same customer name.
          const staffHere = res.staff_id ? ref.staff.get(res.staff_id) : undefined;
          const mediaIds = [ref.minimoId, ref.hpbId].filter((x): x is string => !!x);
          if (staffHere && mediaIds.length && !(live && !detail.migrated)) {
            const viaMail = await ctx.trx
              .selectFrom('external_bookings as eb')
              .innerJoin('appointments as a', 'a.id', 'eb.appointment_id')
              .leftJoin('customers as cu', 'cu.id', 'a.customer_id')
              .select(['a.id', 'eb.integration_account_id', 'cu.last_name', 'cu.first_name', 'cu.last_name_kana', 'cu.first_name_kana'])
              .where('eb.integration_account_id', 'in', mediaIds)
              .where('a.staff_id', '=', staffHere)
              .where('a.start_at', '=', new Date(res.start_at))
              .where('a.status', 'in', [...ACTIVE_STATUSES])
              .where('a.deleted_at', 'is', null)
              .execute();
            const want = [normalizeName(res.customer_name ?? ''), normalizeName(res.customer_name_kana ?? '')].filter((x) => x.length >= 2);
            const minimoRoute = res.source === 'minimo' || (res as { salonboard_route?: string }).salonboard_route === 'minimo';
            const same = viaMail.find(
              (v) =>
                (minimoRoute && v.integration_account_id === ref.minimoId) ||
                [normalizeName(`${v.last_name ?? ''}${v.first_name ?? ''}`), normalizeName(`${v.last_name_kana ?? ''}${v.first_name_kana ?? ''}`)].some((n) => n.length >= 2 && want.includes(n)),
            );
            if (same) {
              if (live && live.id !== same.id) await withdraw(ctx, live.id, '媒体のメールで取り込んだ予約と同じ');
              await saveKey(ctx, key, same.id);
              r.linkedToMail!++;
              return;
            }
          }
          // a booking the Hot Pepper mail connector created is kept up to date by the media's mails
          if (live && (!detail.migrated || detail.salogicFingerprint === fp)) {
            r.unchanged!++;
            return;
          }

          // Hot Pepper booking the mail connector already took in: keep that one, remember the link
          if (!live && res.source === 'hotpepper' && res.hotpepper_id && ref.hpbId) {
            const viaMail = await ctx.trx
              .selectFrom('external_bookings')
              .select('appointment_id')
              .where('integration_account_id', '=', ref.hpbId)
              .where('external_booking_id', '=', res.hotpepper_id)
              .where('appointment_id', 'is not', null)
              .executeTakeFirst();
            if (viaMail?.appointment_id) {
              await saveKey(ctx, key, viaMail.appointment_id);
              r.linkedToMail!++;
              return;
            }
          }

          const entries = menuEntries(res);
          if (!entries.length) throw new Error('メニューがありません');
          const menuIds = [...new Set(entries.map((m) => ref.menus.get(m.name)).filter((x): x is string => !!x))];
          if (menuIds.length !== new Set(entries.map((m) => m.name)).size) throw new Error(`メニュー「${menusOf(res).join('・')}」が見つかりません`);
          const customerId = res.customer_id ? await customerFor(ctx, shop.id, res, shopData.customers[res.customer_id], pending) : null;
          const staffId = res.staff_id ? (ref.staff.get(res.staff_id) ?? null) : null;
          const source = SOURCE[res.source] ?? 'staff';
          const hpb = source === 'external' && res.hotpepper_id && ref.hpbId ? { integrationAccountId: ref.hpbId, provider: 'hotpepper_mail', externalBookingId: res.hotpepper_id } : {};

          if (live) {
            await withdraw(ctx, live.id, 'SALOGIC で変更（新しい内容に置き換え）');
            if (hpb.externalBookingId) await ctx.trx.updateTable('external_bookings').set({ appointment_id: null }).where('appointment_id', '=', live.id).execute();
          }
          // SALOGIC let this staff member take the menu although the menu's 対応スタッフ does not list
          // them: allow it for this booking only (the capability is removed again in the same transaction)
          const tempCaps: string[] = [];
          if (staffId) {
            const caps = await ctx.trx.selectFrom('staff_menus').select('menu_id').where('staff_id', '=', staffId).execute();
            if (caps.length) {
              for (const m of menuIds.filter((id) => !caps.some((c) => c.menu_id === id))) {
                await ctx.trx.insertInto('staff_menus').values({ staff_id: staffId, menu_id: m, organization_id: orgId }).execute();
                tempCaps.push(m);
              }
            }
          }
          const appt = await createAppointment(
            ctx,
            {
              shopId: shop.id,
              customerId,
              staffId,
              isNominated: !!res.is_nominated && !!staffId,
              startAt: new Date(res.start_at).toISOString(),
              menuIds,
              source: source as never,
              sourceDetail: { migrated: true, salogicId: res.id, salogicFingerprint: fp, ...hpb },
              staffNote: res.memo || null,
              status: res.status === 'pending' ? 'tentative' : 'confirmed',
              allowOutsideSchedule: true,
            },
            { trusted: true },
          );
          if (tempCaps.length) await ctx.trx.deleteFrom('staff_menus').where('staff_id', '=', staffId!).where('menu_id', 'in', tempCaps).execute();
          // SALOGIC's own end time (treatments often run longer than the menus' total)
          const end = new Date(res.end_at);
          const curEnd = new Date(appt.end_at);
          if (end.getTime() !== curEnd.getTime() && end > new Date(res.start_at)) {
            const diff = Math.round((end.getTime() - curEnd.getTime()) / 60000);
            await ctx.trx
              .updateTable('appointments')
              .set({ end_at: end, occupied_end_at: addMinutes(new Date(appt.occupied_end_at), diff) })
              .where('id', '=', appt.id)
              .execute();
          }
          if (hpb.externalBookingId) {
            const normalized = { externalId: res.hotpepper_id, status: 'booked', start: res.start_at, end: res.end_at, staffExternalId: null, menuExternalIds: menusOf(res) };
            await ctx.trx
              .insertInto('external_bookings')
              .values({
                organization_id: orgId,
                integration_account_id: ref.hpbId!,
                provider: 'hotpepper_mail',
                external_booking_id: res.hotpepper_id!,
                appointment_id: appt.id,
                external_status: 'booked',
                raw_payload: JSON.stringify({ source: 'salogic', reservationId: res.id }),
                normalized: JSON.stringify(normalized),
                payload_hash: sha256(JSON.stringify(normalized)),
                sync_state: 'synced',
                last_synced_at: new Date(),
              })
              .onConflict((oc) => oc.columns(['integration_account_id', 'external_booking_id']).doUpdateSet({ appointment_id: appt.id, sync_state: 'synced', last_synced_at: new Date() }))
              .execute();
          }
          await saveKey(ctx, key, appt.id);
          if (live) r.changed!++;
          else r.created!++;
        });
        r.customersCreated! += pending.customersCreated; // only once the reservation was committed
      } catch (e) {
        r.failed!++;
        const when = new Date(res.start_at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
        const staffName = res.staff_id ? (ref.staffNames.get(ref.staff.get(res.staff_id) ?? '') ?? '（店舗外のスタッフ）') : 'フリー';
        problems.push(`${shop.name} ${when} ${staffName}「${menusOf(res).join('・')}」: ${(e as Error).message}`);
      }
    }

    // reservations that disappeared from SALOGIC (deleted) within the exported range
    await tx(orgId, async (ctx) => {
      for (const [key, apptId] of ref.keys) {
        if (!key.startsWith(`${shopData.store_id}:`) || seen.has(key)) continue;
        const a = await ctx.trx.selectFrom('appointments').select(['start_at', 'deleted_at']).where('id', '=', apptId).executeTakeFirst();
        if (!a || a.deleted_at || a.start_at < from) continue;
        await withdraw(ctx, apptId, 'SALOGIC から削除');
        r.withdrawn!++;
      }
    });
  }
  const result = { from: data.from, shops: report, problems, problemCount: problems.length };
  if (args.report) await writeFile(args.report, JSON.stringify(result, null, 1));
  else console.log(JSON.stringify({ ...result, problems: problems.slice(0, 200) }, null, 1));
}

async function saveKey(ctx: Ctx, key: string, resourceId: string) {
  await ctx.trx
    .insertInto('import_keys')
    .values({ organization_id: ctx.actor.organizationId, kind: KEY_RESERVATION, key, resource_id: resourceId })
    .onConflict((oc) => oc.columns(['organization_id', 'kind', 'key']).doUpdateSet({ resource_id: resourceId }))
    .execute();
}

/** the Salon OS customer for a SALOGIC customer (one per SALOGIC master record across shops) */
async function customerFor(ctx: Ctx, shopId: string, res: SgReservation, c: SgCustomer | undefined, r: { customersCreated: number }): Promise<string> {
  const key = c?.master_id || c?.id || res.customer_id!;
  const hit = await ctx.trx.selectFrom('import_keys').select('resource_id').where('kind', '=', KEY_CUSTOMER).where('key', '=', key).executeTakeFirst();
  if (hit) {
    const alive = await ctx.trx.selectFrom('customers').select(['id', 'status', 'merged_into_id']).where('id', '=', hit.resource_id).where('deleted_at', 'is', null).executeTakeFirst();
    if (alive) return alive.status === 'merged' && alive.merged_into_id ? alive.merged_into_id : alive.id;
  }
  const [ln, fn] = c?.last_name || c?.first_name ? [c.last_name ?? '', c.first_name ?? ''] : split(c?.name ?? res.customer_name);
  const [lk, fk] = c?.last_name_kana || c?.first_name_kana ? [c.last_name_kana ?? '', c.first_name_kana ?? ''] : split(c?.name_kana ?? res.customer_name_kana);
  const birthday = c?.birthday && /^\d{4}-\d{2}-\d{2}/.test(c.birthday) ? c.birthday.slice(0, 10) : null;
  const email = c?.email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(c.email) ? c.email : null;
  const created = await createCustomer(ctx, {
    lastName: ln || (lk ? '' : 'お客様'),
    firstName: fn,
    lastNameKana: lk,
    firstNameKana: fk,
    phone: c?.phone ?? res.customer_phone ?? null,
    email,
    birthday,
    gender: c?.gender ? (GENDER[c.gender] ?? null) : null,
    occupation: c?.occupation ?? null,
    postalCode: c?.postal_code ?? null,
    address: c?.address ?? null,
    memo: c?.memo ?? null,
    primaryShopId: shopId,
  });
  const id = created.customer.id;
  if (c?.member_no) await ctx.trx.updateTable('customers').set({ member_no: c.member_no }).where('id', '=', id).execute();
  await ctx.trx
    .insertInto('import_keys')
    .values({ organization_id: ctx.actor.organizationId, kind: KEY_CUSTOMER, key, resource_id: id })
    .onConflict((oc) => oc.columns(['organization_id', 'kind', 'key']).doUpdateSet({ resource_id: id }))
    .execute();
  r.customersCreated++;
  return id;
}

main()
  .then(() => db.destroy())
  .catch(async (e) => {
    console.error(e);
    await db.destroy();
    process.exit(1);
  });
