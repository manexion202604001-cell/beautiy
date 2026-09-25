/* Demo data seed. Usage: npm run db:seed  (DESTROYS the demo organization and recreates it) */
import { randomUUID } from 'node:crypto';
import { hashPassword } from '@salonos/core/crypto';
import { addDays, localToUtc, todayIn } from '@salonos/core';
import { prisma } from '../lib/server/db';
import { piiColumns } from '../lib/server/pii';
import { recomputeCustomerStats } from '../lib/server/customers';
import { createDefaultShopSetup } from '../lib/server/shops';

const TZ = 'Asia/Tokyo';
const PASSWORD = 'demo1234';
let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = <T,>(a: T[]): T => a[Math.floor(rand() * a.length)];
const between = (a: number, b: number) => a + Math.floor(rand() * (b - a + 1));

const LAST = [['佐藤', 'サトウ'], ['鈴木', 'スズキ'], ['高橋', 'タカハシ'], ['田中', 'タナカ'], ['伊藤', 'イトウ'], ['渡辺', 'ワタナベ'], ['山本', 'ヤマモト'], ['中村', 'ナカムラ'], ['小林', 'コバヤシ'], ['加藤', 'カトウ'], ['吉田', 'ヨシダ'], ['山田', 'ヤマダ'], ['松本', 'マツモト'], ['井上', 'イノウエ'], ['木村', 'キムラ'], ['林', 'ハヤシ'], ['清水', 'シミズ'], ['森', 'モリ'], ['池田', 'イケダ'], ['橋本', 'ハシモト']];
const FIRST = [['花子', 'ハナコ'], ['美咲', 'ミサキ'], ['葵', 'アオイ'], ['凛', 'リン'], ['結衣', 'ユイ'], ['陽菜', 'ヒナ'], ['さくら', 'サクラ'], ['美月', 'ミツキ'], ['彩', 'アヤ'], ['真央', 'マオ'], ['優奈', 'ユウナ'], ['七海', 'ナナミ'], ['恵', 'メグミ'], ['翔太', 'ショウタ'], ['健', 'ケン'], ['大輔', 'ダイスケ'], ['莉子', 'リコ'], ['千尋', 'チヒロ']];

async function main() {
  const existing = await prisma.organization.findUnique({ where: { slug: 'demo' } });
  if (existing) {
    console.log('Removing existing demo organization…');
    const shopIds = (await prisma.shop.findMany({ where: { organizationId: existing.id }, select: { id: true } })).map((s) => s.id);
    await prisma.transaction.deleteMany({ where: { shopId: { in: shopIds } } });
    await prisma.karte.deleteMany({ where: { organizationId: existing.id } });
    await prisma.appointment.deleteMany({ where: { organizationId: existing.id } });
    await prisma.order.deleteMany({ where: { organizationId: existing.id } });
    for (const model of ['message', 'messageTemplate', 'broadcast', 'automationRule', 'counselingForm', 'karteTemplate', 'syncEvent', 'storedFile', 'piiUnlock', 'customerMerge', 'productRecommendation', 'subscription', 'coupon', 'menu', 'review'] as const) {
      await (prisma as any)[model].deleteMany({ where: { organizationId: existing.id } });
    }
    await prisma.organization.delete({ where: { id: existing.id } });
    await prisma.user.deleteMany({ where: { email: { endsWith: '@demo.salon' } } });
  }

  const org = await prisma.organization.create({ data: { name: 'MANEXION Demo Salon', slug: 'demo' } });
  const shopDefs = [
    { name: '青山店', slug: 'aoyama', seatCount: 4, address: '東京都港区南青山1-2-3', phone: '03-1234-5678', description: '表参道駅から徒歩3分。髪質改善とデザインカラーが得意な、落ち着いた完全予約制サロンです。', accessInfo: '表参道駅 A4出口 徒歩3分', hygieneInfo: '施術ごとのクロス交換・器具の消毒・換気を徹底しています。' },
    { name: '銀座店', slug: 'ginza', seatCount: 3, address: '東京都中央区銀座4-5-6', phone: '03-9876-5432', description: '銀座駅直結。お仕事帰りにも通いやすい21時まで営業のサロンです。', accessInfo: '銀座駅 B2出口直結', hygieneInfo: '全席パーテーション・空気清浄機を設置しています。' },
  ];
  const shops = [];
  for (const d of shopDefs) {
    const shop = await prisma.shop.create({ data: { organizationId: org.id, ...d, instagramUrl: 'https://instagram.com/', bookingMode: 'INSTANT' } });
    await prisma.$transaction(async (tx) => createDefaultShopSetup(tx, org.id, shop.id));
    shops.push(shop);
  }
  await prisma.businessHour.updateMany({ where: { shopId: shops[1].id, weekday: { in: [2, 3, 4, 5] } }, data: { closeMin: 1260 } });
  await prisma.shopHoliday.create({ data: { shopId: shops[0].id, date: addDays(todayIn(TZ), 20), reason: '研修のため臨時休業' } });

  // extra menus
  for (const shop of shops) {
    await prisma.menu.createMany({
      data: [
        { category: 'パーマ', name: 'デジタルパーマ', durationMin: 150, price: 16500 },
        { category: 'ヘッドスパ', name: '炭酸ヘッドスパ', durationMin: 30, price: 4400 },
        { category: 'カラー', name: 'ハイライトカラー', durationMin: 120, price: 14300 },
        { category: 'トリートメント', name: '髪質改善トリートメント', durationMin: 60, price: 9900 },
      ].map((m, i) => ({ ...m, organizationId: org.id, shopId: shop.id, sortOrder: 10 + i })),
    });
    await prisma.coupon.createMany({
      data: [
        { organizationId: org.id, shopId: shop.id, name: '【新規】カット＋カラー 20%OFF', discountType: 'PERCENT', discountValue: 20, newCustomerOnly: true, description: '初めてご来店の方限定' },
        { organizationId: org.id, shopId: shop.id, name: '平日限定 トリートメント1,000円引き', discountType: 'AMOUNT', discountValue: 1000, description: '火〜金曜日のご来店に限ります' },
      ],
    });
  }

  const pw = hashPassword(PASSWORD);
  const staffDefs = [
    { email: 'owner@demo.salon', name: '真田 玲奈', role: 'OWNER', shops: [0, 1], canViewPII: true, bookable: true, bio: 'オーナースタイリスト。髪質改善と大人のショートスタイルが得意です。' },
    { email: 'manager@demo.salon', name: '藤井 拓也', role: 'MANAGER', shops: [0], canViewPII: true, bookable: true, bio: '店長。メンズカット・パーマならお任せください。' },
    { email: 'stylist1@demo.salon', name: '小川 由佳', role: 'STYLIST', shops: [0], canViewPII: false, bookable: true, bio: '透明感カラーとハイライトが得意。' },
    { email: 'stylist2@demo.salon', name: '石井 翼', role: 'STYLIST', shops: [1], canViewPII: false, bookable: true, bio: 'ボブ・ショートのカットに定評があります。' },
    { email: 'stylist3@demo.salon', name: '森田 あかり', role: 'STYLIST', shops: [1, 0], canViewPII: false, bookable: true, bio: 'ヘッドスパと癒しの時間を提供します。' },
    { email: 'assistant@demo.salon', name: '前田 蓮', role: 'ASSISTANT', shops: [0], canViewPII: false, bookable: false, bio: null },
    { email: 'reception@demo.salon', name: '岡本 さや', role: 'RECEPTION', shops: [0, 1], canViewPII: false, bookable: false, bio: null },
  ] as const;
  const staff: { userId: string; membershipId: string; shops: number[]; bookable: boolean; name: string }[] = [];
  for (const [i, s] of staffDefs.entries()) {
    const user = await prisma.user.create({ data: { email: s.email, name: s.name, passwordHash: pw } });
    const m = await prisma.membership.create({
      data: { organizationId: org.id, userId: user.id, role: s.role, canViewPII: s.canViewPII, displayName: s.name, bookable: s.bookable, publicBio: s.bio, sortOrder: i, nominationFee: s.role === 'OWNER' ? 1100 : 0, specialties: s.bio ? 'カット / カラー' : null },
    });
    for (const si of s.shops) await prisma.staffAssignment.create({ data: { membershipId: m.id, shopId: shops[si].id } });
    staff.push({ userId: user.id, membershipId: m.id, shops: [...s.shops], bookable: s.bookable, name: s.name });
  }

  const tagNames = [['VIP', '#b8860b'], ['新規', '#14916a'], ['白髪染め', '#7a4be0'], ['敏感肌', '#d6334a'], ['紹介', '#3f63f5'], ['学生', '#0a86b8']];
  const tags = [];
  for (const [name, color] of tagNames) tags.push(await prisma.tag.create({ data: { organizationId: org.id, name, color } }));

  // customers
  const customers: { id: string; shop: number; staffUserId: string }[] = [];
  for (let i = 0; i < 64; i++) {
    const [ln, lk] = pick(LAST), [fn, fk] = pick(FIRST);
    const shop = i % 3 === 0 ? 1 : 0;
    const shopStaff = staff.filter((s) => s.bookable && s.shops.includes(shop));
    const assigned = pick(shopStaff);
    const phone = `090${String(10000000 + i * 7919).slice(0, 8)}`;
    const c = await prisma.customer.create({
      data: {
        organizationId: org.id, primaryShopId: shops[shop].id, lastName: ln, firstName: fn, lastNameKana: lk, firstNameKana: fk,
        ...piiColumns({ phone, email: `customer${i + 1}@example.com`, address: i % 4 === 0 ? `東京都渋谷区神宮前${i}-1-1` : null }),
        birthday: `19${between(70, 99)}-${String(between(1, 12)).padStart(2, '0')}-${String(between(1, 28)).padStart(2, '0')}`,
        gender: i % 7 === 0 ? '男性' : '女性', favorite: i % 9 === 0, assignedStaffId: assigned.userId,
        notes: i % 5 === 0 ? '頭皮が敏感。薬剤は低刺激のものを使用。' : null,
      },
    });
    if (i % 3 !== 2) await prisma.customerIdentity.create({ data: { organizationId: org.id, customerId: c.id, provider: 'LINE', externalId: `Udemo${String(i).padStart(30, '0')}`, displayName: `${fn}` } });
    const tagSet = new Set<string>();
    if (i % 9 === 0) tagSet.add(tags[0].id);
    if (i % 6 === 1) tagSet.add(tags[2].id);
    if (i % 5 === 0) tagSet.add(tags[3].id);
    if (i % 11 === 3) tagSet.add(tags[4].id);
    for (const t of tagSet) await prisma.customerTag.create({ data: { customerId: c.id, tagId: t } });
    customers.push({ id: c.id, shop, staffUserId: assigned.userId });
  }
  // duplicate candidate for the merge workflow
  await prisma.customer.create({
    data: { organizationId: org.id, primaryShopId: shops[0].id, lastName: '山田', firstName: '花子', lastNameKana: 'ヤマダ', firstNameKana: 'ハナコ', ...piiColumns({ phone: '080-5555-0101', email: 'hanako.y@example.com' }), birthday: '1991-04-12' },
  });
  await prisma.customer.create({
    data: { organizationId: org.id, primaryShopId: shops[0].id, lastName: '山田', firstName: '花子', lastNameKana: 'やまだ', firstNameKana: 'はなこ', ...piiColumns({ phone: '08055550101' }), notes: '外部予約サイト経由で登録' },
  });

  const menusByShop = await Promise.all(shops.map((s) => prisma.menu.findMany({ where: { shopId: s.id, isConsultation: false } })));
  const products = await Promise.all([
    { name: 'モイスチャーシャンプー 300ml', brand: 'MANEXION Care', price: 3520, stock: 24, subscriptionIntervalDays: 30 },
    { name: 'リペアトリートメント 250g', brand: 'MANEXION Care', price: 3960, stock: 18, subscriptionIntervalDays: 30 },
    { name: 'ヘアオイル 100ml', brand: 'MANEXION Care', price: 4180, stock: 30 },
    { name: 'スタイリングバーム', brand: 'Lumière', price: 2750, stock: 12 },
    { name: '頭皮ケアローション', brand: 'Lumière', price: 4950, stock: 8, subscriptionIntervalDays: 45 },
    { name: 'カラーケアシャンプー', brand: 'MANEXION Care', price: 3300, stock: 20, subscriptionIntervalDays: 30 },
  ].map((p, i) => prisma.product.create({ data: { organizationId: org.id, sku: `SKU-${1001 + i}`, description: 'サロン専売品。スタイリストがお客様の髪質に合わせてご提案します。', ...p } })));

  // appointments & transactions over time
  const today = todayIn(TZ);
  const now = Date.now();
  const appts: any[] = [], apptMenus: any[] = [], txs: any[] = [], items: any[] = [], pays: any[] = [], points: any[] = [], kartes: any[] = [];
  const sources = ['WEB', 'WEB', 'LINE', 'LINE', 'STAFF', 'PHONE', 'HOTPEPPER', 'INSTAGRAM'] as const;
  let txNo = 1;
  for (let d = -180; d <= 14; d++) {
    const date = addDays(today, d);
    const wd = new Date(date + 'T00:00:00Z').getUTCDay();
    if (wd === 1) continue; // Monday closed
    for (const [si, shop] of shops.entries()) {
      const shopStaff = staff.filter((s) => s.bookable && s.shops.includes(si));
      for (const st of shopStaff) {
        // staff assigned to two shops only works at the secondary shop on weekends
        if (st.shops.length > 1 && st.shops[0] !== si && wd !== 0 && wd !== 6) continue;
        if (st.shops.length > 1 && st.shops[0] === si && (wd === 0 || wd === 6)) continue;
        let t = 600 + between(0, 2) * 30;
        const n = d > 0 ? between(0, 3) : between(1, 4);
        for (let k = 0; k < n; k++) {
          const menu = pick(menusByShop[si]);
          const extra = rand() < 0.3 ? menusByShop[si].find((m) => m.category === 'トリートメント') : null;
          const dur = menu.durationMin + (extra?.durationMin ?? 0);
          if (t + dur > 1170) break;
          const cand = customers.filter((c) => c.shop === si);
          const cust = rand() < 0.6 ? (cand.find((c) => c.staffUserId === st.userId && rand() < 0.35) ?? pick(cand)) : pick(cand);
          const startAt = localToUtc(date, t, TZ), endAt = localToUtc(date, t + dur, TZ);
          const past = endAt.getTime() < now;
          const isToday = d === 0;
          let status: string = past ? (rand() < 0.04 ? 'NO_SHOW' : rand() < 0.05 ? 'CANCELLED' : 'COMPLETED') : 'CONFIRMED';
          if (isToday && past) status = 'COMPLETED';
          if (!past && rand() < 0.1) status = 'REQUESTED';
          const id = randomUUID();
          const price = menu.price + (extra?.price ?? 0);
          appts.push({ id, organizationId: org.id, shopId: shop.id, customerId: cust.id, staffId: st.userId, startAt, endAt, status, source: pick([...sources]), nominated: cust.staffUserId === st.userId, totalPrice: price, cancelledAt: status === 'CANCELLED' ? startAt : null, manageToken: randomUUID().replace(/-/g, '') });
          apptMenus.push({ id: randomUUID(), appointmentId: id, menuId: menu.id, name: menu.name, price: menu.price, durationMin: menu.durationMin });
          if (extra) apptMenus.push({ id: randomUUID(), appointmentId: id, menuId: extra.id, name: extra.name, price: extra.price, durationMin: extra.durationMin });
          if (status === 'COMPLETED') {
            const txId = randomUUID();
            const retail = rand() < 0.25 ? pick(products) : null;
            const discount = rand() < 0.15 ? 1000 : 0;
            const total = price + (retail?.price ?? 0) - discount;
            txs.push({ id: txId, organizationId: org.id, shopId: shop.id, number: txNo++, customerId: cust.id, appointmentId: id, staffId: st.userId, status: 'PAID', subtotal: price + (retail?.price ?? 0), discountTotal: discount, taxTotal: Math.floor(total * 10 / 110), total, pointsEarned: Math.floor(total / 100), paidAt: endAt, createdAt: endAt });
            items.push({ id: randomUUID(), transactionId: txId, kind: 'SERVICE', menuId: menu.id, name: menu.name, unitPrice: menu.price, staffId: st.userId, nominated: cust.staffUserId === st.userId, discount });
            if (extra) items.push({ id: randomUUID(), transactionId: txId, kind: 'SERVICE', menuId: extra.id, name: extra.name, unitPrice: extra.price, staffId: st.userId });
            if (retail) items.push({ id: randomUUID(), transactionId: txId, kind: 'RETAIL', productId: retail.id, name: retail.name, unitPrice: retail.price, staffId: st.userId });
            pays.push({ id: randomUUID(), transactionId: txId, method: pick(['CASH', 'CARD', 'CARD', 'EMONEY', 'QR']), amount: total, createdAt: endAt });
            points.push({ id: randomUUID(), organizationId: org.id, customerId: cust.id, delta: Math.floor(total / 100), reason: '来店ポイント', transactionId: txId, createdAt: endAt });
            if (rand() < 0.35) kartes.push({ id: randomUUID(), organizationId: org.id, shopId: shop.id, customerId: cust.id, appointmentId: id, authorId: st.userId, visitDate: startAt, treatmentNote: `${menu.name}${extra ? '＋' + extra.name : ''}。${pick(['前回より2cm短く、顔周りにレイヤー。', '根元リタッチ中心。毛先は軽めに。', 'ダメージ部分をカットし、まとまり重視。', '重めのボブを希望。内側を少しすく。'])}`, formulaNote: menu.category === 'カラー' || menu.name.includes('カラー') ? pick(['8N 40g + 8A 20g / OX 6% 1:1', '7Ash 60g / OX 3%', '10Lv ブリーチ後 9Pk 40g']) : null, careMemo: 'ご自宅ではアウトバストリートメントをお使いください。次回は6〜7週間後がおすすめです。' });
          }
          t += dur + between(0, 2) * 30;
        }
      }
    }
  }
  const chunk = async <T,>(rows: T[], f: (r: T[]) => Promise<unknown>) => { for (let i = 0; i < rows.length; i += 500) await f(rows.slice(i, i + 500)); };
  await chunk(appts, (r) => prisma.appointment.createMany({ data: r }));
  await chunk(apptMenus, (r) => prisma.appointmentMenu.createMany({ data: r }));
  await chunk(txs, (r) => prisma.transaction.createMany({ data: r }));
  await chunk(items, (r) => prisma.transactionItem.createMany({ data: r }));
  await chunk(pays, (r) => prisma.payment.createMany({ data: r }));
  await chunk(points, (r) => prisma.pointLedger.createMany({ data: r }));
  await chunk(kartes, (r) => prisma.karte.createMany({ data: r }));
  await prisma.$executeRawUnsafe(`SELECT setval(pg_get_serial_sequence('"Transaction"', 'number'), (SELECT COALESCE(MAX(number), 1) FROM "Transaction"))`);
  console.log(`appointments=${appts.length} transactions=${txs.length} kartes=${kartes.length}`);

  // private block & consultation today for the ledger
  const owner = staff[0];
  await prisma.appointment.create({ data: { organizationId: org.id, shopId: shops[0].id, staffId: owner.userId, startAt: localToUtc(addDays(today, 1), 13 * 60, TZ), endAt: localToUtc(addDays(today, 1), 14 * 60, TZ), kind: 'PRIVATE', title: '打ち合わせ（メーカー）', status: 'CONFIRMED' } });

  for (const c of await prisma.customer.findMany({ where: { organizationId: org.id }, select: { id: true } })) await recomputeCustomerStats(c.id);

  // messaging
  await prisma.messageTemplate.createMany({
    data: [
      { organizationId: org.id, name: '予約確定', category: 'BOOKING_CONFIRMED', body: '{{customer_name}}様\n{{shop_name}}です。ご予約ありがとうございます。\n日時：{{date}} {{time}}\nメニュー：{{menu}}\n担当：{{staff_name}}\n変更・キャンセル：{{manage_url}}' },
      { organizationId: org.id, name: '前日リマインド', category: 'REMINDER', body: '{{customer_name}}様\n明日 {{time}} より{{shop_name}}でお待ちしております。\n変更はこちら：{{manage_url}}' },
      { organizationId: org.id, name: '来店周期フォロー', category: 'FOLLOW_UP', body: '{{customer_name}}様\n前回のご来店から{{days_since}}日が経ちました。そろそろメンテナンスの時期です。\nご予約はこちら：{{booking_url}}' },
      { organizationId: org.id, name: '口コミ依頼', category: 'REVIEW_REQUEST', body: '{{customer_name}}様\n本日はご来店ありがとうございました。よろしければご感想をお聞かせください。\n{{review_url}}' },
    ],
  });
  await prisma.automationRule.createMany({
    data: [
      { organizationId: org.id, name: '予約前日リマインド', trigger: 'REMINDER_BEFORE', offsetValue: 24, body: '{{customer_name}}様\n明日 {{time}} より{{shop_name}}でお待ちしております。\n変更はこちら：{{manage_url}}' },
      { organizationId: org.id, name: '45日来店なしフォロー', trigger: 'VISIT_CYCLE', offsetValue: 45, body: '{{customer_name}}様\n前回のご来店から{{days_since}}日が経ちました。ご予約はこちら：{{booking_url}}' },
      { organizationId: org.id, name: '来店後の口コミ依頼', trigger: 'AFTER_VISIT_REVIEW', offsetValue: 3, body: '{{customer_name}}様\nご来店ありがとうございました。ご感想をお聞かせください。{{review_url}}' },
      { organizationId: org.id, name: 'お誕生日メッセージ', trigger: 'BIRTHDAY', offsetValue: 0, body: '{{customer_name}}様\nお誕生日おめでとうございます！今月ご来店でトリートメントをプレゼント。', active: false },
    ],
  });
  const lineCustomers = await prisma.customer.findMany({ where: { organizationId: org.id, identities: { some: { provider: 'LINE' } } }, take: 8 });
  for (const [i, c] of lineCustomers.entries()) {
    const base = now - (i + 1) * 3600_000 * 5;
    await prisma.message.createMany({
      data: [
        { organizationId: org.id, shopId: shops[0].id, customerId: c.id, channel: 'LINE', direction: 'OUTBOUND', body: `${c.lastName}様\n先日はご来店ありがとうございました！その後スタイルはいかがですか？`, status: 'SENT', sentAt: new Date(base), createdAt: new Date(base) },
        { organizationId: org.id, shopId: shops[0].id, customerId: c.id, channel: 'LINE', direction: 'INBOUND', body: pick(['とても扱いやすいです！次回もお願いします。', '来週の土曜日空いていますか？', 'カラーの色落ちが少し気になります…', 'ありがとうございます😊']), status: 'RECEIVED', createdAt: new Date(base + 1800_000), readAt: i > 2 ? new Date(base + 3600_000) : null },
      ],
    });
  }

  // reviews
  const completed = appts.filter((a) => a.status === 'COMPLETED').slice(-40);
  for (const [i, a] of completed.entries()) {
    if (i % 3) continue;
    const c = await prisma.customer.findUnique({ where: { id: a.customerId } });
    await prisma.review.create({
      data: {
        organizationId: org.id, shopId: a.shopId, staffId: a.staffId, customerId: a.customerId, appointmentId: a.id,
        rating: pick([5, 5, 5, 4, 4, 3]), authorName: `${c?.lastName ?? ''}様`, title: pick(['大満足です', 'また行きたい', '丁寧なカウンセリング', 'いつもありがとうございます']),
        body: pick(['仕上がりがとても綺麗で、家でも再現しやすいです。', 'カウンセリングが丁寧で安心してお任せできました。', '雰囲気が良く、リラックスできました。', '少し待ち時間がありましたが、仕上がりには満足です。']),
        reply: i % 2 ? 'ご来店ありがとうございました！またのお越しをお待ちしております。' : null, repliedAt: i % 2 ? new Date() : null,
        createdAt: new Date(a.endAt.getTime() + 86400000),
      },
    });
  }

  await prisma.karteTemplate.createMany({
    data: [
      { organizationId: org.id, name: 'カラー（リタッチ）', treatmentNote: '根元リタッチ。新生部 {{cm}}cm。\n毛先はトーンダウンのみ。', formulaNote: '根元：7N 40g + OX 6%\n毛先：7Ash 30g + OX 3%', careMemo: 'カラー後48時間はシャンプーを控えめに。' },
      { organizationId: org.id, name: 'カット（定期メンテ）', treatmentNote: '全体を1〜2cmカット。顔周りのレイヤー調整。', careMemo: '次回は6週間後がおすすめです。' },
    ],
  });
  await prisma.counselingForm.create({
    data: {
      organizationId: org.id, name: '初回カウンセリングシート', description: 'ご来店前にご記入ください',
      fields: [
        { id: 'concern', label: '髪のお悩み', type: 'multiselect', options: ['パサつき', 'うねり', '白髪', 'ボリューム', '頭皮', '特になし'], required: true },
        { id: 'style', label: 'なりたいイメージ', type: 'textarea' },
        { id: 'allergy', label: 'アレルギー・肌トラブルの有無', type: 'select', options: ['なし', 'あり'], required: true },
        { id: 'allergyDetail', label: '「あり」の方は詳細', type: 'text' },
        { id: 'lastColor', label: '前回のカラー時期', type: 'date' },
      ],
      requireConsent: true,
      consentText: '薬剤によるアレルギー反応が起こる可能性があることを理解し、施術に同意します。体調に異変を感じた場合は速やかにスタッフへ申し出ます。',
    },
  });
  await prisma.broadcast.create({ data: { organizationId: org.id, name: '秋のヘッドスパキャンペーン', body: '{{customer_name}}様\n季節の変わり目の頭皮ケアに、炭酸ヘッドスパを期間限定で20%OFF！', segment: { lastVisitDaysMin: 30 }, status: 'DRAFT' } });

  // external sync examples
  await prisma.integration.create({ data: { organizationId: org.id, shopId: shops[0].id, provider: 'HOTPEPPER', status: 'ACTIVE' } });
  await prisma.syncEvent.createMany({
    data: [
      { organizationId: org.id, provider: 'HOTPEPPER', externalEventId: 'demo-evt-1', type: 'booking.upsert', payload: { note: 'demo' }, status: 'DONE', attempts: 1, processedAt: new Date() },
      { organizationId: org.id, provider: 'HOTPEPPER', externalEventId: 'demo-evt-2', type: 'booking.upsert', payload: { note: 'demo' }, status: 'CONFLICT', attempts: 1, lastError: '担当スタッフの予定が重複しています' },
      { organizationId: org.id, provider: 'HOTPEPPER', externalEventId: 'demo-evt-3', type: 'booking.upsert', payload: { note: 'demo' }, status: 'DEAD', attempts: 6, lastError: 'missing field: booking.customer.name' },
    ],
  });

  console.log('Seed complete. Login: owner@demo.salon / demo1234');
}

main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
