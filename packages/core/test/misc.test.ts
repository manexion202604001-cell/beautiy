import { describe, expect, it } from 'vitest';
import { lifecycle, visitStats, repeatRate } from '../src/analytics';
import { duplicateScore, findDuplicates, normalizeEmail, normalizeKana, normalizePhone, maskPhone, publicNameMatches } from '../src/identity';
import { blindIndex, decrypt, encrypt, hashPassword, keysFrom, verifyPassword } from '../src/crypto';
import { can } from '../src/rbac';
import { matchesSegment, renderTemplate, backoffMs } from '../src/messaging';
import { parseCsv, toCsv } from '../src/csv';
import { addDays, localToUtc, startOfWeek, toLocalParts } from '../src/time';
import { normalizeGeneric, verifyGenericSignature } from '../src/integrations/booking-provider';
import { signStripePayload, verifyStripeSignature, normalizeStripeEvent } from '../src/integrations/payments';
import { verifyLineSignature } from '../src/integrations/line';
import { hmacHex, hmacBase64 } from '../src/crypto';

const D = 86400000;

describe('analytics', () => {
  it('computes LTV and interval', () => {
    const s = visitStats([{ at: 0, amount: 10000 }, { at: 40 * D, amount: 12000 }, { at: 90 * D, amount: 8000 }]);
    expect(s).toMatchObject({ visitCount: 3, ltv: 30000, avgSpend: 10000, avgIntervalDays: 45 });
  });
  it('classifies lifecycle', () => {
    expect(lifecycle({ visitCount: 3, lastVisitAt: 0, avgIntervalDays: 40 }, 20 * D)).toBe('ACTIVE');
    expect(lifecycle({ visitCount: 3, lastVisitAt: 0, avgIntervalDays: 40 }, 45 * D)).toBe('DUE');
    expect(lifecycle({ visitCount: 3, lastVisitAt: 0, avgIntervalDays: 40 }, 70 * D)).toBe('OVERDUE');
    expect(lifecycle({ visitCount: 3, lastVisitAt: 0, avgIntervalDays: 40 }, 200 * D)).toBe('DORMANT');
    expect(lifecycle({ visitCount: 0, lastVisitAt: null, avgIntervalDays: null }, 0)).toBe('PROSPECT');
  });
  it('computes repeat rate', () => {
    expect(repeatRate([{ first: 0, second: 30 * D }, { first: 0, second: null }, { first: 0, second: 200 * D }, { first: 0, second: 10 * D }])).toBe(0.5);
  });
});

describe('identity', () => {
  it('normalizes JP phone numbers', () => {
    expect(normalizePhone('090-1234-5678')).toBe('09012345678');
    expect(normalizePhone('+81 90 1234 5678')).toBe('09012345678');
    expect(normalizePhone('０９０１２３４５６７８')).toBe('09012345678');
    expect(normalizePhone('123')).toBeNull();
    expect(maskPhone('09012345678')).toBe('*******5678');
  });
  it('normalizes email and kana', () => {
    expect(normalizeEmail(' Foo@Example.COM ')).toBe('foo@example.com');
    expect(normalizeEmail('nope')).toBeNull();
    expect(normalizeKana('やまだ はなこ')).toBe('ヤマダハナコ');
  });
  it('scores duplicates', () => {
    const a = { id: '1', lastName: '山田', firstName: '花子', phoneHash: 'x', birthday: '1990-01-01' };
    expect(duplicateScore(a, { ...a, id: '2' }).score).toBe(95);
    expect(duplicateScore(a, { ...a, id: '2', phoneHash: 'y' }).score).toBe(85);
    expect(duplicateScore(a, { ...a, id: '2', phoneHash: 'y', birthday: null }).score).toBe(60);
    const pairs = findDuplicates([a, { ...a, id: '2' }, { id: '3', lastName: '鈴木', firstName: '一郎' }]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ a: '1', b: '2' });
  });
});

describe('crypto', () => {
  const k = keysFrom('test-encryption-key-123456', 'test-hash-key-1234567');
  it('round-trips AES-GCM and detects tampering', () => {
    const c = encrypt('090-1234-5678', k.encKey);
    expect(c).not.toContain('1234');
    expect(decrypt(c, k.encKey)).toBe('090-1234-5678');
    const parts = c.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => decrypt(parts.join('.'), k.encKey)).toThrow();
  });
  it('blind index is deterministic', () => {
    expect(blindIndex('09012345678', k.hashKey)).toBe(blindIndex('09012345678', k.hashKey));
    expect(blindIndex('09012345678', k.hashKey)).not.toBe(blindIndex('09012345679', k.hashKey));
  });
  it('hashes passwords', () => {
    const h = hashPassword('s3cret-pass');
    expect(verifyPassword('s3cret-pass', h)).toBe(true);
    expect(verifyPassword('wrong', h)).toBe(false);
  });
});

describe('rbac', () => {
  it('limits sensitive permissions', () => {
    expect(can('OWNER', 'settings.permissions')).toBe(true);
    expect(can('STYLIST', 'customer.export')).toBe(false);
    expect(can('ASSISTANT', 'pos.refund')).toBe(false);
    expect(can('RECEPTION', 'pos.register')).toBe(true);
  });
});

describe('messaging', () => {
  it('renders templates', () => {
    expect(renderTemplate('{{customer_name}}様 {{ date }} {{unknown}}', { customer_name: '山田', date: '10/1' })).toBe('山田様 10/1 ');
  });
  it('evaluates segments', () => {
    const c = { tagIds: ['vip'], lastVisitAt: 0, visitCount: 5, assignedStaffId: 's1', favorite: true, primaryShopId: 'shop' };
    expect(matchesSegment(c, { tagIds: ['vip'], lastVisitDaysMin: 30 }, 45 * D)).toBe(true);
    expect(matchesSegment(c, { lastVisitDaysMax: 30 }, 45 * D)).toBe(false);
    expect(matchesSegment(c, { staffId: 's2' }, 0)).toBe(false);
  });
  it('backs off exponentially with cap', () => {
    expect(backoffMs(1)).toBe(30000);
    expect(backoffMs(3)).toBe(120000);
    expect(backoffMs(100)).toBe(6 * 3600_000);
  });
});

describe('csv', () => {
  it('round-trips quotes/newlines and guards formulas', () => {
    const csv = toCsv(['a', 'b'], [['x,y', 'he said "hi"'], ['=SUM(A1)', 'line\nbreak']]);
    const rows = parseCsv(csv);
    expect(rows[1]).toEqual(['x,y', 'he said "hi"']);
    expect(rows[2]).toEqual(["'=SUM(A1)", 'line\nbreak']);
  });
});

describe('time', () => {
  it('converts local <-> utc', () => {
    const d = localToUtc('2026-09-25', 13 * 60 + 30, 'Asia/Tokyo');
    expect(d.toISOString()).toBe('2026-09-25T04:30:00.000Z');
    expect(toLocalParts(d, 'Asia/Tokyo')).toMatchObject({ date: '2026-09-25', minutes: 810, weekday: 5 });
    expect(localToUtc('2026-07-01', 9 * 60, 'America/New_York').toISOString()).toBe('2026-07-01T13:00:00.000Z');
  });
  it('date math', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(startOfWeek('2026-09-27')).toBe('2026-09-21');
  });
});

describe('integrations', () => {
  const body = JSON.stringify({ event_id: 'e1', type: 'booking.upsert', booking: { id: 'b1', status: 'confirmed', start_at: '2026-10-01T10:00:00+09:00', end_at: '2026-10-01T11:00:00+09:00', customer: { name: '田中 太郎', phone: '09000000000' }, menus: ['カット'] } });
  it('verifies generic webhook signatures', () => {
    const sig = 'sha256=' + hmacHex('whsec', body);
    expect(verifyGenericSignature({ 'x-salonos-signature': sig }, body, 'whsec')).toBe(true);
    expect(verifyGenericSignature({ 'x-salonos-signature': sig }, body + ' ', 'whsec')).toBe(false);
    expect(verifyGenericSignature({ 'x-salonos-signature': sig }, body, undefined)).toBe(false);
  });
  it('normalizes generic payloads', () => {
    const n = normalizeGeneric(body);
    expect(n.eventId).toBe('e1');
    expect(n.bookings[0]).toMatchObject({ externalId: 'b1', status: 'confirmed', startAt: '2026-10-01T01:00:00.000Z' });
    expect(() => normalizeGeneric('{"event_id":"x","booking":{"id":"1"}}')).toThrow();
  });
  it('verifies stripe signatures with tolerance', () => {
    const payload = JSON.stringify({ id: 'evt_1', type: 'payment_intent.succeeded', data: { object: { id: 'pi_1', amount_received: 1000, metadata: { transaction_id: 't1' } } } });
    const header = signStripePayload(payload, 'whsec_x', 1000);
    expect(verifyStripeSignature(header, payload, 'whsec_x', 300, 1100)).toBe(true);
    expect(verifyStripeSignature(header, payload, 'whsec_x', 300, 2000)).toBe(false);
    expect(normalizeStripeEvent(payload)).toMatchObject({ type: 'payment.succeeded', referenceId: 't1', referenceKind: 'transaction', amount: 1000 });
  });
  it('verifies LINE signatures', () => {
    expect(verifyLineSignature(hmacBase64('secret', '{}'), '{}', 'secret')).toBe(true);
    expect(verifyLineSignature('bad', '{}', 'secret')).toBe(false);
  });
});

describe('publicNameMatches (unverified public input vs stored customer)', () => {
  const stored = { lastName: '山田', firstName: '花子', lastNameKana: 'ヤマダ', firstNameKana: 'ハナコ' };
  it('accepts the same person written differently', () => {
    expect(publicNameMatches({ name: '山田 花子' }, stored)).toBe(true);
    expect(publicNameMatches({ name: '山田花子' }, stored)).toBe(true);
    expect(publicNameMatches({ name: '山田　花子', kana: 'やまだ はなこ' }, stored)).toBe(true);
    expect(publicNameMatches({ name: 'Yamada Hanako', kana: 'ヤマダ ハナコ' }, stored)).toBe(true); // kana equal
    expect(publicNameMatches({ name: 'やまだ はなこ' }, stored)).toBe(true); // name typed in kana
    // surname-only on either side
    expect(publicNameMatches({ name: '山田' }, stored)).toBe(true);
    expect(publicNameMatches({ name: '山田 花子' }, { lastName: '山田', firstName: '' })).toBe(true);
  });
  it('rejects a different person sharing the phone/email', () => {
    expect(publicNameMatches({ name: '山田 太郎', kana: 'ヤマダ タロウ' }, stored)).toBe(false);
    expect(publicNameMatches({ name: '佐藤 花子', kana: 'サトウ ハナコ' }, stored)).toBe(false);
    expect(publicNameMatches({ name: '攻撃 者' }, stored)).toBe(false);
    expect(publicNameMatches({ name: '佐藤' }, { lastName: '山田', firstName: '' })).toBe(false);
  });
});
