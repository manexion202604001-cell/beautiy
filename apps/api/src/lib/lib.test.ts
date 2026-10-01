import { describe, expect, it } from 'vitest';
import { decrypt, encrypt, hashPassword, signPayload, verifyPassword, verifySignedPayload } from './crypto.js';
import { toCsv } from './csv.js';
import { allocate, includedTax, roundYen, toInclusive } from './money.js';
import { normalizeEmail, normalizeKana, normalizePhone, similarity } from './normalize.js';
import { decodeCursor, encodeCursor, paginate } from './pagination.js';
import { mergeShopSettings, parseShopSettings } from './shop-settings.js';
import { renderTemplate, templateVariables } from './template.js';
import { dayBounds, intersectRanges, localDate, subtractRanges, weekdayOf, zonedDateTime } from './time.js';

describe('money', () => {
  it('computes included consumption tax with rounding', () => {
    expect(includedTax(11000, 1000)).toBe(1000);
    expect(includedTax(1100, 1000)).toBe(100); // float guard (1100*10/110)
    expect(includedTax(1080, 800)).toBe(80);
    expect(includedTax(999, 1000)).toBe(90); // 90.81 floor
    expect(includedTax(999, 1000, 'round')).toBe(91);
    expect(includedTax(5000, 0)).toBe(0);
    expect(toInclusive(1000, 1000)).toBe(1100);
    expect(roundYen(10.5, 'ceil')).toBe(11);
  });

  it('allocates integers exactly (largest remainder)', () => {
    expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocate(-100, [1, 1, 1]).reduce((a, b) => a + b, 0)).toBe(-100);
    expect(allocate(1000, [5000, 3000, 2000])).toEqual([500, 300, 200]);
    expect(allocate(7, [0, 0])).toEqual([4, 3]);
    const parts = allocate(12345, [3333, 3333, 3334]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(12345);
    expect(allocate(10, [])).toEqual([]);
  });
});

describe('normalize', () => {
  it('normalizes Japanese phone numbers to E.164', () => {
    expect(normalizePhone('090-1234-5678')).toBe('+819012345678');
    expect(normalizePhone('０９０１２３４５６７８')).toBe('+819012345678');
    expect(normalizePhone('03 1234 5678')).toBe('+81312345678');
    expect(normalizePhone('+81 90 1234 5678')).toBe('+819012345678');
    expect(normalizePhone('81-90-1234-5678')).toBe('+819012345678');
    expect(normalizePhone('123')).toBeNull();
    expect(normalizePhone(null)).toBeNull();
  });

  it('normalizes kana (hiragana→katakana, half-width→full-width) and emails', () => {
    expect(normalizeKana('やまだ はなこ')).toBe('ヤマダハナコ');
    expect(normalizeKana('ﾔﾏﾀﾞ')).toBe('ヤマダ');
    expect(normalizeEmail(' Foo@Example.COM ')).toBe('foo@example.com');
    expect(normalizeEmail('invalid')).toBeNull();
  });

  it('computes similarity', () => {
    expect(similarity('サトウミサキ', 'サトウミサキ')).toBe(1);
    expect(similarity('サトウミサキ', 'サイトウミサキ')).toBeGreaterThan(0.85);
    expect(similarity('', 'a')).toBe(0);
  });
});

describe('time', () => {
  it('converts local JST times to UTC and computes day bounds', () => {
    expect(zonedDateTime('2026-10-01', '10:00', 'Asia/Tokyo').toISOString()).toBe('2026-10-01T01:00:00.000Z');
    const b = dayBounds('2026-10-01', 'Asia/Tokyo');
    expect(b.start.toISOString()).toBe('2026-09-30T15:00:00.000Z');
    expect(b.end.toISOString()).toBe('2026-10-01T15:00:00.000Z');
    expect(localDate(new Date('2026-09-30T16:00:00Z'), 'Asia/Tokyo')).toBe('2026-10-01');
    expect(weekdayOf('2026-10-01', 'Asia/Tokyo')).toBe(4); // Thursday
  });

  it('subtracts and intersects ranges', () => {
    const d = (h: number) => new Date(Date.UTC(2026, 0, 1, h));
    expect(subtractRanges([{ start: d(10), end: d(20) }], [{ start: d(12), end: d(13) }])).toEqual([
      { start: d(10), end: d(12) },
      { start: d(13), end: d(20) },
    ]);
    expect(intersectRanges([{ start: d(10), end: d(20) }], [{ start: d(8), end: d(12) }, { start: d(19), end: d(22) }])).toEqual([
      { start: d(10), end: d(12) },
      { start: d(19), end: d(20) },
    ]);
  });
});

describe('crypto', () => {
  it('hashes and verifies passwords', async () => {
    const h = await hashPassword('correct horse');
    expect(await verifyPassword('correct horse', h)).toBe(true);
    expect(await verifyPassword('wrong', h)).toBe(false);
    expect(await verifyPassword('x', null)).toBe(false);
  });

  it('encrypts with AES-GCM and detects tampering', () => {
    const c = encrypt('secret-token');
    expect(c.startsWith('v1.')).toBe(true);
    expect(decrypt(c)).toBe('secret-token');
    const parts = c.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => decrypt(parts.join('.'))).toThrow();
  });

  it('signs payloads with expiry', () => {
    const t = signPayload({ k: 'a/b' }, 60);
    expect(verifySignedPayload<{ k: string }>(t)?.k).toBe('a/b');
    expect(verifySignedPayload(t.replace(/.$/, (ch) => (ch === 'A' ? 'B' : 'A')))).toBeNull();
    expect(verifySignedPayload(signPayload({ k: 'x' }, -1))).toBeNull();
  });
});

describe('misc', () => {
  it('renders templates safely', () => {
    expect(renderTemplate('{{customer.name}}様 {{ shop.name }} {{missing}}', { customer: { name: '山田' }, shop: { name: '本店' } })).toBe('山田様 本店 ');
    expect(templateVariables('{{a}} {{b.c}} {{a}}')).toEqual(['a', 'b.c']);
  });

  it('builds CSV with BOM, quoting and formula protection', () => {
    const csv = toCsv([{ key: 'a', label: '名前' }, { key: 'b', label: '値' }], [{ a: '=1+1', b: 'x,"y"' }, { a: -5, b: null }]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain(`'=1+1,"x,""y"""`);
    expect(csv).toContain('-5,');
  });

  it('round-trips cursors and paginates', () => {
    const c = encodeCursor(new Date('2026-01-01T00:00:00Z'), 'id-1');
    expect(decodeCursor(c)).toEqual({ v: '2026-01-01T00:00:00.000Z', id: 'id-1' });
    expect(() => decodeCursor('not-a-cursor')).toThrow();
    const page = paginate([{ id: '1' }, { id: '2' }, { id: '3' }], 2, (r) => r.id);
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();
  });

  it('defaults and deep-merges shop settings', () => {
    const s = parseShopSettings({});
    expect(s.booking.slotIntervalMin).toBe(15);
    expect(s.pos.pointRateBp).toBe(100);
    const m = mergeShopSettings(s, { booking: { leadTimeMin: 30 } });
    expect(m.booking.leadTimeMin).toBe(30);
    expect(m.booking.horizonDays).toBe(60);
    expect(() => mergeShopSettings(s, { booking: { slotIntervalMin: 1 } })).toThrow();
  });
});
