import { beforeEach, describe, expect, it } from 'vitest';
import {
  api,
  asSystem,
  createCustomer,
  createLineChannel,
  createStaffUser,
  createTenant,
  lineFollower,
  lineUserId,
  shopSlug,
  type Tenant,
} from '../../test/helpers.js';
import { lineMock } from '../messaging/providers/line.js';

/**
 * Walk-in reception opened inside LINE (LIFF): the QR URL, the verified LINE user on the intake and
 * linking it to the customer. (Own file: public submissions are rate limited per client IP.)
 */
const anon = api();
beforeEach(() => lineMock.reset());

const person = (over: Record<string, unknown> = {}) => ({
  lastName: '来店',
  firstName: '花子',
  lastNameKana: 'ライテン',
  firstNameKana: 'ハナコ',
  birthday: '1990-04-12',
  phone: '090-1111-2222',
  ...over,
});

async function simpleConsent(t: Tenant) {
  const res = await t.owner.post('/v1/form-templates', {
    kind: 'consent',
    name: '施術同意書',
    shopId: t.shopId,
    fields: [],
    bodyMarkdown: '## 同意事項\n- 施術について説明を受けました',
  });
  expect(res.status).toBe(201);
  return res.body as { id: string; lineage_id: string };
}

describe('walk-in reception inside LINE (LIFF)', () => {
  const identitiesOf = (t: Tenant, customerId: string) =>
    asSystem(t.organizationId, (ctx) =>
      ctx.trx
        .selectFrom('customer_identities')
        .selectAll()
        .where('customer_id', '=', customerId)
        .where('provider', '=', 'line')
        .execute(),
    );

  it('opens the QR in LINE when the shop channel has a LIFF ID (shop channel wins over the organization one)', async () => {
    const t = await createTenant();
    const slug = await shopSlug(t);
    await simpleConsent(t);
    const stylist = await createStaffUser(t, 'stylist');

    // no LINE account / no LIFF ID → the ordinary web page
    const plain = await t.owner.get('/v1/walkin-intakes/reception-link', {
      shopId: t.shopId,
      staffId: stylist.staffId,
    });
    expect(plain.body.liffId).toBeNull();
    expect(plain.body.url).toMatch(
      new RegExp(`^http.*/consent/${slug}\\?staff=${stylist.staffId}$`),
    );

    const org = await createLineChannel(t);
    await t.owner.patch(`/v1/line-channels/${org.id}`, { liffId: '1650000000-orgLiff1' });
    const viaOrg = await t.owner.get('/v1/walkin-intakes/reception-link', {
      shopId: t.shopId,
      staffId: stylist.staffId,
    });
    expect(viaOrg.body.liffId).toBe('1650000000-orgLiff1');
    expect(viaOrg.body.url).toBe(
      `https://liff.line.me/1650000000-orgLiff1/consent/${slug}?staff=${stylist.staffId}&walkin=1`,
    );
    expect(viaOrg.body.consentForms[1].url).toMatch(
      /^https:\/\/liff\.line\.me\/1650000000-orgLiff1\/consent\/.*form=.*&walkin=1$/,
    );

    const shopChannel = await createLineChannel(t, { shopId: t.shopId });
    await t.owner.patch(`/v1/line-channels/${shopChannel.id}`, { liffId: '1650000000-shopLiff' });
    const viaShop = await t.owner.get('/v1/walkin-intakes/reception-link', { shopId: t.shopId });
    expect(viaShop.body.url).toBe(
      `https://liff.line.me/1650000000-shopLiff/consent/${slug}?walkin=1`,
    );
  });

  it('keeps the verified LINE user on the intake and links it to the customer registered from it', async () => {
    const t = await createTenant();
    const slug = await shopSlug(t);
    const consent = await simpleConsent(t);
    await createLineChannel(t);
    const u = lineUserId();

    const res = await anon.post(`/v1/public/walkin/${slug}`, {
      templateId: consent.id,
      customer: person(),
      agreed: true,
      lineIdToken: `mock:${u}:はなこ`,
    });
    expect(res.status).toBe(201);
    expect(res.body.line).toBe(true);
    const items = (await t.owner.get('/v1/walkin-intakes', { shopId: t.shopId })).body.items;
    expect(items[0].line).toEqual({ display_name: 'はなこ' });
    expect((await t.owner.get(`/v1/walkin-intakes/${res.body.intakeId}`)).body.intake.line).toEqual(
      { display_name: 'はなこ', customer_id: null },
    );

    const created = await t.owner.post(`/v1/walkin-intakes/${res.body.intakeId}/create`, {});
    expect(created.status).toBe(201);
    expect(created.body.line).toMatchObject({ linked: true });
    const ids = await identitiesOf(t, created.body.customerId);
    expect(ids).toHaveLength(1);
    expect(ids[0]).toMatchObject({ external_id: u, display_name: 'はなこ', is_following: true });
  });

  it('links the LINE user to the existing customer the intake is linked to, but never takes it from another record', async () => {
    const t = await createTenant();
    const slug = await shopSlug(t);
    const consent = await simpleConsent(t);
    const ch = await createLineChannel(t);
    const customer = await createCustomer(t, {
      lastName: '来店',
      firstName: '花子',
      phone: '090-1111-2222',
    });

    const u = lineUserId();
    const first = await anon.post(`/v1/public/walkin/${slug}`, {
      templateId: consent.id,
      customer: person(),
      agreed: true,
      lineIdToken: `mock:${u}`,
    });
    const linked = await t.owner.post(`/v1/walkin-intakes/${first.body.intakeId}/link`, {
      customerId: customer.id,
    });
    expect(linked.status).toBe(200);
    expect(linked.body.line).toMatchObject({ linked: true });
    expect((await identitiesOf(t, customer.id)).map((i) => i.external_id)).toEqual([u]);

    // a LINE user that already is another customer record (a follower) is left alone → 統合候補
    const follower = await lineFollower(t, ch);
    const second = await anon.post(`/v1/public/walkin/${slug}`, {
      templateId: consent.id,
      customer: person(),
      agreed: true,
      lineIdToken: `mock:${follower.userId}`,
    });
    expect(
      (await t.owner.get(`/v1/walkin-intakes/${second.body.intakeId}`)).body.intake.line
        .customer_id,
    ).toBe(follower.customerId);
    const other = await t.owner.post(`/v1/walkin-intakes/${second.body.intakeId}/link`, {
      customerId: customer.id,
    });
    expect(other.status).toBe(200);
    expect(other.body.line).toEqual({
      linked: false,
      reason: 'already_linked',
      conflictCustomerId: follower.customerId,
    });
    expect((await identitiesOf(t, follower.customerId)).map((i) => i.external_id)).toEqual([
      follower.userId,
    ]);
    expect((await identitiesOf(t, customer.id)).map((i) => i.external_id)).toEqual([u]);
  });

  it('accepts the reception without LINE when the id token does not verify or LINE is not set up', async () => {
    const t = await createTenant();
    const slug = await shopSlug(t);
    const consent = await simpleConsent(t);
    // no LINE account
    const none = await anon.post(`/v1/public/walkin/${slug}`, {
      templateId: consent.id,
      customer: person(),
      agreed: true,
      lineIdToken: `mock:${lineUserId()}`,
    });
    expect(none.status).toBe(201);
    expect(none.body.line).toBe(false);

    await createLineChannel(t);
    const bad = await anon.post(`/v1/public/walkin/${slug}`, {
      templateId: consent.id,
      customer: person(),
      agreed: true,
      lineIdToken: 'garbage-token',
    });
    expect(bad.status).toBe(201);
    expect(bad.body.line).toBe(false);
    const created = await t.owner.post(`/v1/walkin-intakes/${bad.body.intakeId}/create`, {});
    expect(created.body.line).toBeNull();
    expect(await identitiesOf(t, created.body.customerId)).toHaveLength(0);
  });
});
