/**
 * Development seed (pnpm --filter @salon/api db:seed).
 *
 * Creates the demo organization "Salon Demo" (slug: demo) with 2 shops, staff, menus, resources,
 * coupons, ~40 customers and appointments (past 3 months completed / upcoming 2 weeks).
 * Uses the domain services (signup / createStaff / createMenu / createCustomer / createAppointment ...)
 * so every invariant (exclusion constraints, stats, audit, events) is respected.
 *
 * Idempotent-ish: if owner@example.com already exists the seed prints the credentials and exits.
 * To re-seed, recreate the database (never run against a shared DB you do not own).
 */
import { sql } from 'kysely';
import { systemActor, type Ctx } from '../auth/actor.js';
import { config } from '../config.js';
import { addMinutes, localDate, zonedDateTime } from '../lib/time.js';
import '../modules/index.js'; // register org seeders / event subscribers (same as server)
import { createAppointment, transitionAppointment } from '../modules/appointments/service.js';
import {
  createCategory,
  createCoupon,
  createMenu,
  createResource,
  setMenuOverride,
} from '../modules/catalog/service.js';
import { createCustomer, createTag } from '../modules/customers/service.js';
import { recomputeCustomerStats } from '../modules/customers/stats.js';
import { rebuildDay } from '../modules/analytics/aggregate.js';
import { scoreOrganization } from '../modules/ai/scoring.js';
import {
  createShop,
  createStaff,
  listRoles,
  signup,
  updateShop,
  updateStaff,
} from '../modules/org/service.js';
import { replaceWeeklySchedule, upsertShifts } from '../modules/schedules/service.js';
import { db } from './client.js';
import { withSystem, withTenant } from './tenant.js';

const PASSWORD = 'password-1234';
const TZ = 'Asia/Tokyo';

// ------------------------------------------------------------ deterministic PRNG
let seedState = 20261001;
function rand(): number {
  seedState |= 0;
  seedState = (seedState + 0x6d2b79f5) | 0;
  let t = Math.imul(seedState ^ (seedState >>> 15), 1 | seedState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]!;
const chance = (p: number) => rand() < p;
const int = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));

function tx<T>(organizationId: string, fn: (ctx: Ctx) => Promise<T>): Promise<T> {
  return withTenant(organizationId, (trx) =>
    fn({ actor: systemActor(organizationId, 'seed'), trx, meta: { traceId: 'seed' } }),
  );
}

function jstToday(offsetDays = 0): string {
  return localDate(new Date(Date.now() + offsetDays * 86_400_000), TZ);
}

function weekdayOf(date: string): number {
  return new Date(`${date}T12:00:00+09:00`).getUTCDay();
}

// ------------------------------------------------------------ master data
const LAST_NAMES: [string, string][] = [
  ['佐藤', 'サトウ'],
  ['鈴木', 'スズキ'],
  ['高橋', 'タカハシ'],
  ['田中', 'タナカ'],
  ['伊藤', 'イトウ'],
  ['渡辺', 'ワタナベ'],
  ['山本', 'ヤマモト'],
  ['中村', 'ナカムラ'],
  ['小林', 'コバヤシ'],
  ['加藤', 'カトウ'],
  ['吉田', 'ヨシダ'],
  ['山田', 'ヤマダ'],
  ['松本', 'マツモト'],
  ['井上', 'イノウエ'],
  ['木村', 'キムラ'],
  ['林', 'ハヤシ'],
  ['清水', 'シミズ'],
  ['森', 'モリ'],
  ['池田', 'イケダ'],
  ['橋本', 'ハシモト'],
];
const FEMALE: [string, string][] = [
  ['花子', 'ハナコ'],
  ['美咲', 'ミサキ'],
  ['陽菜', 'ヒナ'],
  ['結衣', 'ユイ'],
  ['さくら', 'サクラ'],
  ['葵', 'アオイ'],
  ['真央', 'マオ'],
  ['優子', 'ユウコ'],
  ['彩', 'アヤ'],
  ['七海', 'ナナミ'],
  ['里奈', 'リナ'],
  ['舞', 'マイ'],
];
const MALE: [string, string][] = [
  ['翔太', 'ショウタ'],
  ['大輔', 'ダイスケ'],
  ['蓮', 'レン'],
  ['拓海', 'タクミ'],
  ['悠斗', 'ユウト'],
  ['健一', 'ケンイチ'],
];

async function main() {
  const existing = await withSystem((trx) =>
    trx
      .selectFrom('users')
      .select('id')
      .where('email', '=', 'owner@example.com')
      .executeTakeFirst(),
  );
  if (existing) {
    console.log('Seed data already exists (owner@example.com). Skipping.');
    printCredentials();
    return;
  }

  console.log(`Seeding ${config.DATABASE_URL.replace(/:[^:@/]+@/, ':***@')} ...`);
  const created = await signup({
    organizationName: 'Salon Demo',
    organizationSlug: 'demo',
    shopName: 'Salon Demo 渋谷',
    shopSlug: 'shibuya',
    ownerName: '山田 恵',
    email: 'owner@example.com',
    password: PASSWORD,
    phone: '03-1234-5678',
  });
  const orgId = created.organizationId;
  const shibuya = created.shopId;

  // ---------------------------------------------------------------- shops
  const omotesando = await tx(orgId, async (ctx) => {
    await updateShop(ctx, shibuya, {
      postalCode: '150-0002',
      prefecture: '東京都',
      city: '渋谷区渋谷',
      addressLine: '2-1-1 サロンビル3F',
      email: 'shibuya@example.com',
      description: '渋谷駅から徒歩3分。髪質改善とデザインカラーが得意なヘアサロンです。',
      publicBookingEnabled: true,
    });
    await invoiceNumber(ctx);
    const shop = await createShop(ctx, {
      name: 'Salon Demo 表参道',
      slug: 'omotesando',
      phone: '03-9876-5432',
      email: 'omotesando@example.com',
      postalCode: '150-0001',
      prefecture: '東京都',
      city: '渋谷区神宮前',
      addressLine: '4-2-2 グリーンテラス2F',
      description: '表参道の落ち着いた空間で、ヘッドスパと上質なカットを。',
    });
    return shop.id;
  });

  // ---------------------------------------------------------------- staff
  const staff = await tx(orgId, async (ctx) => {
    const roles = new Map((await listRoles(ctx)).map((r) => [r.key, r.id]));
    await updateStaff(ctx, created.staffId, {
      isBookable: false,
      color: '#475569',
      title: 'オーナー',
    });
    const mk = async (input: Parameters<typeof createStaff>[1]) =>
      (await createStaff(ctx, input)).staff.id;
    const manager = await mk({
      displayName: '佐藤 美咲',
      displayNameKana: 'サトウ ミサキ',
      email: 'manager@example.com',
      initialPassword: PASSWORD,
      roleId: roles.get('manager')!,
      shopIds: [shibuya],
      title: '店長 / トップスタイリスト',
      color: '#0d9488',
      nominationFee: 1100,
      isBookable: true,
      sortOrder: 1,
      publicSlug: 'misaki',
      publicProfile: {
        bio: '髪質改善とショートスタイルが得意です。骨格に合わせた再現性の高いカットを提案します。',
        specialties: ['髪質改善', 'ショート', 'ボブ'],
        yearsOfExperience: 12,
      },
    });
    const suzuki = await mk({
      displayName: '鈴木 健太',
      displayNameKana: 'スズキ ケンタ',
      email: 'stylist1@example.com',
      initialPassword: PASSWORD,
      roleId: roles.get('stylist')!,
      shopIds: [shibuya],
      title: 'スタイリスト',
      color: '#2563eb',
      nominationFee: 550,
      sortOrder: 2,
      publicSlug: 'kenta',
      publicProfile: {
        bio: 'メンズカット・パーマならお任せください。',
        specialties: ['メンズ', 'パーマ'],
        yearsOfExperience: 7,
      },
    });
    const takahashi = await mk({
      displayName: '高橋 あおい',
      displayNameKana: 'タカハシ アオイ',
      email: 'stylist2@example.com',
      initialPassword: PASSWORD,
      roleId: roles.get('stylist')!,
      shopIds: [shibuya],
      title: 'カラーリスト',
      color: '#db2777',
      nominationFee: 550,
      sortOrder: 3,
      publicSlug: 'aoi',
      publicProfile: {
        bio: '透明感カラー・ハイライトが得意。ブリーチなしでも柔らかい色味をつくります。',
        specialties: ['カラー', 'ハイライト'],
        yearsOfExperience: 5,
      },
    });
    const ito = await mk({
      displayName: '伊藤 蓮',
      displayNameKana: 'イトウ レン',
      email: 'stylist3@example.com',
      initialPassword: PASSWORD,
      roleId: roles.get('stylist')!,
      shopIds: [omotesando],
      title: 'スタイリスト / スパニスト',
      color: '#d97706',
      nominationFee: 0,
      sortOrder: 4,
      publicSlug: 'ren',
      publicProfile: {
        bio: 'ヘッドスパで日頃の疲れを癒やします。',
        specialties: ['ヘッドスパ', 'カット'],
        yearsOfExperience: 4,
      },
    });
    const reception = await mk({
      displayName: '田中 由美',
      displayNameKana: 'タナカ ユミ',
      email: 'reception@example.com',
      initialPassword: PASSWORD,
      roleId: roles.get('reception')!,
      shopIds: [shibuya, omotesando],
      title: '受付',
      color: '#64748b',
      isBookable: false,
      sortOrder: 9,
    });
    // weekly patterns (days without a row = off)
    const days = (exclude: number[]) => [0, 1, 2, 3, 4, 5, 6].filter((d) => !exclude.includes(d));
    await replaceWeeklySchedule(
      ctx,
      manager,
      shibuya,
      days([2, 1]).map((weekday) => ({ weekday, startTime: '10:00', endTime: '19:00' })),
    );
    await replaceWeeklySchedule(
      ctx,
      suzuki,
      shibuya,
      days([2, 3]).map((weekday) => ({ weekday, startTime: '10:00', endTime: '20:00' })),
    );
    await replaceWeeklySchedule(
      ctx,
      takahashi,
      shibuya,
      days([2, 5]).map((weekday) => ({ weekday, startTime: '11:00', endTime: '20:00' })),
    );
    await replaceWeeklySchedule(
      ctx,
      ito,
      omotesando,
      days([2]).map((weekday) => ({ weekday, startTime: '10:00', endTime: '20:00' })),
    );
    return { manager, suzuki, takahashi, ito, reception };
  });

  // a couple of date-specific shift overrides this week (hope day off / short day)
  await tx(orgId, (ctx) =>
    upsertShifts(ctx, shibuya, [
      { staffId: staff.suzuki, date: jstToday(4), shiftType: 'off', note: '希望休' },
      {
        staffId: staff.takahashi,
        date: jstToday(2),
        shiftType: 'work',
        startTime: '13:00',
        endTime: '20:00',
        note: '午後出勤',
      },
    ]),
  );

  // ---------------------------------------------------------------- catalog
  const menus = await tx(orgId, async (ctx) => {
    const cat = async (name: string, sortOrder: number) =>
      (await createCategory(ctx, { name, sortOrder })).id;
    const cCut = await cat('カット', 1);
    const cColor = await cat('カラー', 2);
    const cPerm = await cat('パーマ', 3);
    const cTreat = await cat('トリートメント', 4);
    const cSpa = await cat('ヘッドスパ', 5);
    const cOther = await cat('ご相談', 6);

    for (const shopId of [shibuya, omotesando]) {
      await createResource(ctx, {
        shopId,
        name: 'スパベッド1',
        resourceType: 'spa_bed',
        sortOrder: 1,
      });
      await createResource(ctx, {
        shopId,
        name: 'シャンプー台1',
        resourceType: 'shampoo',
        sortOrder: 2,
      });
      await createResource(ctx, {
        shopId,
        name: 'シャンプー台2',
        resourceType: 'shampoo',
        sortOrder: 3,
      });
    }
    await createResource(ctx, {
      shopId: shibuya,
      name: 'スパベッド2',
      resourceType: 'spa_bed',
      sortOrder: 4,
    });

    const m = async (input: Parameters<typeof createMenu>[1]) => (await createMenu(ctx, input)).id;
    const cut = await m({
      categoryId: cCut,
      name: 'カット',
      description: 'シャンプー・ブロー込み',
      durationMin: 60,
      price: 6600,
      sortOrder: 1,
    });
    const bangs = await m({
      categoryId: cCut,
      name: '前髪カット',
      durationMin: 15,
      price: 1100,
      sortOrder: 2,
    });
    const cutColor = await m({
      categoryId: cColor,
      name: 'カット＋カラー',
      description: '根元〜毛先のフルカラー',
      durationMin: 120,
      price: 14300,
      sortOrder: 1,
    });
    const retouch = await m({
      categoryId: cColor,
      name: 'リタッチカラー',
      description: '根元3cmまで',
      durationMin: 90,
      price: 8800,
      sortOrder: 2,
    });
    const highlight = await m({
      categoryId: cColor,
      name: 'ハイライトカラー',
      durationMin: 150,
      bufferAfterMin: 15,
      price: 17600,
      sortOrder: 3,
    });
    const perm = await m({
      categoryId: cPerm,
      name: 'カット＋デジタルパーマ',
      durationMin: 150,
      bufferAfterMin: 15,
      price: 17600,
      sortOrder: 1,
    });
    const treat = await m({
      categoryId: cTreat,
      name: '髪質改善トリートメント',
      description: '酸熱トリートメントでうねりとダメージをケア',
      durationMin: 60,
      price: 8800,
      sortOrder: 1,
    });
    const quickTreat = await m({
      categoryId: cTreat,
      name: 'クイックトリートメント',
      durationMin: 20,
      price: 2200,
      sortOrder: 2,
    });
    const spa = await m({
      categoryId: cSpa,
      name: '炭酸ヘッドスパ',
      description: '専用ベッドでリラックス（30分）',
      durationMin: 30,
      price: 4400,
      sortOrder: 1,
      resourceRequirements: [{ resourceType: 'spa_bed', offsetMin: 0 }],
    });
    const spaLong = await m({
      categoryId: cSpa,
      name: '極上ヘッドスパ 60分',
      durationMin: 60,
      price: 7700,
      sortOrder: 2,
      resourceRequirements: [{ resourceType: 'spa_bed', offsetMin: 0 }],
    });
    const consult = await m({
      categoryId: cOther,
      name: '初回カウンセリング（相談予約）',
      description: '施術前のご相談のみ。料金はかかりません。',
      durationMin: 30,
      price: 0,
      isConsultation: true,
      sortOrder: 1,
    });
    const mensCut = await m({
      shopId: omotesando,
      categoryId: cCut,
      name: '【表参道限定】メンズカット',
      durationMin: 45,
      price: 5500,
      sortOrder: 3,
    });
    // per-shop override: 表参道のカットは価格を上書き
    await setMenuOverride(ctx, cut, omotesando, { price: 7700 });

    await createCoupon(ctx, {
      name: '【新規】全メニュー20%OFF',
      description: '初回ご来店の方限定',
      discountType: 'percent',
      discountValue: 20,
      newCustomerOnly: true,
      perCustomerLimit: 1,
    });
    await createCoupon(ctx, {
      name: 'カラーメニュー ¥1,000 OFF',
      discountType: 'amount',
      discountValue: 1000,
      applicableMenuIds: [cutColor, retouch, highlight],
      minAmount: 5000,
    });
    await createCoupon(ctx, {
      shopId: omotesando,
      name: '表参道店 ヘッドスパ ¥500 OFF',
      discountType: 'amount',
      discountValue: 500,
      applicableMenuIds: [spa, spaLong],
    });

    return {
      cut,
      bangs,
      cutColor,
      retouch,
      highlight,
      perm,
      treat,
      quickTreat,
      spa,
      spaLong,
      consult,
      mensCut,
    };
  });

  // ---------------------------------------------------------------- customers
  const tagIds = await tx(orgId, async (ctx) => {
    const t = async (name: string, color: string) => (await createTag(ctx, { name, color })).id;
    return {
      vip: await t('VIP', '#b45309'),
      student: await t('学生', '#2563eb'),
      sensitive: await t('敏感肌', '#db2777'),
      straight: await t('縮毛矯正歴あり', '#7c3aed'),
      line: await t('LINE友だち', '#16a34a'),
      introduced: await t('紹介', '#0891b2'),
    };
  });

  type Cust = { id: string; shopId: string; female: boolean };
  const customers: Cust[] = [];
  const usedPhones = new Set<string>();
  await tx(orgId, async (ctx) => {
    for (let i = 0; i < 40; i++) {
      const female = chance(0.72);
      const [ln, lnk] = pick(LAST_NAMES);
      const [fn, fnk] = female ? pick(FEMALE) : pick(MALE);
      const nextPhone = () => `090-${String(int(1000, 9999))}-${String(int(1000, 9999))}`;
      let phone = nextPhone();
      while (usedPhones.has(phone)) phone = nextPhone();
      usedPhones.add(phone);
      const year = int(1970, 2005);
      const birthday = chance(0.85)
        ? `${year}-${String(int(1, 12)).padStart(2, '0')}-${String(int(1, 28)).padStart(2, '0')}`
        : null;
      const shopId = chance(0.7) ? shibuya : omotesando;
      const tags: string[] = [];
      if (chance(0.15)) tags.push(tagIds.vip);
      if (year >= 2003 && chance(0.6)) tags.push(tagIds.student);
      if (chance(0.15)) tags.push(tagIds.sensitive);
      if (female && chance(0.2)) tags.push(tagIds.straight);
      if (chance(0.5)) tags.push(tagIds.line);
      if (chance(0.1)) tags.push(tagIds.introduced);
      const res = await createCustomer(ctx, {
        lastName: ln,
        firstName: fn,
        lastNameKana: lnk,
        firstNameKana: fnk,
        gender: female ? 'female' : 'male',
        birthday,
        phone,
        email: chance(0.6) ? `customer${i + 1}@example.com` : null,
        primaryShopId: shopId,
        acquisitionSource: pick(['web', 'line', 'walk_in', 'referral', 'instagram']),
        marketingOptIn: chance(0.85),
        tagIds: tags,
      });
      customers.push({ id: res.customer.id, shopId, female });
    }
    // intentional duplicates for the 名寄せ screen (same phone / similar kana + birthday)
    await createCustomer(ctx, {
      lastName: '佐々木',
      firstName: '花子',
      lastNameKana: 'ササキ',
      firstNameKana: 'ハナコ',
      phone: '080-1111-2222',
      birthday: '1990-04-12',
      primaryShopId: shibuya,
      gender: 'female',
    });
    await createCustomer(ctx, {
      lastName: '',
      firstName: '',
      lastNameKana: 'ササキ',
      firstNameKana: 'ハナコ',
      phone: '08011112222',
      primaryShopId: shibuya,
      acquisitionSource: 'phone',
    });
    await createCustomer(ctx, {
      lastName: '斉藤',
      firstName: '優',
      lastNameKana: 'サイトウ',
      firstNameKana: 'ユウ',
      birthday: '1988-11-03',
      email: 'yu.saito@example.com',
      primaryShopId: omotesando,
      gender: 'female',
    });
    await createCustomer(ctx, {
      lastName: '斎藤',
      firstName: '優',
      lastNameKana: 'サイトウ',
      firstNameKana: 'ユウ',
      birthday: '1988-11-03',
      primaryShopId: omotesando,
      gender: 'female',
    });
  });

  // ---------------------------------------------------------------- appointments
  const shopStaff: Record<string, string[]> = {
    [shibuya]: [staff.manager, staff.suzuki, staff.takahashi],
    [omotesando]: [staff.ito],
  };
  const menuSets: { ids: string[]; shops?: string[] }[] = [
    { ids: [menus.cut] },
    { ids: [menus.cut] },
    { ids: [menus.cutColor] },
    { ids: [menus.cutColor, menus.quickTreat] },
    { ids: [menus.retouch] },
    { ids: [menus.retouch, menus.treat] },
    { ids: [menus.highlight] },
    { ids: [menus.perm] },
    { ids: [menus.cut, menus.treat] },
    { ids: [menus.cut, menus.spa] },
    { ids: [menus.spaLong] },
    { ids: [menus.bangs] },
    { ids: [menus.mensCut], shops: [omotesando] },
  ];
  const sources = ['web', 'web', 'line', 'line', 'phone', 'staff', 'walk_in'] as const;
  let txSeq = 1;

  async function book(
    c: Cust,
    date: string,
    opts: { past: boolean; today?: boolean },
  ): Promise<string | null> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const candidates = menuSets.filter((s) => !s.shops || s.shops.includes(c.shopId));
      const set = pick(candidates);
      const staffId = chance(0.75) ? pick(shopStaff[c.shopId]!) : null;
      const minute = int(0, 15) * 30; // 10:00 .. 17:30
      const time = `${String(10 + Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
      const startAt = zonedDateTime(date, time, TZ);
      const source = pick(sources);
      const tentative = !opts.past && (source === 'web' || source === 'line') && chance(0.25);
      try {
        const appt = await tx(orgId, (ctx) =>
          createAppointment(ctx, {
            shopId: c.shopId,
            customerId: c.id,
            staffId,
            isNominated: !!staffId,
            startAt: startAt.toISOString(),
            menuIds: set.ids,
            source,
            status: tentative ? 'tentative' : 'confirmed',
            customerNote: chance(0.15)
              ? pick([
                  '前回より少し短めでお願いします',
                  '肩につかない長さにしたいです',
                  '頭皮が敏感です',
                  '子連れで伺います',
                ])
              : null,
            staffNote: chance(0.1) ? '前回カラー: 8トーン アッシュ' : null,
          }),
        );
        return appt.id;
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (
          code === 'SLOT_UNAVAILABLE' ||
          code === 'APPOINTMENT_OVERLAP' ||
          code === 'RESOURCE_OVERLAP' ||
          code === 'STAFF_NOT_AVAILABLE' ||
          code === 'NO_STAFF'
        )
          continue;
        throw err;
      }
    }
    return null;
  }

  async function complete(apptId: string) {
    await tx(orgId, async (ctx) => {
      const a = await transitionAppointment(ctx, apptId, 'completed');
      // demo sales: completed transaction with line items + staff allocation (POS module creates these in production)
      const services = await ctx.trx
        .selectFrom('appointment_services')
        .select(['menu_id', 'name', 'price', 'tax_rate_bp'])
        .where('appointment_id', '=', a.id)
        .orderBy('sort_order')
        .execute();
      const nominationFee = a.is_nominated ? 550 : 0;
      const total = services.reduce((sum, x) => sum + x.price, 0) + nominationFee;
      const tax = Math.floor((total * 10) / 110);
      const prior = a.customer_id
        ? await ctx.trx.selectFrom('transactions').select('id').where('customer_id', '=', a.customer_id).where('status', '=', 'completed').executeTakeFirst()
        : undefined;
      const txRow = await ctx.trx
        .insertInto('transactions')
        .values({
          organization_id: orgId,
          shop_id: a.shop_id,
          appointment_id: a.id,
          customer_id: a.customer_id,
          staff_id: a.staff_id,
          is_nominated: a.is_nominated,
          is_new_customer: a.customer_id ? !prior : null,
          transaction_number: `D${String(txSeq++).padStart(6, '0')}`,
          status: 'completed',
          subtotal: total,
          total,
          paid_total: total,
          tax_total: tax,
          tax_breakdown: JSON.stringify({ '1000': { taxable: total, tax } }),
          completed_at: a.end_at,
          completed_by: a.staff_id,
          trace_id: 'seed',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const lines = [
        ...services.map((x) => ({ item_type: 'service', menu_id: x.menu_id, name: x.name, price: x.price, rate: x.tax_rate_bp })),
        ...(nominationFee ? [{ item_type: 'nomination_fee', menu_id: null, name: '指名料', price: nominationFee, rate: 1000 }] : []),
      ];
      for (const [i, l] of lines.entries()) {
        const item = await ctx.trx
          .insertInto('transaction_items')
          .values({
            organization_id: orgId,
            transaction_id: txRow.id,
            item_type: l.item_type,
            menu_id: l.menu_id,
            name: l.name,
            quantity: 1,
            unit_price: l.price,
            tax_rate_bp: l.rate,
            amount: l.price,
            net_amount: l.price,
            tax_amount: Math.floor((l.price * l.rate) / (10000 + l.rate)),
            sort_order: i,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        if (a.staff_id) {
          await ctx.trx
            .insertInto('transaction_item_staff')
            .values({ organization_id: orgId, transaction_item_id: item.id, staff_id: a.staff_id, role: 'main', share_bp: 10000, is_nominated: a.is_nominated, allocated_amount: l.price })
            .execute();
        }
      }
      await ctx.trx
        .insertInto('payments')
        .values({ organization_id: orgId, transaction_id: txRow.id, method: chance(0.6) ? 'card' : 'cash', amount: total, status: 'succeeded', idempotency_key: `seed:${txRow.id}`, succeeded_at: a.end_at, trace_id: 'seed' })
        .execute();
      // pretend the visit happened at its scheduled time
      await ctx.trx
        .updateTable('appointments')
        .set({ completed_at: a.end_at, checked_in_at: addMinutes(a.start_at, -5) })
        .where('id', '=', a.id)
        .execute();
      if (a.customer_id) await recomputeCustomerStats(ctx, a.customer_id);
    });
  }

  let pastCount = 0;
  let upcomingCount = 0;
  // past 3 months
  for (const c of customers) {
    const visits = int(0, 4);
    const offsets = Array.from({ length: visits }, () => -int(1, 90)).sort((a, b) => a - b);
    for (const off of offsets) {
      const date = jstToday(off);
      const id = await book(c, date, { past: true });
      if (!id) continue;
      pastCount++;
      const r = rand();
      if (r < 0.9) await complete(id);
      else if (r < 0.95)
        await tx(orgId, (ctx) =>
          transitionAppointment(ctx, id, 'cancelled', { reason: '体調不良のため' }),
        );
      else await tx(orgId, (ctx) => transitionAppointment(ctx, id, 'no_show'));
    }
  }
  // today (dashboard) — fill both shops
  const now = new Date();
  for (let i = 0; i < 10; i++) {
    const c = customers[i % customers.length]!;
    const id = await book(c, jstToday(0), { past: false, today: true });
    if (!id) continue;
    upcomingCount++;
    const a = await tx(orgId, (ctx) =>
      ctx.trx
        .selectFrom('appointments')
        .select(['start_at', 'end_at', 'status'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow(),
    );
    if (a.status === 'confirmed' && a.end_at < now && chance(0.7)) await complete(id);
    else if (a.status === 'confirmed' && a.start_at < now && a.end_at > now)
      await tx(orgId, (ctx) => transitionAppointment(ctx, id, 'in_service'));
  }
  // next 2 weeks
  for (let i = 0; i < 45; i++) {
    const c = pick(customers);
    const off = int(1, 14);
    const date = jstToday(off);
    if (weekdayOf(date) === 2) continue; // 定休日(火)
    const id = await book(c, date, { past: false });
    if (id) upcomingCount++;
  }

  // analytics aggregates (last 100 days) + AI scores so dashboards have data immediately
  const shopRows = await tx(orgId, (ctx) => ctx.trx.selectFrom('shops').select('id').execute());
  for (const shop of shopRows) {
    for (let off = -100; off <= 0; off++) {
      await tx(orgId, (ctx) => rebuildDay(ctx, shop.id, jstToday(off)));
    }
  }
  await tx(orgId, (ctx) => scoreOrganization(ctx));
  await withSystem((trx) => sql`ANALYZE`.execute(trx)).catch(() => undefined);
  console.log(
    `  shops: 2, staff: 6, menus: ${Object.keys(menus).length}, customers: ${customers.length + 4}`,
  );
  console.log(`  appointments: past ${pastCount}, today/upcoming ${upcomingCount}`);
  printCredentials();
}

async function invoiceNumber(ctx: Ctx) {
  await ctx.trx
    .updateTable('organizations')
    .set({ invoice_registration_number: 'T1234567890123' })
    .where('id', '=', ctx.actor.organizationId)
    .execute();
}

function printCredentials() {
  console.log('');
  console.log('==== Demo credentials (password: password-1234) ====');
  console.log('  owner      owner@example.com');
  console.log('  manager    manager@example.com');
  console.log('  stylist    stylist1@example.com / stylist2@example.com / stylist3@example.com');
  console.log('  reception  reception@example.com');
  console.log('  public booking: /book/shibuya , /book/omotesando');
  console.log('  LINE mock idToken: mock:<userId>:<name>  (e.g. mock:U123:テスト花子)');
  console.log('');
}

main()
  .then(() => db.destroy())
  .catch(async (err) => {
    console.error(err);
    await db.destroy();
    process.exit(1);
  });
