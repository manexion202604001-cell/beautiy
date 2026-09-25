import { describe, expect, it } from 'vitest';
import { localToUtc, MAX_SYNC_ATTEMPTS } from '@salonos/core';
import { hmacHex } from '@salonos/core/crypto';
import { prisma } from '@salonos/db';
import { writeConfig } from '@/lib/server/integrations';
import { createAppointment } from '@/lib/server/booking';
import {
  forceApplySyncEvent, ignoreSyncEvent, ingestBookingWebhook, linkSyncEventToAppointment, processPendingSyncEvents,
  processSyncEvent, propagateAppointmentChange, retrySyncEvent,
} from '@/lib/server/sync';
import { futureDate, makeOrg } from './helpers';

const TZ = 'Asia/Tokyo';
const SECRET = 'whsec-test-123';
const at = (date: string, hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return localToUtc(date, h * 60 + m, TZ); };

async function setup(opts: { seats?: number; shopBound?: boolean; provider?: string } = {}) {
  const t = await makeOrg({ seats: opts.seats ?? 3 });
  const integration = await prisma.integration.create({
    data: {
      organizationId: t.org.id, shopId: opts.shopBound === false ? null : t.shop.id, provider: opts.provider ?? 'HOTPEPPER', status: 'ACTIVE',
      configEnc: writeConfig({ webhookSecret: SECRET, staffMap: { 'hp-staff-1': t.staff[1].userId } }),
    },
  });
  return { ...t, integration };
}

let evn = 0;
function payload(p: { id: string; version?: number; status?: string; date: string; start: string; end: string; staff?: string; customer?: Record<string, string>; menus?: string[]; price?: number; eventId?: string }) {
  return JSON.stringify({
    event_id: p.eventId ?? `evt-${Date.now()}-${evn++}`,
    type: 'booking.upsert',
    booking: {
      id: p.id, version: p.version, status: p.status ?? 'confirmed', staff_id: p.staff,
      start_at: at(p.date, p.start).toISOString(), end_at: at(p.date, p.end).toISOString(),
      customer: p.customer ?? { name: '外部 太郎', phone: '090-1111-2222', id: 'hp-cust-1' },
      menus: p.menus ?? ['カット'], price: p.price,
    },
  });
}
const sign = (body: string, secret = SECRET) => ({ 'X-Salonos-Signature': `sha256=${hmacHex(secret, body)}`, 'content-type': 'application/json' });

describe('external booking sync', () => {
  it('requires a valid signature and a known, active webhook key', async () => {
    const { integration } = await setup();
    const body = payload({ id: 'B-sig', date: futureDate(), start: '11:00', end: '12:00' });
    expect((await ingestBookingWebhook(integration.webhookKey, {}, body)).status).toBe(401);
    expect((await ingestBookingWebhook(integration.webhookKey, sign(body, 'wrong'), body)).status).toBe(401);
    expect((await ingestBookingWebhook('nope', sign(body), body)).status).toBe(404);
    await prisma.integration.update({ where: { id: integration.id }, data: { status: 'PAUSED' } });
    expect((await ingestBookingWebhook(integration.webhookKey, sign(body), body)).status).toBe(404);
    expect(await prisma.syncEvent.count({ where: { integrationId: integration.id } })).toBe(0);
  });

  it('rejects a signed-but-invalid payload as DEAD (400), idempotently', async () => {
    const { integration } = await setup();
    const body = JSON.stringify({ event_id: 'x', booking: { id: 'B', start_at: 'nope' } });
    const r1 = await ingestBookingWebhook(integration.webhookKey, sign(body), body);
    const r2 = await ingestBookingWebhook(integration.webhookKey, sign(body), body);
    expect(r1.status).toBe(400);
    expect(r2.status).toBe(400);
    const evs = await prisma.syncEvent.findMany({ where: { integrationId: integration.id } });
    expect(evs).toHaveLength(1);
    expect(evs[0].status).toBe('DEAD');
  });

  it('is idempotent on duplicate event delivery', async () => {
    const { integration, org } = await setup();
    const body = payload({ id: 'B-dup', date: futureDate(), start: '11:00', end: '12:00', eventId: 'evt-dup-1' });
    const r1 = await ingestBookingWebhook(integration.webhookKey, sign(body), body);
    const r2 = await ingestBookingWebhook(integration.webhookKey, sign(body), body);
    expect(r1).toMatchObject({ status: 200, body: { ok: true, status: 'DONE' } });
    expect(r2).toMatchObject({ status: 200, body: { ok: true, duplicate: true } });
    expect(await prisma.syncEvent.count({ where: { integrationId: integration.id } })).toBe(1);
    expect(await prisma.appointment.count({ where: { organizationId: org.id } })).toBe(1);
  });

  it('create → update → cancel lifecycle through the booking engine', async () => {
    const { integration, org, staff } = await setup();
    const date = futureDate(4);
    const send = async (b: string) => ingestBookingWebhook(integration.webhookKey, sign(b), b);

    await send(payload({ id: 'B-life', version: 1, date, start: '11:00', end: '12:00', staff: 'hp-staff-1', menus: ['カット', 'ヘッドスパ特別'], price: 9000 }));
    let appt = await prisma.appointment.findFirstOrThrow({ where: { organizationId: org.id, externalRef: 'B-life' }, include: { menus: true } });
    expect(appt).toMatchObject({ source: 'HOTPEPPER', status: 'CONFIRMED', externalProvider: 'HOTPEPPER', staffId: staff[1].userId, nominated: true });
    expect(appt.menus.find((m) => m.name === 'カット')?.menuId).toBeTruthy(); // matched to shop menu
    expect(appt.menus.find((m) => m.name === 'ヘッドスパ特別')?.menuId).toBeNull(); // synthetic line
    expect(appt.totalPrice).toBe(9000);

    await send(payload({ id: 'B-life', version: 2, date, start: '14:00', end: '15:30' }));
    appt = await prisma.appointment.findFirstOrThrow({ where: { id: appt.id }, include: { menus: true } });
    expect(appt.startAt.toISOString()).toBe(at(date, '14:00').toISOString());
    expect(appt.endAt.toISOString()).toBe(at(date, '15:30').toISOString());
    expect(appt.staffId).toBeNull();

    await send(payload({ id: 'B-life', version: 3, status: 'cancelled', date, start: '14:00', end: '15:30' }));
    appt = await prisma.appointment.findFirstOrThrow({ where: { id: appt.id }, include: { menus: true } });
    expect(appt.status).toBe('CANCELLED');
    expect(await prisma.appointment.count({ where: { organizationId: org.id } })).toBe(1);
    const evs = await prisma.syncEvent.findMany({ where: { integrationId: integration.id } });
    expect(evs.every((e) => e.status === 'DONE')).toBe(true);
  });

  it('discards stale (out-of-order) versions', async () => {
    const { integration, org } = await setup();
    const date = futureDate(5);
    const send = async (b: string) => ingestBookingWebhook(integration.webhookKey, sign(b), b);
    await send(payload({ id: 'B-stale', version: 5, date, start: '16:00', end: '17:00' }));
    await send(payload({ id: 'B-stale', version: 3, date, start: '11:00', end: '12:00' }));
    await send(payload({ id: 'B-stale', version: 4, status: 'cancelled', date, start: '11:00', end: '12:00' }));
    const appt = await prisma.appointment.findFirstOrThrow({ where: { organizationId: org.id, externalRef: 'B-stale' } });
    expect(appt.startAt.toISOString()).toBe(at(date, '16:00').toISOString());
    expect(appt.status).toBe('CONFIRMED');
    const evs = await prisma.syncEvent.findMany({ where: { integrationId: integration.id }, orderBy: { createdAt: 'asc' } });
    expect(evs.map((e) => (e.normalized as any).outcome.items[0].action)).toEqual(['created', 'stale', 'stale']);
  });

  it('flags capacity conflicts as CONFLICT (no retry) and supports reconciliation', async () => {
    const { integration, org, shop } = await setup({ seats: 1 });
    const date = futureDate(6);
    const existing = await createAppointment({ orgId: org.id, shopId: shop.id, startAt: at(date, '11:00'), menus: [{ name: 'x', price: 1, durationMin: 60 }] });
    const body = payload({ id: 'B-conf', date, start: '11:00', end: '12:00' });
    const r = await ingestBookingWebhook(integration.webhookKey, sign(body), body);
    expect(r.body.status).toBe('CONFLICT');
    const ev = await prisma.syncEvent.findFirstOrThrow({ where: { integrationId: integration.id } });
    expect(ev.status).toBe('CONFLICT');
    expect((ev.normalized as any).outcome.conflict.reason).toBe('SEAT_CAPACITY');
    // cron never picks CONFLICT
    await processPendingSyncEvents(new Date(Date.now() + 86400000));
    expect((await prisma.syncEvent.findUniqueOrThrow({ where: { id: ev.id } })).status).toBe('CONFLICT');

    // option A: link to the existing appointment
    const copy = await prisma.syncEvent.create({ data: { ...ev, id: undefined, externalEventId: `${ev.externalEventId}-copy`, createdAt: undefined } as any });
    await linkSyncEventToAppointment(org.id, copy.id, existing.appointmentId);
    const linked = await prisma.appointment.findUniqueOrThrow({ where: { id: existing.appointmentId } });
    expect(linked).toMatchObject({ externalProvider: 'HOTPEPPER', externalRef: 'B-conf' });
    await prisma.appointment.update({ where: { id: existing.appointmentId }, data: { externalProvider: null, externalRef: null } });

    // option B: force register allowing seat overrun
    const f = await forceApplySyncEvent(org.id, ev.id);
    expect(f.status).toBe('DONE');
    expect(await prisma.appointment.count({ where: { organizationId: org.id, status: 'CONFIRMED' } })).toBe(2);
  });

  it('ignore marks an event handled without applying it', async () => {
    const { integration, org, shop } = await setup({ seats: 1 });
    const date = futureDate(6);
    await createAppointment({ orgId: org.id, shopId: shop.id, startAt: at(date, '13:00'), menus: [{ name: 'x', price: 1, durationMin: 60 }] });
    const body = payload({ id: 'B-ign', date, start: '13:00', end: '14:00' });
    await ingestBookingWebhook(integration.webhookKey, sign(body), body);
    const ev = await prisma.syncEvent.findFirstOrThrow({ where: { integrationId: integration.id } });
    await ignoreSyncEvent(org.id, ev.id, '電話で別日に振替');
    const after = await prisma.syncEvent.findUniqueOrThrow({ where: { id: ev.id } });
    expect(after.status).toBe('DONE');
    expect(after.lastError).toContain('電話で別日に振替');
    expect(await prisma.appointment.count({ where: { organizationId: org.id } })).toBe(1);
  });

  it('resolves the same customer across events (external id, then phone)', async () => {
    const { integration, org } = await setup({ seats: 5 });
    const date = futureDate(7);
    const send = async (b: string) => ingestBookingWebhook(integration.webhookKey, sign(b), b);
    await send(payload({ id: 'B-c1', date, start: '11:00', end: '12:00', customer: { name: '山川 花', phone: '080-3333-4444', id: 'hp-c-9' } }));
    // same provider customer id, different phone format
    await send(payload({ id: 'B-c2', date, start: '13:00', end: '14:00', customer: { name: '山川 花', phone: '08033334444', id: 'hp-c-9' } }));
    // no provider customer id, same phone → phone blind-index match
    await send(payload({ id: 'B-c3', date, start: '15:00', end: '16:00', customer: { name: 'ヤマカワ ハナ', phone: '+81 80-3333-4444' } }));
    const appts = await prisma.appointment.findMany({ where: { organizationId: org.id } });
    expect(appts).toHaveLength(3);
    expect(new Set(appts.map((a) => a.customerId)).size).toBe(1);
    expect(await prisma.customer.count({ where: { organizationId: org.id } })).toBe(1);
    const idents = await prisma.customerIdentity.findMany({ where: { organizationId: org.id, provider: 'HOTPEPPER' } });
    expect(idents.map((i) => i.externalId)).toEqual(expect.arrayContaining(['hp-c-9']));
    expect(idents.every((i) => !i.externalId.includes('3333'))).toBe(true); // no plaintext phone in identity keys
  });

  it('retries with exponential backoff and dead-letters after MAX_SYNC_ATTEMPTS', async () => {
    const t = await setup({ shopBound: false });
    // second shop → cannot infer the target shop without a shopMap → retryable failure
    await prisma.shop.create({ data: { organizationId: t.org.id, name: 'Second', slug: `s2-${t.shop.slug}` } });
    const body = payload({ id: 'B-retry', date: futureDate(), start: '11:00', end: '12:00' });
    const t0 = new Date();
    const r = await ingestBookingWebhook(t.integration.webhookKey, sign(body), body, { now: t0 });
    expect(r.body.status).toBe('FAILED');
    let ev = await prisma.syncEvent.findFirstOrThrow({ where: { integrationId: t.integration.id } });
    expect(ev.attempts).toBe(1);
    expect(ev.nextAttemptAt.getTime() - t0.getTime()).toBe(30_000);
    // not yet due
    expect(await processPendingSyncEvents(new Date(t0.getTime() + 1000))).toEqual({ processed: 0, failed: 0 });

    let now = t0;
    const gaps: number[] = [];
    for (let i = 2; i <= MAX_SYNC_ATTEMPTS; i++) {
      now = new Date(ev.nextAttemptAt.getTime() + 1);
      const res = await processPendingSyncEvents(now);
      expect(res.failed).toBe(1);
      ev = await prisma.syncEvent.findUniqueOrThrow({ where: { id: ev.id } });
      expect(ev.attempts).toBe(i);
      if (ev.status === 'FAILED') gaps.push(ev.nextAttemptAt.getTime() - now.getTime());
    }
    expect(ev.status).toBe('DEAD');
    expect(gaps).toEqual([60_000, 120_000, 240_000, 480_000]);
    expect((await prisma.integration.findUniqueOrThrow({ where: { id: t.integration.id } })).lastError).toContain('店舗');

    // Admin fixes the config and retries the dead event
    await prisma.integration.update({ where: { id: t.integration.id }, data: { shopId: t.shop.id } });
    const retried = await retrySyncEvent(t.org.id, ev.id);
    expect(retried.status).toBe('DONE');
  });

  it('concurrent cron runs never double-process an event', async () => {
    const { integration, org } = await setup({ seats: 5 });
    const date = futureDate(8);
    for (let i = 0; i < 4; i++) {
      const b = payload({ id: `B-cc-${i}`, date, start: `${11 + i}:00`, end: `${12 + i}:00` });
      await ingestBookingWebhook(integration.webhookKey, sign(b), b, { processInline: false });
    }
    const now = new Date(Date.now() + 1000);
    const runs = await Promise.all([processPendingSyncEvents(now), processPendingSyncEvents(now), processPendingSyncEvents(now)]);
    expect(runs.reduce((s, r) => s + r.processed, 0)).toBe(4);
    const evs = await prisma.syncEvent.findMany({ where: { integrationId: integration.id } });
    expect(evs.every((e) => e.status === 'DONE' && e.attempts === 1)).toBe(true);
    expect(await prisma.appointment.count({ where: { organizationId: org.id } })).toBe(4);
    // a second claim on a finished event is refused
    expect((await processSyncEvent(evs[0].id)).claimed).toBe(false);
  });

  it('does not propagate changes back to the origin provider (placeholder adapters are no-ops)', async () => {
    const { integration, org } = await setup();
    await prisma.integration.create({ data: { organizationId: org.id, provider: 'MINIMO', status: 'ACTIVE' } });
    const b = payload({ id: 'B-loop', date: futureDate(9), start: '11:00', end: '12:00' });
    await ingestBookingWebhook(integration.webhookKey, sign(b), b);
    const appt = await prisma.appointment.findFirstOrThrow({ where: { organizationId: org.id } });
    expect(await propagateAppointmentChange(appt.id)).toBe(0);
    expect(await prisma.syncEvent.count({ where: { organizationId: org.id, direction: 'OUTBOUND' } })).toBe(0);
  });

  it('keeps tenants apart: same event id / booking id from two orgs (generic webhook)', async () => {
    const a = await setup({ provider: 'GENERIC' });
    const b = await setup({ provider: 'GENERIC' });
    const date = futureDate(10);
    const body = payload({ id: '1', date, start: '11:00', end: '12:00', eventId: 'evt-shared' });
    const ra = await ingestBookingWebhook(a.integration.webhookKey, sign(body), body);
    const rb = await ingestBookingWebhook(b.integration.webhookKey, sign(body), body);
    expect(ra.body).toMatchObject({ status: 'DONE' });
    expect(rb.body).toMatchObject({ status: 'DONE' });
    expect(rb.body.duplicate).toBeUndefined();
    const [aa, ab] = await Promise.all([a, b].map((t) => prisma.appointment.findFirstOrThrow({ where: { organizationId: t.org.id } })));
    expect(aa.source).toBe('OTHER');
    expect(aa.externalRef).not.toBe(ab.externalRef);
  });
});
