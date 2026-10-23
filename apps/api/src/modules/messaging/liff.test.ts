import { beforeEach, describe, expect, it } from 'vitest';
import {
  api,
  createCustomer,
  createLineChannel,
  createTenant,
  lineUserId,
  shopSlug,
} from '../../test/helpers.js';
import { lineMock } from './providers/line.js';

beforeEach(() => lineMock.reset());
const anon = api();

describe('LIFF configuration (public)', () => {
  it('gives the LIFF ID and 友だち追加URL of the shop: shop channel first, then the organization channel', async () => {
    const t = await createTenant();
    const slug = await shopSlug(t);
    const empty = await anon.get('/v1/public/line/liff', { shop: slug });
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ liffId: null, friendUrl: null });
    expect((await anon.get('/v1/public/line/liff', { shop: 'no-such-shop' })).status).toBe(404);
    expect((await anon.get('/v1/public/line/liff')).body).toEqual({
      liffId: null,
      friendUrl: null,
    });

    const org = await createLineChannel(t);
    const patched = await t.owner.patch(`/v1/line-channels/${org.id}`, {
      liffId: '1650000000-orgLiff1',
      friendUrl: 'https://lin.ee/orgFriend',
    });
    expect(patched.status).toBe(200);
    expect(patched.body.friend_url).toBe('https://lin.ee/orgFriend');
    // what to enter as the LIFF app's endpoint URL: the web root
    expect(patched.body.liffEndpointUrl).toMatch(/^https?:\/\/[^/]+\/$/);
    const viaOrg = await anon.get('/v1/public/line/liff', { shop: slug });
    expect(viaOrg.body).toEqual({
      liffId: '1650000000-orgLiff1',
      friendUrl: 'https://lin.ee/orgFriend',
    });
    // nothing secret leaves the API
    expect(JSON.stringify(viaOrg.body)).not.toContain(org.secret);
    expect(JSON.stringify(viaOrg.body)).not.toContain(org.channelId);

    const shop = await createLineChannel(t, { shopId: t.shopId });
    await t.owner.patch(`/v1/line-channels/${shop.id}`, {
      liffId: '1650000000-shopLiff',
      friendUrl: 'https://lin.ee/shopFriend',
    });
    expect((await anon.get('/v1/public/line/liff', { shop: slug })).body).toEqual({
      liffId: '1650000000-shopLiff',
      friendUrl: 'https://lin.ee/shopFriend',
    });
  });

  it('rejects a 友だち追加URL that is not a LINE link', async () => {
    const t = await createTenant();
    const ch = await createLineChannel(t);
    expect(
      (await t.owner.patch(`/v1/line-channels/${ch.id}`, { friendUrl: 'https://example.com/add' }))
        .status,
    ).toBe(400);
    expect(
      (await t.owner.patch(`/v1/line-channels/${ch.id}`, { friendUrl: 'http://lin.ee/abc' }))
        .status,
    ).toBe(400);
    expect((await t.owner.patch(`/v1/line-channels/${ch.id}`, { friendUrl: null })).status).toBe(
      200,
    );
  });

  it('opens the account link inside LINE and finds its LIFF app from the link token', async () => {
    const t = await createTenant();
    const ch = await createLineChannel(t);
    await t.owner.patch(`/v1/line-channels/${ch.id}`, {
      liffId: '1650000000-linkLiff',
      friendUrl: 'https://lin.ee/linkFriend',
    });
    const customer = await createCustomer(t);
    const issued = await t.owner.post(`/v1/customers/${customer.id}/line-link-token`, {});
    expect(issued.status).toBe(201);
    expect(issued.body.url).toBe(
      `https://liff.line.me/1650000000-linkLiff/line/link?linkToken=${encodeURIComponent(issued.body.token)}&liffId=1650000000-linkLiff`,
    );

    const cfg = await anon.get('/v1/public/line/liff', { linkToken: issued.body.token });
    expect(cfg.status).toBe(200);
    expect(cfg.body).toEqual({
      liffId: '1650000000-linkLiff',
      friendUrl: 'https://lin.ee/linkFriend',
    });
    expect((await anon.get('/v1/public/line/liff', { linkToken: 'x'.repeat(32) })).status).toBe(
      401,
    );

    // the config lookup does not use up the one-time link
    const res = await anon.post('/v1/public/line-link', {
      token: issued.body.token,
      idToken: `mock:${lineUserId()}:花子`,
    });
    expect(res.status).toBe(200);
    expect(res.body.linked).toBe(true);
  });
});
