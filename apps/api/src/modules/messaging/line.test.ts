import { beforeEach, describe, expect, it } from 'vitest';
import {
  api,
  asSystem,
  createCustomer,
  createLineChannel,
  createStaffUser,
  createTenant,
  deliverWebhook,
  lineEvent,
  lineFollower,
  lineUserId,
  messagesOf,
  runJobs,
  signedDelivery,
  textEvent,
} from '../../test/helpers.js';
import { getWebhookProvider } from '../../lib/webhooks.js';
import { lineMock } from './providers/line.js';
import { verifyLineWebhook } from './webhook.js';

beforeEach(() => lineMock.reset());

describe('LINE channels', () => {
  it('stores secrets encrypted, masks them in responses and verifies credentials', async () => {
    const t = await createTenant();
    const ch = await createLineChannel(t);
    const list = await t.owner.get('/v1/line-channels');
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    const item = list.body[0];
    expect(item.bot_user_id).toBe(ch.botUserId);
    expect(item.channelSecretMasked).toBe(`****${ch.secret.slice(-4)}`);
    expect(item.accessTokenMasked).toBe(`****${ch.accessToken.slice(-4)}`);
    expect(JSON.stringify(list.body)).not.toContain(ch.secret);
    expect(JSON.stringify(list.body)).not.toContain(ch.accessToken);
    expect(item).not.toHaveProperty('encrypted_channel_secret');

    const raw = await asSystem(t.organizationId, (ctx) => ctx.trx.selectFrom('line_channels').selectAll().where('id', '=', ch.id).executeTakeFirstOrThrow());
    expect(raw.encrypted_channel_secret).not.toContain(ch.secret);
    expect(raw.encrypted_channel_secret.startsWith('v1.')).toBe(true);

    const verify = await t.owner.post(`/v1/line-channels/${ch.id}/verify`);
    expect(verify.status).toBe(200);
    expect(verify.body.botUserId).toBe(ch.botUserId);

    // rotate an invalid token → verify fails with a business error
    lineMock.invalidTokens.add('invalid-token-123');
    await t.owner.patch(`/v1/line-channels/${ch.id}`, { accessToken: 'invalid-token-123' });
    const bad = await t.owner.post(`/v1/line-channels/${ch.id}/verify`);
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('LINE_CREDENTIALS_INVALID');

    // audit never contains the secret
    const logs = await asSystem(t.organizationId, (ctx) => ctx.trx.selectFrom('audit_logs').select(['after']).where('resource_type', '=', 'line_channel').execute());
    expect(JSON.stringify(logs)).not.toContain(ch.secret);
    expect(JSON.stringify(logs)).not.toContain('invalid-token-123');
  });

  it('supports org-level and shop-level channels, one active each', async () => {
    const t = await createTenant();
    await createLineChannel(t);
    const shopLevel = await createLineChannel(t, { shopId: t.shopId });
    expect(shopLevel.id).toBeTruthy();
    const dup = await t.owner.post('/v1/line-channels', { channelId: 'dup-x', name: 'x', channelSecret: 'secret-xxxxxxxx', accessToken: 'token-xxxxxxxx' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('LINE_CHANNEL_EXISTS');
  });

  it('requires integration.manage and isolates tenants', async () => {
    const t = await createTenant();
    const other = await createTenant();
    const ch = await createLineChannel(t);
    const stylist = await createStaffUser(t, 'stylist');
    expect((await stylist.api.get('/v1/line-channels')).status).toBe(403);
    expect((await stylist.api.post('/v1/line-channels', { channelId: 'a', name: 'a', channelSecret: 'secret-xxxxxxxx', accessToken: 'token-xxxxxxxx' })).status).toBe(403);
    expect((await other.owner.get(`/v1/line-channels/${ch.id}`)).status).toBe(404);
    expect((await other.owner.get('/v1/line-channels')).body).toHaveLength(0);
    // manager limited to a shop cannot configure the org-level account
    const manager = await createStaffUser(t, 'manager');
    expect((await manager.api.patch(`/v1/line-channels/${ch.id}`, { name: 'x' })).status).toBe(403);
  });
});

describe('LINE webhook', () => {
  it('registers the line provider', () => {
    expect(getWebhookProvider('line')).toBeTruthy();
  });

  it('verifies x-line-signature and splits deliveries into events', async () => {
    const t = await createTenant();
    const ch = await createLineChannel(t);
    const u = lineUserId();
    const events = [lineEvent('follow', u), textEvent(u, 'こんにちは')];
    const ok = await verifyLineWebhook(signedDelivery(ch, events));
    expect(ok.signatureValid).toBe(true);
    expect(ok.organizationId).toBe(t.organizationId);
    expect(ok.events).toHaveLength(2);
    expect(ok.events![0]!.eventId).toBe(events[0]!.webhookEventId);
    expect(ok.events![1]!.eventType).toBe('message');

    const badSecret = await verifyLineWebhook(signedDelivery(ch, events, { secret: 'wrong-secret' }));
    expect(badSecret.signatureValid).toBe(false);
    const tampered = signedDelivery(ch, events);
    const tamperedBody = tampered.rawBody.replace('こんにちは', 'さようなら');
    expect((await verifyLineWebhook({ ...tampered, rawBody: tamperedBody, body: JSON.parse(tamperedBody) })).signatureValid).toBe(false);
    const noSig = signedDelivery(ch, events);
    expect((await verifyLineWebhook({ ...noSig, headers: {} })).signatureValid).toBe(false);
    const unknown = await verifyLineWebhook(signedDelivery(ch, events, { destination: 'Uunknown' }));
    expect(unknown.signatureValid).toBe(false);
    expect(unknown.organizationId).toBeNull();

    // console "verify" (empty events) marks the webhook as verified
    expect((await verifyLineWebhook(signedDelivery(ch, []))).signatureValid).toBe(true);
    const row = await asSystem(t.organizationId, (ctx) => ctx.trx.selectFrom('line_channels').select('webhook_verified_at').where('id', '=', ch.id).executeTakeFirstOrThrow());
    expect(row.webhook_verified_at).not.toBeNull();
  });

  it('follow creates a customer with a following identity; unfollow disables LINE delivery', async () => {
    const t = await createTenant();
    const ch = await createLineChannel(t);
    const u = lineUserId();
    lineMock.profiles.set(u, { displayName: 'はなこ' });
    const { results } = await deliverWebhook(t, ch, [lineEvent('follow', u)]);
    expect(results).toEqual(['processed']);
    const identity = await asSystem(t.organizationId, (ctx) =>
      ctx.trx.selectFrom('customer_identities').selectAll().where('external_id', '=', u).executeTakeFirstOrThrow(),
    );
    expect(identity.provider).toBe('line');
    expect(identity.provider_account_id).toBe(ch.channelId);
    expect(identity.is_following).toBe(true);
    expect(identity.display_name).toBe('はなこ');
    const customer = (await t.owner.get(`/v1/customers/${identity.customer_id}`)).body;
    expect(customer.first_name).toBe('はなこ');
    expect(customer.acquisition_source).toBe('line');

    // same user follows again → same customer (no duplicate)
    await deliverWebhook(t, ch, [lineEvent('follow', u)]);
    const count = await asSystem(t.organizationId, (ctx) => ctx.trx.selectFrom('customers').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow());
    expect(Number(count.n)).toBe(1);

    await deliverWebhook(t, ch, [lineEvent('unfollow', u)]);
    const after = await asSystem(t.organizationId, (ctx) => ctx.trx.selectFrom('customer_identities').select('is_following').where('id', '=', identity.id).executeTakeFirstOrThrow());
    expect(after.is_following).toBe(false);
    const prefs = (await t.owner.get(`/v1/customers/${identity.customer_id}/channel-preferences`)).body;
    const line = prefs.channels.find((c: { channel: string }) => c.channel === 'line');
    expect(line).toMatchObject({ marketingAllowed: false, transactionalAllowed: false, source: 'unfollow' });

    // re-follow restores
    await deliverWebhook(t, ch, [lineEvent('follow', u)]);
    const prefs2 = (await t.owner.get(`/v1/customers/${identity.customer_id}/channel-preferences`)).body;
    expect(prefs2.channels.find((c: { channel: string }) => c.channel === 'line')).toMatchObject({ marketingAllowed: true, transactionalAllowed: true });
  });

  it('sends the welcome message only when the welcome template is active', async () => {
    const t = await createTenant();
    const ch = await createLineChannel(t);
    const first = await lineFollower(t, ch);
    await runJobs();
    expect(lineMock.sentTo(first.userId)).toHaveLength(0);

    const welcome = (await t.owner.get('/v1/message-templates', { key: 'welcome', channel: 'line' })).body[0];
    await t.owner.patch(`/v1/message-templates/${welcome.id}`, { status: 'active' });
    const second = await lineFollower(t, ch);
    await runJobs();
    const sent = lineMock.sentTo(second.userId);
    expect(sent).toHaveLength(1);
    expect((sent[0]!.messages[0] as { text: string }).text).toContain('友だち追加ありがとうございます');
    expect(sent[0]!.accessToken).toBe(ch.accessToken);
  });

  it('stores inbound text/image/sticker/postback messages and dedupes redeliveries', async () => {
    const t = await createTenant();
    const ch = await createLineChannel(t);
    const { userId, customerId } = await lineFollower(t, ch);
    const text = textEvent(userId, '明日の予約を変更したいです');
    const image = lineEvent('message', userId, { message: { id: 'img1', type: 'image', contentProvider: { type: 'line' } } });
    const sticker = lineEvent('message', userId, { message: { id: 'st1', type: 'sticker', packageId: '1', stickerId: '2' } });
    const postback = lineEvent('postback', userId, { postback: { data: 'action=reserve&menu=cut' } });
    await deliverWebhook(t, ch, [text, image, sticker, postback]);
    // redelivery of the same webhook event is ignored
    const again = await deliverWebhook(t, ch, [text]);
    expect(again.results).toEqual(['ignored']);

    const msgs = (await messagesOf(t, customerId)).filter((m) => m.direction === 'inbound');
    expect(msgs.map((m) => m.message_type)).toEqual(['text', 'image', 'sticker', 'postback']);
    expect(msgs[0]).toMatchObject({ channel: 'line', category: 'conversation', status: 'received', body: '明日の予約を変更したいです', line_channel_id: ch.id });
    expect(msgs[3]!.body).toBe('action=reserve&menu=cut');

    const events = await asSystem(t.organizationId, (ctx) => ctx.trx.selectFrom('domain_events').select('event_type').where('event_type', '=', 'message.received').execute());
    expect(events).toHaveLength(4);

    // a message from an unknown user (friend before integration) creates the customer
    const stranger = lineUserId();
    await deliverWebhook(t, ch, [textEvent(stranger, 'はじめまして')]);
    const sid = await asSystem(t.organizationId, (ctx) => ctx.trx.selectFrom('customer_identities').select('customer_id').where('external_id', '=', stranger).executeTakeFirstOrThrow());
    expect((await messagesOf(t, sid.customer_id))[0]!.body).toBe('はじめまして');
  });

  it('ignores events for users without userId and unknown types', async () => {
    const t = await createTenant();
    const ch = await createLineChannel(t);
    const group = { ...lineEvent('message', 'x'), source: { type: 'group', groupId: 'G1' } };
    const { results } = await deliverWebhook(t, ch, [group, lineEvent('beacon', lineUserId())]);
    expect(results).toEqual(['ignored', 'ignored']);
  });
});

describe('LINE account linking', () => {
  it('links an existing customer via staff-issued token + LIFF id token', async () => {
    const t = await createTenant();
    const ch = await createLineChannel(t);
    const customer = await createCustomer(t, { lastName: '来店', firstName: '花子', phone: '090-1111-2222' });
    const issued = await t.owner.post(`/v1/customers/${customer.id}/line-link-token`, {});
    expect(issued.status).toBe(201);
    expect(issued.body.url).toContain(encodeURIComponent(issued.body.token));
    expect(issued.body.lineChannelId).toBe(ch.id);

    const u = lineUserId();
    const bad = await api().post('/v1/public/line-link', { token: issued.body.token, idToken: 'garbage' });
    expect(bad.status).toBe(401);
    // a failed id token check does not burn the one-time token
    const res = await api().post('/v1/public/line-link', { token: issued.body.token, idToken: `mock:${u}:花子` });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ linked: true, customerId: customer.id, following: true });
    const detail = (await t.owner.get(`/v1/customers/${customer.id}`)).body;
    expect(detail.identities).toHaveLength(1);
    expect(detail.identities[0].provider).toBe('line');
    expect(detail.identities[0].is_following).toBe(true);

    // single use
    const reuse = await api().post('/v1/public/line-link', { token: issued.body.token, idToken: `mock:${u}:花子` });
    expect(reuse.status).toBe(401);

    // linked customer now receives LINE messages
    await t.owner.post('/v1/messages/send', { customerId: customer.id, body: '{{customer.name}}様、連携ありがとうございます' });
    await runJobs();
    expect((lineMock.sentTo(u)[0]!.messages[0] as { text: string }).text).toBe('来店 花子様、連携ありがとうございます');
  });

  it('returns a conflict (merge suggestion) when the LINE user belongs to another customer', async () => {
    const t = await createTenant();
    const ch = await createLineChannel(t);
    const existing = await lineFollower(t, ch);
    const customer = await createCustomer(t, { lastName: '電話', firstName: '予約' });
    const issued = await t.owner.post(`/v1/customers/${customer.id}/line-link-token`, {});
    const res = await api().post('/v1/public/line-link', { token: issued.body.token, idToken: `mock:${existing.userId}` });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('LINE_ALREADY_LINKED');
    expect(res.body.error.details.suggestion).toBe('merge');
    const log = await asSystem(t.organizationId, (ctx) =>
      ctx.trx.selectFrom('audit_logs').select(['metadata']).where('action', '=', 'customer.line_link_conflict').executeTakeFirstOrThrow(),
    );
    expect((log.metadata as { existingCustomerId: string }).existingCustomerId).toBe(existing.customerId);
  });

  it('links through the accountLink webhook event (nonce = link token)', async () => {
    const t = await createTenant();
    const ch = await createLineChannel(t);
    const customer = await createCustomer(t);
    const issued = await t.owner.post(`/v1/customers/${customer.id}/line-link-token`, {});
    const u = lineUserId();
    const { results } = await deliverWebhook(t, ch, [lineEvent('accountLink', u, { link: { result: 'ok', nonce: issued.body.token } })]);
    expect(results).toEqual(['processed']);
    const identity = await asSystem(t.organizationId, (ctx) => ctx.trx.selectFrom('customer_identities').selectAll().where('external_id', '=', u).executeTakeFirstOrThrow());
    expect(identity.customer_id).toBe(customer.id);
  });

  it('requires customer.write and a configured LINE account', async () => {
    const t = await createTenant();
    const customer = await createCustomer(t);
    const none = await t.owner.post(`/v1/customers/${customer.id}/line-link-token`, {});
    expect(none.status).toBe(422);
    expect(none.body.error.code).toBe('LINE_NOT_CONFIGURED');
    await createLineChannel(t);
    const assistant = await createStaffUser(t, 'assistant');
    expect((await assistant.api.post(`/v1/customers/${customer.id}/line-link-token`, {})).status).toBe(403);
    const other = await createTenant();
    expect((await other.owner.post(`/v1/customers/${customer.id}/line-link-token`, {})).status).toBe(404);
  });
});
