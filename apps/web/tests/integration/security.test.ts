import { afterEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@salonos/db';
import { createAppointment } from '@/lib/server/booking';
import { secret } from '@/lib/server/env';
import { getIntegration, writeConfig } from '@/lib/server/integrations';
import { stripeConfig } from '@/lib/server/payments/stripe';
import { squareConfig } from '@/lib/server/payments/square';
import { findLineIntegrationByKey, lineAccessToken, lineChannelSecret } from '@/lib/server/line';
import { requestPiiUnlockOtp, verifyPiiUnlockOtp } from '@/lib/server/pii';
import type { StaffContext } from '@/lib/server/session';
import { safeNextPath } from '@/lib/safe-redirect';
import { futureDate, makeOrg } from './helpers';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('L2: appointment manage tokens are cryptographically random', () => {
  it('createAppointment sets a 192-bit random token; raw inserts get a random DB default', async () => {
    const { org, shop } = await makeOrg();
    const start = new Date(`${futureDate(2)}T02:00:00Z`);
    const tokens = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const { appointmentId } = await createAppointment({ orgId: org.id, shopId: shop.id, startAt: new Date(start.getTime() + i * 3600000), menus: [{ name: 'x', price: 1, durationMin: 30 }] });
      const a = await prisma.appointment.findUniqueOrThrow({ where: { id: appointmentId } });
      expect(a.manageToken).toMatch(/^[A-Za-z0-9_-]{32}$/); // randomToken(24), base64url
      expect(a.manageToken).not.toMatch(/^c[a-z0-9]{24}$/); // not a cuid
      tokens.add(a.manageToken);
    }
    expect(tokens.size).toBe(3);
    const raw = await prisma.appointment.create({ data: { organizationId: org.id, shopId: shop.id, startAt: start, endAt: new Date(start.getTime() + 60000), status: 'CANCELLED' } });
    expect(raw.manageToken).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('L4: production never uses built-in secrets', () => {
  it('throws without a value in production, even with DEMO_MODE=1', () => {
    vi.stubEnv('DEMO_MODE', '1');
    vi.stubEnv('SOME_TEST_SECRET', '');
    expect(() => secret('SOME_TEST_SECRET', 'dev-default', true)).toThrow(/required in production/);
    vi.stubEnv('SOME_TEST_SECRET', 'dev-default');
    expect(() => secret('SOME_TEST_SECRET', 'dev-default', true)).toThrow(/development default/);
    vi.stubEnv('SOME_TEST_SECRET', 'a-real-random-secret-value');
    expect(secret('SOME_TEST_SECRET', 'dev-default', true)).toBe('a-real-random-secret-value');
    vi.stubEnv('SOME_TEST_SECRET', '');
    expect(secret('SOME_TEST_SECRET', 'dev-default', false)).toBe('dev-default'); // development only
  });
});

describe('L5: login next is a same-origin path', () => {
  it('rejects external and scheme-relative targets', () => {
    for (const bad of ['https://evil.example', '//evil.example', '/\\evil.example', '\\\\evil.example', '/\t/evil.example', 'javascript:alert(1)', '', null, undefined, 42]) {
      expect(safeNextPath(bad)).toBe('/dashboard');
    }
    expect(safeNextPath('/customers/abc?tab=karte')).toBe('/customers/abc?tab=karte');
    expect(safeNextPath('/')).toBe('/');
  });
});

describe('L6: provider configuration never falls back to another account', () => {
  it('getIntegration: exact shop, then org-level, never another shop', async () => {
    const { org, shop } = await makeOrg();
    const shopB = await prisma.shop.create({ data: { organizationId: org.id, name: 'B', slug: `l6-${Date.now().toString(36)}` } });
    const b = await prisma.integration.create({ data: { organizationId: org.id, shopId: shopB.id, provider: 'STRIPE', configEnc: writeConfig({ secretKey: 'sk_shop_b' }) } });
    expect(await getIntegration(org.id, 'STRIPE', shop.id)).toBeNull();
    expect(await getIntegration(org.id, 'STRIPE')).toBeNull();
    expect((await getIntegration(org.id, 'STRIPE', shopB.id))?.integration.id).toBe(b.id);
    const orgLevel = await prisma.integration.create({ data: { organizationId: org.id, provider: 'STRIPE', configEnc: writeConfig({ secretKey: 'sk_org' }) } });
    expect((await getIntegration(org.id, 'STRIPE', shop.id))?.integration.id).toBe(orgLevel.id);
    expect((await getIntegration(org.id, 'STRIPE', shopB.id))?.integration.id).toBe(b.id);
    expect((await stripeConfig(org.id, shop.id)).secretKey).toBe('sk_org');
  });

  it('a PAUSED Stripe/Square integration does not fall back to env keys', async () => {
    const { org, shop } = await makeOrg();
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_platform_env');
    vi.stubEnv('SQUARE_ACCESS_TOKEN', 'sq_platform_env');
    expect((await stripeConfig(org.id, shop.id)).live).toBe(true); // no row: env (single-account deployment)
    await prisma.integration.create({ data: { organizationId: org.id, provider: 'STRIPE', status: 'PAUSED', configEnc: writeConfig({ secretKey: 'sk_org' }) } });
    await prisma.integration.create({ data: { organizationId: org.id, provider: 'SQUARE', status: 'PAUSED', configEnc: writeConfig({ accessToken: 'sq_org' }) } });
    const s = await stripeConfig(org.id, shop.id);
    expect(s).toMatchObject({ live: false, secretKey: '' });
    const q = await squareConfig(org.id, shop.id);
    expect(q).toMatchObject({ live: false, accessToken: '' });
  });

  it('LINE: PAUSED integrations are not addressable; own-credential rows never use env secrets', async () => {
    const { org } = await makeOrg();
    vi.stubEnv('LINE_CHANNEL_SECRET', 'env-channel-secret');
    vi.stubEnv('LINE_MESSAGING_CHANNEL_ACCESS_TOKEN', 'env-token');
    const own = await prisma.integration.create({ data: { organizationId: org.id, provider: 'LINE', configEnc: writeConfig({ channelAccessToken: 'own-token' }) } });
    const ref = await findLineIntegrationByKey(own.webhookKey);
    expect(ref).not.toBeNull();
    expect(lineChannelSecret(ref!)).toBe(''); // has own credentials but no secret → reject, don't use env
    expect(lineAccessToken(ref!)).toBe('own-token');
    const placeholder = await prisma.integration.create({ data: { organizationId: org.id, provider: 'LINE', configEnc: writeConfig({}) } });
    const pref = await findLineIntegrationByKey(placeholder.webhookKey);
    expect(lineChannelSecret(pref!)).toBe('env-channel-secret'); // credential-less row = deployment channel
    await prisma.integration.update({ where: { id: own.id }, data: { status: 'PAUSED', configEnc: writeConfig({ channelSecret: 's', channelAccessToken: 't' }) } });
    expect(await findLineIntegrationByKey(own.webhookKey)).toBeNull();
  });
});

describe('L7: PII unlock OTP is emailed to the user and not logged in production', () => {
  async function ctxFor() {
    const { org, shop, staff } = await makeOrg();
    const user = await prisma.user.findUniqueOrThrow({ where: { id: staff[1].userId } });
    return {
      sessionId: 's', user: { id: user.id, name: user.name, email: user.email }, org: { id: org.id, name: org.name, slug: org.slug },
      membership: { id: staff[1].membershipId, role: 'STYLIST', canViewPII: false, displayName: 'x' }, role: 'STYLIST',
      shop: shop as any, shops: [shop as any], can: () => true, piiByDefault: false,
    } as unknown as StaffContext;
  }

  it('production: sends the code by email, never logs it, never returns it', async () => {
    const ctx = await ctxFor();
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('DEMO_MODE', '');
    vi.stubEnv('RESEND_API_KEY', 're_test_key');
    const sent: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => { sent.push({ url, body: JSON.parse(String(init?.body)) }); return new Response(JSON.stringify({ id: 'em_1' }), { status: 200 }); }));
    const logs: string[] = [];
    vi.spyOn(console, 'info').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
    const r = await requestPiiUnlockOtp(ctx);
    expect(r).toEqual({});
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toContain('api.resend.com');
    expect(sent[0].body.to).toBe(ctx.user.email);
    const code = /確認コード：(\d+)/.exec(sent[0].body.text)?.[1];
    expect(code).toBeTruthy();
    expect(logs.join('\n')).not.toContain(code!);
    vi.unstubAllEnvs();
    await verifyPiiUnlockOtp(ctx, code!, 'テスト');
    expect(await prisma.piiUnlock.count({ where: { userId: ctx.user.id } })).toBe(1);
  });

  it('production without an email provider refuses instead of silently dropping the code', async () => {
    const ctx = await ctxFor();
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('DEMO_MODE', '');
    vi.stubEnv('RESEND_API_KEY', '');
    await expect(requestPiiUnlockOtp(ctx)).rejects.toThrow(/メール送信が設定されていない/);
  });

  it('demo mode: code is returned for on-screen display', async () => {
    const ctx = await ctxFor();
    vi.stubEnv('RESEND_API_KEY', '');
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const r = await requestPiiUnlockOtp(ctx);
    expect(r.devCode).toMatch(/^\d{6}$/);
  });
});
