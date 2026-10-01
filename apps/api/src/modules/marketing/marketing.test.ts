import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { storage } from '../../lib/storage.js';
import { api, asSystem, createCustomer, createMenu, createStaffUser, createTenant, customerApi, jst, nextWeekday, shopSlug, type Tenant } from '../../test/helpers.js';
import { escapeXml, renderSnsSvg, wrapText } from './svg.js';

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Line/14.0';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

let slot = 0;
async function bookWithCode(t: Tenant, staffId: string, menuId: string, customerId: string, sourceDetail: Record<string, unknown>) {
  const date = nextWeekday(4, 3 + 7 * (slot % 3));
  const res = await t.owner.post('/v1/appointments', { shopId: t.shopId, customerId, staffId, startAt: jst(date, `${10 + (slot++ % 8)}:00`), menuIds: [menuId], source: 'web', sourceDetail });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  return res.body as { id: string };
}

describe('referral links', () => {
  it('redirects with tracking params, counts clicks without PII and attributes bookings & revenue', async () => {
    const t = await createTenant();
    const slug = await shopSlug(t);
    const stylist = await createStaffUser(t, 'stylist');
    const menu = await createMenu(t);
    const created = await t.owner.post('/v1/referral-links', { name: 'Instagram プロフィール', staffId: stylist.staffId, utm: { source: 'instagram', medium: 'social', campaign: 'autumn2026' } });
    expect(created.status).toBe(201);
    const { code, id, url } = created.body;
    expect(code).toMatch(/^[2-9A-Z]{8}$/);
    expect(url).toContain(`/v1/public/r/${code}`);

    const r = await api().get(`/v1/public/r/${code}`, undefined, { 'user-agent': UA, referer: 'https://www.instagram.com/salon' });
    expect(r.status).toBe(302);
    const location = new URL(r.headers.location as string);
    expect(location.pathname).toBe(`/book/${slug}`);
    expect(location.searchParams.get('ref')).toBe(code);
    expect(location.searchParams.get('staff')).toBe(stylist.staffId);
    expect(location.searchParams.get('utm_source')).toBe('instagram');
    expect(location.searchParams.get('utm_campaign')).toBe('autumn2026');
    // lower-case code works too; link previews (bots) are not counted as clicks
    expect((await api().get(`/v1/public/r/${code.toLowerCase()}`, undefined, { 'user-agent': UA })).status).toBe(302);
    expect((await api().get(`/v1/public/r/${code}`, undefined, { 'user-agent': 'facebookexternalhit/1.1' })).status).toBe(302);

    const events = await asSystem(t.organizationId, (ctx) => ctx.trx.selectFrom('referral_events').selectAll().where('referral_link_id', '=', id).execute());
    expect(events).toHaveLength(3);
    expect(JSON.stringify(events)).not.toContain('iPhone');
    expect((events[0]!.metadata as { uaHash: string }).uaHash).toMatch(/^[0-9a-f]{32}$/);
    expect(events.find((e) => (e.metadata as { refererHost?: string }).refererHost === 'www.instagram.com')).toBeTruthy();

    // booking via code (source_detail.referralCode) + completed visit
    const customer = await createCustomer(t);
    const appt = await bookWithCode(t, stylist.staffId, menu.id, customer.id, { referralCode: code, utm: { source: 'instagram' } });
    const other = await createCustomer(t);
    await bookWithCode(t, stylist.staffId, menu.id, other.id, { utm: { source: 'google' } }); // no code → not attributed
    await asSystem(t.organizationId, (ctx) =>
      ctx.trx
        .insertInto('transactions')
        .values({ organization_id: t.organizationId, shop_id: t.shopId, appointment_id: appt.id, customer_id: customer.id, status: 'completed', subtotal: 5500, total: 5500, completed_at: new Date() })
        .execute(),
    );
    const stats = await t.owner.get(`/v1/referral-links/${id}/stats`);
    expect(stats.status).toBe(200);
    expect(stats.body).toMatchObject({ clicks: 2, bookings: 1, completedVisits: 1, visitRevenue: 5500, purchases: 0, revenue: 5500, conversionRate: 0.5 });

    const list = await t.owner.get('/v1/referral-links', { staffId: stylist.staffId });
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({ id, click_count: 2, booking_count: 1 });

    // deactivate → link stops working; delete hides it
    expect((await t.owner.patch(`/v1/referral-links/${id}`, { isActive: false })).body.is_active).toBe(false);
    expect((await api().get(`/v1/public/r/${code}`)).status).toBe(404);
    expect((await api().get('/v1/public/r/ZZZZZZZZ')).status).toBe(404);
    expect((await t.owner.delete(`/v1/referral-links/${id}`)).status).toBe(204);
    expect((await t.owner.get(`/v1/referral-links/${id}`)).status).toBe(404);
  });

  it('builds product/profile targets, validates input and enforces permissions & tenant isolation', async () => {
    const t = await createTenant();
    const slug = await shopSlug(t);
    const product = await t.owner.post('/v1/products', { name: 'シャンプー', price: 3300, isOnline: true });
    const link = await t.owner.post('/v1/referral-links', { name: '商品', target: 'product', targetId: product.body.id, shopId: t.shopId });
    expect(link.status).toBe(201);
    const r = await api().get(`/v1/public/r/${link.body.code}`);
    expect(new URL(r.headers.location as string).pathname).toBe(`/shop/${slug}/products/${product.body.id}`);

    expect((await t.owner.post('/v1/referral-links', { name: 'x', target: 'product' })).status).toBe(400);
    expect((await t.owner.post('/v1/referral-links', { name: 'x', target: 'profile' })).status).toBe(400);
    expect((await t.owner.post('/v1/referral-links', { name: 'x', utm: { source: '<script>' } })).status).toBe(400);
    const profile = await t.owner.post('/v1/referral-links', { name: 'プロフィール', target: 'profile', staffId: t.ownerStaffId });
    const pr = await api().get(`/v1/public/r/${profile.body.code}`);
    expect(new URL(pr.headers.location as string).pathname).toBe(`/s/${slug}/staff/${t.ownerStaffId}`);

    const stylist = await createStaffUser(t, 'stylist');
    expect((await stylist.api.get('/v1/referral-links')).status).toBe(403);
    expect((await stylist.api.post('/v1/referral-links', { name: 'x' })).status).toBe(403);

    const other = await createTenant('他社');
    expect((await other.owner.get(`/v1/referral-links/${link.body.id}`)).status).toBe(404);
    expect((await other.owner.get(`/v1/referral-links/${link.body.id}/stats`)).status).toBe(404);
    expect((await other.owner.get('/v1/referral-links')).body.items).toHaveLength(0);
  });

  it('issues one friend-referral link per customer and records signup of new customers', async () => {
    const t = await createTenant();
    const stylist = await createStaffUser(t, 'stylist');
    const menu = await createMenu(t);
    const referrer = await createCustomer(t, { lastName: '紹介', firstName: '元子' });
    const a = await stylist.api.post(`/v1/customers/${referrer.id}/referral-link`, {});
    expect(a.status).toBe(200);
    const b = await t.owner.post(`/v1/customers/${referrer.id}/referral-link`, {});
    expect(b.body.code).toBe(a.body.code);
    expect(a.body.utm).toEqual({ source: 'referral', medium: 'friend', campaign: 'friend_referral' });
    const self = await (await customerApi(t, referrer.id)).get('/v1/public/me/referral-link');
    expect(self.body.code).toBe(a.body.code);

    const friend = await createCustomer(t);
    await bookWithCode(t, stylist.staffId, menu.id, friend.id, { referralCode: a.body.code });
    await bookWithCode(t, stylist.staffId, menu.id, referrer.id, { referralCode: a.body.code }); // self referral ignored
    const stats = await t.owner.get(`/v1/referral-links/${a.body.id}/stats`);
    expect(stats.body).toMatchObject({ bookings: 1, signups: 1 });
  });
});

describe('SNS share material', () => {
  it('renders a 1080x1080 SVG with all text escaped', () => {
    const svg = renderSnsSvg({
      template: 'square_style',
      shopName: 'Salon <A&B>',
      staffName: '"佐藤"',
      caption: '<script>alert(1)</script> 秋の透明感カラー',
      hashtags: ['美容室', '</text><script>x</script>'],
    });
    expect(svg).toContain('width="1080" height="1080"');
    expect(svg).toContain('Noto Sans JP');
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(svg).toContain('Salon &lt;A&amp;B&gt;');
    expect(svg).toContain('&quot;佐藤&quot;');
    expect(escapeXml('a\u0000b\u001Fc"\'')).toBe('abc&quot;&apos;');
    expect(wrapText('あいうえおかきくけこ', 4, 2)).toEqual(['あいうえ', 'おかき…']);
    expect(wrapText('abc\ndef', 10, 3)).toEqual(['abc', 'def']);
  });

  it('requires customer consent for karte photos, stores the file and supports list/download/delete', async () => {
    const t = await createTenant();
    const customer = await createCustomer(t);
    const objectKey = `${t.organizationId}/karte/${randomUUID()}.png`;
    await storage.put(objectKey, PNG, 'image/png');
    const karteAssetId = await asSystem(t.organizationId, async (ctx) => {
      const file = await ctx.trx
        .insertInto('files')
        .values({ organization_id: t.organizationId, object_key: objectKey, purpose: 'karte_photo', content_type: 'image/png', size_bytes: PNG.length, status: 'uploaded' })
        .returning('id')
        .executeTakeFirstOrThrow();
      const karte = await ctx.trx
        .insertInto('kartes')
        .values({ organization_id: t.organizationId, shop_id: t.shopId, customer_id: customer.id, staff_id: t.ownerStaffId, visit_date: '2026-09-30' })
        .returning('id')
        .executeTakeFirstOrThrow();
      const asset = await ctx.trx
        .insertInto('karte_assets')
        .values({ organization_id: t.organizationId, karte_id: karte.id, customer_id: customer.id, file_id: file.id, object_key: objectKey, asset_type: 'photo_after' })
        .returning('id')
        .executeTakeFirstOrThrow();
      return asset.id;
    });

    const noConsent = await t.owner.post('/v1/sns-assets', { template: 'square_style', caption: '仕上がり', karteAssetId });
    expect(noConsent.status).toBe(422);
    expect(noConsent.body.error.code).toBe('CUSTOMER_CONSENT_REQUIRED');

    const ok = await t.owner.post('/v1/sns-assets', { template: 'before_after', caption: '<img src=x onerror=alert(1)>', hashtags: ['#髪質改善', '＃ショート', '髪質改善'], karteAssetId, customerConsent: true });
    expect(ok.status).toBe(201);
    expect(ok.body.customer_consent).toBe(true);
    expect(ok.body.hashtags).toEqual(['髪質改善', 'ショート']);
    expect(ok.body.downloadUrl).toContain('/v1/files/blob/');
    const file = await asSystem(t.organizationId, (ctx) => ctx.trx.selectFrom('files').selectAll().where('id', '=', ok.body.file_id).executeTakeFirstOrThrow());
    expect(file).toMatchObject({ purpose: 'sns_asset', content_type: 'image/svg+xml', status: 'uploaded' });
    const svg = (await storage.get(file.object_key)).toString('utf8');
    expect(svg).toContain('data:image/png;base64,');
    expect(svg).not.toContain('<img');
    expect(svg).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(svg).toContain('#髪質改善 #ショート');

    // review quote needs a published review
    expect((await t.owner.post('/v1/sns-assets', { template: 'review_quote', caption: 'x' })).status).toBe(400);
    const reviewId = await asSystem(t.organizationId, async (ctx) =>
      (await ctx.trx.insertInto('reviews').values({ organization_id: t.organizationId, shop_id: t.shopId, rating: 5, body: '最高<でした>', reviewer_name: 'M', status: 'pending' }).returning('id').executeTakeFirstOrThrow()).id,
    );
    const unpublished = await t.owner.post('/v1/sns-assets', { template: 'review_quote', reviewId });
    expect(unpublished.status).toBe(422);
    await t.owner.patch(`/v1/reviews/${reviewId}`, { status: 'published' });
    const quote = await t.owner.post('/v1/sns-assets', { template: 'review_quote', reviewId, hashtags: ['口コミ'] });
    expect(quote.status).toBe(201);
    const quoteSvg = (await storage.get((await asSystem(t.organizationId, (ctx) => ctx.trx.selectFrom('files').select('object_key').where('id', '=', quote.body.file_id).executeTakeFirstOrThrow())).object_key)).toString();
    expect(quoteSvg).toContain('最高&lt;でした&gt;');
    expect(quoteSvg).toContain('★★★★★');

    const list = await t.owner.get('/v1/sns-assets');
    expect(list.body.items).toHaveLength(2);
    const stylist = await createStaffUser(t, 'stylist');
    expect((await stylist.api.get('/v1/sns-assets')).status).toBe(403);
    const other = await createTenant('他社');
    expect((await other.owner.get(`/v1/sns-assets/${ok.body.id}`)).status).toBe(404);
    expect((await other.owner.post('/v1/sns-assets', { template: 'square_style', karteAssetId, customerConsent: true })).status).toBe(404);

    expect((await t.owner.delete(`/v1/sns-assets/${ok.body.id}`)).status).toBe(204);
    expect((await t.owner.get(`/v1/sns-assets/${ok.body.id}`)).status).toBe(404);
    expect(await storage.head(file.object_key)).toBeNull();
  });
});
