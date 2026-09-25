import { describe, expect, it } from 'vitest';
import { prisma } from '@salonos/db';
import { hmacBase64 } from '@salonos/core/crypto';
import { normalizeLineWebhook, verifyLineSignature } from '@salonos/core/integrations/line';
import { assertSegmentScope, executeBroadcast, listConversations, normalizeSegment, retryMessage, segmentRecipients, startBroadcast } from '@/lib/server/messaging';
import { processScheduledBroadcasts, runAutomations } from '@/lib/server/automation';
import { buildBookingRichMenu, handleLineEvents, type LineIntegrationRef } from '@/lib/server/line';
import { submitReview, reviewStats } from '@/lib/server/reviews';
import { piiColumns } from '@/lib/server/pii';
import { verifyLineLink } from '@/lib/server/line-link';
import { makeOrg } from './helpers';

const DAY = 86400000;
const HOUR = 3600000;

async function customer(orgId: string, data: Record<string, unknown> = {}, lineId?: string | null) {
  const c = await prisma.customer.create({ data: { organizationId: orgId, lastName: '山田', firstName: `花子${Math.random().toString(36).slice(2, 6)}`, ...data } as any });
  if (lineId) await prisma.customerIdentity.create({ data: { organizationId: orgId, customerId: c.id, provider: 'LINE', externalId: lineId } });
  return c;
}

let seq = 0;
const uid = () => `U${Date.now().toString(16)}${(seq++).toString(16).padStart(4, '0')}`;

describe('segment recipients', () => {
  it('evaluates segment and excludes opted-out / unreachable customers', async () => {
    const { org, shop, staff } = await makeOrg();
    const vip = await prisma.tag.create({ data: { organizationId: org.id, name: 'VIP' } });
    const now = new Date();
    const a = await customer(org.id, { lastVisitAt: new Date(now.getTime() - 40 * DAY), visitCount: 3, tags: { create: { tagId: vip.id } }, primaryShopId: shop.id }, uid());
    await customer(org.id, { lastVisitAt: new Date(now.getTime() - 40 * DAY), visitCount: 3, lineOptIn: false, tags: { create: { tagId: vip.id } } }, uid()); // opted out
    await customer(org.id, { lastVisitAt: new Date(now.getTime() - 40 * DAY), visitCount: 3, tags: { create: { tagId: vip.id } } }); // no LINE
    await customer(org.id, { lastVisitAt: new Date(now.getTime() - 5 * DAY), visitCount: 3, tags: { create: { tagId: vip.id } } }, uid()); // too recent
    await customer(org.id, { lastVisitAt: new Date(now.getTime() - 40 * DAY), visitCount: 1, tags: { create: { tagId: vip.id } } }, uid()); // too few visits
    const email = await customer(org.id, { lastVisitAt: new Date(now.getTime() - 40 * DAY), visitCount: 5, assignedStaffId: staff[1].userId, ...piiColumns({ email: 'a@example.com' }) });

    const seg = normalizeSegment({ tagIds: [vip.id], lastVisitDaysMin: '30', lastVisitDaysMax: 90, minVisits: 2 });
    const r = await segmentRecipients(org.id, seg, 'LINE', now);
    expect(r.ids).toEqual([a.id]);
    expect(r.matched).toBe(3);
    expect(r.optedOut).toBe(1);
    expect(r.noContact).toBe(1);

    const byStaff = await segmentRecipients(org.id, normalizeSegment({ staffId: staff[1].userId }), 'EMAIL', now);
    expect(byStaff.ids).toEqual([email.id]);
    const byShop = await segmentRecipients(org.id, normalizeSegment({ shopId: shop.id }), 'LINE', now);
    expect(byShop.ids).toEqual([a.id]);
  });

  it('sends a broadcast once per recipient, renders variables and records counts', async () => {
    const { org, shop } = await makeOrg();
    const c1 = await customer(org.id, {}, uid());
    const c2 = await customer(org.id, {}, uid());
    await customer(org.id, { lineOptIn: false }, uid());
    const b = await prisma.broadcast.create({ data: { organizationId: org.id, shopId: shop.id, name: 'テスト', body: '{{customer_name}}様 {{shop_name}}より', segment: {}, status: 'DRAFT' } });
    const r = await startBroadcast(org.id, b.id);
    expect(r).toMatchObject({ sent: 2, failed: 0, total: 2 });
    expect(await startBroadcast(org.id, b.id)).toBeNull(); // already claimed
    const msgs = await prisma.message.findMany({ where: { broadcastId: b.id }, orderBy: { createdAt: 'asc' } });
    expect(msgs.map((m) => m.customerId).sort()).toEqual([c1.id, c2.id].sort());
    expect(msgs[0].body).toContain('様 Shopより');
    const after = await prisma.broadcast.findUniqueOrThrow({ where: { id: b.id } });
    expect(after).toMatchObject({ status: 'SENT', recipientCount: 2 });
  });

  it('processes due scheduled broadcasts and resumes without double-sending', async () => {
    const { org } = await makeOrg();
    await customer(org.id, {}, uid());
    await customer(org.id, {}, uid());
    const b = await prisma.broadcast.create({ data: { organizationId: org.id, name: '予約配信', body: 'hi', segment: {}, status: 'SCHEDULED', scheduledAt: new Date(Date.now() - 60000) } });
    const future = await prisma.broadcast.create({ data: { organizationId: org.id, name: '未来', body: 'hi', segment: {}, status: 'SCHEDULED', scheduledAt: new Date(Date.now() + HOUR) } });
    await processScheduledBroadcasts(new Date(), org.id);
    expect((await prisma.broadcast.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('SENT');
    expect((await prisma.broadcast.findUniqueOrThrow({ where: { id: future.id } })).status).toBe('SCHEDULED');
    // simulate interrupted run → resume must not re-send
    await prisma.broadcast.update({ where: { id: b.id }, data: { status: 'SENDING' } });
    const r = await executeBroadcast(org.id, b.id);
    expect(r.sent).toBe(0);
    expect(await prisma.message.count({ where: { broadcastId: b.id } })).toBe(2);
  });
});

describe('automations', () => {
  async function appt(orgId: string, shopId: string, customerId: string, startAt: Date, status: any = 'CONFIRMED', durMin = 60) {
    return prisma.appointment.create({ data: { organizationId: orgId, shopId, customerId, startAt, endAt: new Date(startAt.getTime() + durMin * 60000), status, menus: { create: { name: 'カット', price: 5500, durationMin: durMin } } } });
  }

  it('REMINDER_BEFORE: only appointments within the window; running twice sends once', async () => {
    const { org, shop } = await makeOrg();
    const now = new Date();
    const c = await customer(org.id, {}, uid());
    const inWindow = await appt(org.id, shop.id, c.id, new Date(now.getTime() + 20 * HOUR));
    await appt(org.id, shop.id, c.id, new Date(now.getTime() + 30 * HOUR)); // outside 24h
    await appt(org.id, shop.id, c.id, new Date(now.getTime() + 2 * HOUR), 'CANCELLED'); // cancelled
    await appt(org.id, shop.id, c.id, new Date(now.getTime() - 2 * HOUR)); // past
    const rule = await prisma.automationRule.create({ data: { organizationId: org.id, name: '前日リマインド', trigger: 'REMINDER_BEFORE', offsetValue: 24, body: '{{customer_name}}様 {{time}}にお待ちしております {{manage_url}}' } });

    const s1 = await runAutomations(now, org.id);
    expect(s1.sent).toBe(1);
    const s2 = await runAutomations(new Date(now.getTime() + 60000), org.id);
    expect(s2.dispatched).toBe(0);
    const msgs = await prisma.message.findMany({ where: { automationRuleId: rule.id } });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].appointmentId).toBe(inWindow.id);
    expect(msgs[0].body).toContain(`/booking/${inWindow.manageToken}`);
    const d = await prisma.automationDispatch.findMany({ where: { ruleId: rule.id } });
    expect(d).toHaveLength(1);
    expect(d[0].dedupeKey).toBe(`${rule.id}:${inWindow.id}`);
    expect((await prisma.automationRule.findUniqueOrThrow({ where: { id: rule.id } })).lastRunAt).not.toBeNull();
  });

  it('VISIT_CYCLE: excludes customers with a future booking; dedupes per last visit', async () => {
    const { org, shop } = await makeOrg();
    const now = new Date();
    const due = await customer(org.id, { lastVisitAt: new Date(now.getTime() - 50 * DAY) }, uid());
    const booked = await customer(org.id, { lastVisitAt: new Date(now.getTime() - 50 * DAY) }, uid());
    await customer(org.id, { lastVisitAt: new Date(now.getTime() - 10 * DAY) }, uid()); // not yet due
    await appt(org.id, shop.id, booked.id, new Date(now.getTime() + 3 * DAY));
    const rule = await prisma.automationRule.create({ data: { organizationId: org.id, name: '周期', trigger: 'VISIT_CYCLE', offsetValue: 45, body: '{{customer_name}}様 前回から{{days_since}}日 {{booking_url}}' } });
    await runAutomations(now, org.id);
    await runAutomations(now, org.id);
    const msgs = await prisma.message.findMany({ where: { automationRuleId: rule.id } });
    expect(msgs.map((m) => m.customerId)).toEqual([due.id]);
    expect(msgs[0].body).toContain('前回から50日');
    expect(msgs[0].body).toContain(`/book/${shop.slug}?lk=`);
    // a new visit resets the cycle → eligible again later
    await prisma.customer.update({ where: { id: due.id }, data: { lastVisitAt: new Date(now.getTime() - 46 * DAY) } });
    await runAutomations(now, org.id);
    expect(await prisma.message.count({ where: { automationRuleId: rule.id } })).toBe(2);
  });

  it('skips (and logs) opted-out customers without sending, once', async () => {
    const { org } = await makeOrg();
    const now = new Date();
    const c = await customer(org.id, { lastVisitAt: new Date(now.getTime() - 200 * DAY), lineOptIn: false }, uid());
    const rule = await prisma.automationRule.create({ data: { organizationId: org.id, name: '休眠', trigger: 'DORMANT', offsetValue: 180, body: 'お久しぶりです' } });
    const s = await runAutomations(now, org.id);
    expect(s).toMatchObject({ sent: 0, skipped: 1 });
    await runAutomations(now, org.id);
    const msgs = await prisma.message.findMany({ where: { automationRuleId: rule.id } });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ customerId: c.id, status: 'SKIPPED' });
  });

  it('AFTER_VISIT_REVIEW and BIRTHDAY', async () => {
    const { org, shop } = await makeOrg();
    const now = new Date('2026-09-25T03:00:00Z'); // 12:00 JST
    const c = await customer(org.id, { birthday: '1990-09-25' }, uid());
    const other = await customer(org.id, { birthday: '1990-09-26' }, uid());
    const done = await appt(org.id, shop.id, c.id, new Date(now.getTime() - 6 * HOUR), 'COMPLETED');
    const reviewed = await appt(org.id, shop.id, other.id, new Date(now.getTime() - 7 * HOUR), 'COMPLETED');
    await prisma.review.create({ data: { organizationId: org.id, shopId: shop.id, appointmentId: reviewed.id, rating: 5, authorName: 'x' } });
    await appt(org.id, shop.id, other.id, new Date(now.getTime() - 60 * 60000), 'COMPLETED', 30); // ended 30min ago (< 3h)
    const review = await prisma.automationRule.create({ data: { organizationId: org.id, name: '口コミ', trigger: 'AFTER_VISIT_REVIEW', offsetValue: 3, body: 'ご感想を {{review_url}}' } });
    const bday = await prisma.automationRule.create({ data: { organizationId: org.id, name: '誕生日', trigger: 'BIRTHDAY', offsetValue: 0, body: 'お誕生日おめでとうございます {{customer_name}}様' } });
    await runAutomations(now, org.id);
    await runAutomations(now, org.id);
    const rm = await prisma.message.findMany({ where: { automationRuleId: review.id } });
    expect(rm).toHaveLength(1);
    expect(rm[0].body).toContain(`/review/${done.manageToken}`);
    const bm = await prisma.message.findMany({ where: { automationRuleId: bday.id } });
    expect(bm.map((m) => m.customerId)).toEqual([c.id]);
    expect((await prisma.automationDispatch.findFirstOrThrow({ where: { ruleId: bday.id } })).dedupeKey).toBe(`${bday.id}:${c.id}:2026`);
  });

  it('inactive rules and other orgs are not run', async () => {
    const a = await makeOrg();
    const b = await makeOrg();
    const now = new Date();
    await customer(b.org.id, { lastVisitAt: new Date(now.getTime() - 200 * DAY) }, uid());
    await prisma.automationRule.create({ data: { organizationId: b.org.id, name: '休眠', trigger: 'DORMANT', offsetValue: 180, body: 'x' } });
    await prisma.automationRule.create({ data: { organizationId: a.org.id, name: '休眠', trigger: 'DORMANT', offsetValue: 180, body: 'x', active: false } });
    const s = await runAutomations(now, a.org.id);
    expect(s.rules).toHaveLength(0);
    expect(await prisma.message.count({ where: { organizationId: b.org.id } })).toBe(0);
  });
});

describe('delivery retry & inbox', () => {
  it('retries a failed message in place and respects opt-out', async () => {
    const { org } = await makeOrg();
    const c = await customer(org.id, {}, uid());
    const m = await prisma.message.create({ data: { organizationId: org.id, customerId: c.id, channel: 'LINE', direction: 'OUTBOUND', body: 'x', status: 'FAILED', error: 'LINE API 500' } });
    const r = await retryMessage(org.id, m.id);
    expect(r.status).toBe('SENT');
    await expect(retryMessage(org.id, m.id)).rejects.toThrow();
    const m2 = await prisma.message.create({ data: { organizationId: org.id, customerId: c.id, channel: 'LINE', direction: 'OUTBOUND', body: 'x', status: 'FAILED' } });
    await prisma.customer.update({ where: { id: c.id }, data: { lineOptIn: false } });
    expect((await retryMessage(org.id, m2.id)).status).toBe('SKIPPED');
    const other = await makeOrg();
    await expect(retryMessage(other.org.id, m2.id)).rejects.toThrow();
  });

  it('lists conversations with latest message and unread count', async () => {
    const { org } = await makeOrg();
    const c1 = await customer(org.id, { lastName: '佐藤', firstName: '一郎' }, uid());
    const c2 = await customer(org.id, { lastName: '鈴木', firstName: '二郎' }, uid());
    const t = Date.now();
    await prisma.message.createMany({ data: [
      { organizationId: org.id, customerId: c1.id, channel: 'LINE', direction: 'INBOUND', body: 'a', status: 'RECEIVED', createdAt: new Date(t - 3000) },
      { organizationId: org.id, customerId: c1.id, channel: 'LINE', direction: 'INBOUND', body: 'b', status: 'RECEIVED', createdAt: new Date(t - 2000) },
      { organizationId: org.id, customerId: c2.id, channel: 'LINE', direction: 'OUTBOUND', body: 'c', status: 'SENT', createdAt: new Date(t - 1000) },
    ] });
    const list = await listConversations(org.id);
    expect(list.map((r) => [r.customerId, r.body, r.unread])).toEqual([[c2.id, 'c', 0], [c1.id, 'b', 2]]);
    expect((await listConversations(org.id, { q: '佐藤' })).map((r) => r.customerId)).toEqual([c1.id]);
    expect((await listConversations(org.id, { unreadOnly: true })).map((r) => r.customerId)).toEqual([c1.id]);
  });
});

describe('LINE webhook processing', () => {
  function ev(type: string, userId: string, extra: Record<string, unknown> = {}) {
    return { type, webhookEventId: `E${uid()}`, timestamp: Date.now(), source: { type: 'user', userId }, replyToken: 'r', ...extra };
  }
  async function lineIntegration(orgId: string, shopId: string): Promise<LineIntegrationRef> {
    const it = await prisma.integration.create({ data: { organizationId: orgId, shopId, provider: 'LINE' } });
    return { id: it.id, organizationId: orgId, shopId, config: {} };
  }

  it('verifies signatures', () => {
    const body = JSON.stringify({ events: [] });
    const sig = hmacBase64('secret', body);
    expect(verifyLineSignature(sig, body, 'secret')).toBe(true);
    expect(verifyLineSignature(sig, body + ' ', 'secret')).toBe(false);
    expect(verifyLineSignature(null, body, 'secret')).toBe(false);
  });

  it('follow creates customer + identity; duplicate ignored; message stored; unfollow opts out', async () => {
    const { org, shop } = await makeOrg();
    const it = await lineIntegration(org.id, shop.id);
    const user = uid();
    const follow = ev('follow', user);
    const events = normalizeLineWebhook(JSON.stringify({ events: [follow] }));
    const r1 = await handleLineEvents(org.id, it, events);
    expect(r1).toMatchObject({ received: 1, duplicates: 0, processed: 1, failed: 0 });
    const ident = await prisma.customerIdentity.findUniqueOrThrow({ where: { organizationId_provider_externalId: { organizationId: org.id, provider: 'LINE', externalId: user } }, include: { customer: true } });
    expect(ident.customer.lastName).toBe('LINEのお客様');
    expect(ident.customer.lineOptIn).toBe(true);
    expect(ident.customer.primaryShopId).toBe(shop.id);

    const r2 = await handleLineEvents(org.id, it, events); // redelivery
    expect(r2).toMatchObject({ duplicates: 1, processed: 0 });
    expect(await prisma.customer.count({ where: { organizationId: org.id } })).toBe(1);

    const msg = normalizeLineWebhook(JSON.stringify({ events: [ev('message', user, { message: { type: 'text', id: '1', text: 'こんにちは' } })] }));
    await handleLineEvents(org.id, it, msg);
    const inbound = await prisma.message.findMany({ where: { customerId: ident.customerId, direction: 'INBOUND' } });
    expect(inbound).toHaveLength(1);
    expect(inbound[0]).toMatchObject({ body: 'こんにちは', status: 'RECEIVED', channel: 'LINE', readAt: null });
    expect(await prisma.message.count({ where: { customerId: ident.customerId, direction: 'OUTBOUND' } })).toBe(0);

    await handleLineEvents(org.id, it, normalizeLineWebhook(JSON.stringify({ events: [ev('unfollow', user)] })));
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: ident.customerId } })).lineOptIn).toBe(false);
    // re-follow opts back in
    await handleLineEvents(org.id, it, normalizeLineWebhook(JSON.stringify({ events: [ev('follow', user)] })));
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: ident.customerId } })).lineOptIn).toBe(true);
  });

  it('booking keyword and postback reply with a signed booking link', async () => {
    const { org, shop } = await makeOrg();
    const it = await lineIntegration(org.id, shop.id);
    const user = uid();
    await handleLineEvents(org.id, it, normalizeLineWebhook(JSON.stringify({ events: [ev('message', user, { message: { type: 'text', id: '2', text: '予約したいです' } })] })));
    const c = await prisma.customerIdentity.findFirstOrThrow({ where: { organizationId: org.id, externalId: user } });
    const out = await prisma.message.findFirstOrThrow({ where: { customerId: c.customerId, direction: 'OUTBOUND' } });
    expect(out.status).toBe('SENT');
    const m = /\/book\/([^?\s]+)\?lk=([^\s]+)/.exec(out.body);
    expect(m?.[1]).toBe(shop.slug);
    expect(verifyLineLink(m![2])).toEqual({ orgId: org.id, lineUserId: user });

    await handleLineEvents(org.id, it, normalizeLineWebhook(JSON.stringify({ events: [ev('postback', user, { postback: { data: 'action=book' } })] })));
    expect(await prisma.message.count({ where: { customerId: c.customerId, direction: 'OUTBOUND' } })).toBe(2);
    expect(buildBookingRichMenu({ shopName: 'X', bookingUrl: 'https://x/book/s' }).areas[0].action).toMatchObject({ type: 'postback', data: 'action=book' });
  });

  it('attaches LINE events to an existing identity (no duplicate customer)', async () => {
    const { org, shop } = await makeOrg();
    const it = await lineIntegration(org.id, shop.id);
    const user = uid();
    const existing = await customer(org.id, {}, user);
    await handleLineEvents(org.id, it, normalizeLineWebhook(JSON.stringify({ events: [ev('message', user, { message: { type: 'image', id: '3' } })] })));
    const msgs = await prisma.message.findMany({ where: { organizationId: org.id } });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ customerId: existing.id, body: '[image]' });
  });
});

describe('reviews', () => {
  it('allows one review per completed appointment', async () => {
    const { org, shop, staff } = await makeOrg();
    const c = await customer(org.id);
    const start = new Date(Date.now() - 2 * DAY);
    const a = await prisma.appointment.create({ data: { organizationId: org.id, shopId: shop.id, customerId: c.id, staffId: staff[1].userId, startAt: start, endAt: new Date(start.getTime() + HOUR), status: 'CONFIRMED' } });
    await expect(submitReview(a.manageToken, { rating: 5, authorName: 'H' })).rejects.toThrow('ご来店後');
    await prisma.appointment.update({ where: { id: a.id }, data: { status: 'COMPLETED' } });
    await expect(submitReview(a.manageToken, { rating: 0, authorName: 'H' })).rejects.toThrow();
    const r = await submitReview(a.manageToken, { rating: 4, title: '最高', body: 'また来ます', authorName: 'H.Y' });
    expect(r).toMatchObject({ rating: 4, staffId: staff[1].userId, customerId: c.id, shopId: shop.id, source: 'INTERNAL', published: true });
    await expect(submitReview(a.manageToken, { rating: 5, authorName: 'H' })).rejects.toThrow('投稿済み');
    await expect(submitReview('nope', { rating: 5, authorName: 'H' })).rejects.toThrow();
    const s = await reviewStats({ organizationId: org.id });
    expect(s).toMatchObject({ total: 1, average: 4 });
  });
});

describe('L3: broadcast audience is limited to the sender\'s shops', () => {
  it('non-OWNER/DIRECTOR must pick one of their own shops; org-wide only for OWNER/DIRECTOR', async () => {
    const { org, shop } = await makeOrg();
    const shopB = await prisma.shop.create({ data: { organizationId: org.id, name: 'B店', slug: `lb-${Date.now().toString(36)}` } });
    const manager = { role: 'MANAGER' as const, shopIds: [shop.id] };
    await expect(assertSegmentScope(org.id, normalizeSegment({}), manager)).rejects.toThrow(/店舗を選択/);
    await expect(assertSegmentScope(org.id, normalizeSegment({ shopId: shopB.id }), manager)).rejects.toThrow(/権限/);
    await assertSegmentScope(org.id, normalizeSegment({ shopId: shop.id }), manager);
    await assertSegmentScope(org.id, normalizeSegment({}), { role: 'OWNER', shopIds: [shop.id, shopB.id] });
    await assertSegmentScope(org.id, normalizeSegment({ shopId: shopB.id }), { role: 'DIRECTOR', shopIds: [shop.id, shopB.id] });
    // foreign shop ids are still rejected for everyone
    const other = await makeOrg();
    await expect(assertSegmentScope(org.id, normalizeSegment({ shopId: other.shop.id }), { role: 'OWNER', shopIds: [] })).rejects.toThrow(/店舗/);
  });
});
