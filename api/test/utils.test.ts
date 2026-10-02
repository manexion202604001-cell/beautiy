import { afterEach, describe, expect, it, vi } from 'vitest';
import { generatePublicToken, verifyPublicToken } from '../src/utils/publicToken';
import { isProtectedImageKey, signImageUrl, verifyImageSig } from '../src/utils/imageSign';
import { generateTotp, generateTotpSecret, verifyTotp } from '../src/utils/totp';
import { sanitizeCustomer, sanitizeStaff, sanitizeStore } from '../src/utils/sanitize';

const SECRET = 'test-secret-0123456789abcdef0123456789';

afterEach(() => {
  vi.useRealTimers();
});

describe('publicToken', () => {
  it('round-trips the resource', async () => {
    const token = await generatePublicToken('reservation-1', SECRET);
    expect(await verifyPublicToken(token, SECRET)).toEqual({ resource: 'reservation-1' });
  });

  it('rejects a wrong secret or a tampered payload', async () => {
    const token = await generatePublicToken('reservation-1', SECRET);
    expect(await verifyPublicToken(token, 'other-secret')).toBeNull();
    const [, sig] = token.split('.');
    const forged = btoa(JSON.stringify({ resource: 'reservation-2', exp: 9999999999 })).replace(/=+$/, '');
    expect(await verifyPublicToken(`${forged}.${sig}`, SECRET)).toBeNull();
    expect(await verifyPublicToken('garbage', SECRET)).toBeNull();
  });

  it('rejects an expired token', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const token = await generatePublicToken('reservation-1', SECRET, 1);
    vi.setSystemTime(new Date('2026-01-01T01:00:01Z'));
    expect(await verifyPublicToken(token, SECRET)).toBeNull();
  });
});

describe('imageSign', () => {
  it('only signs karute images', async () => {
    expect(isProtectedImageKey('karutes/a.jpg')).toBe(true);
    expect(isProtectedImageKey('avatars/a.jpg')).toBe(false);
    expect(await signImageUrl('/images/avatars/a.jpg', SECRET)).toBe('/images/avatars/a.jpg');
  });

  it('verifies its own signature and rejects tampering', async () => {
    const url = new URL(await signImageUrl('/images/karutes/k1/a.jpg', SECRET), 'https://x');
    const exp = url.searchParams.get('exp')!;
    const sig = url.searchParams.get('sig')!;
    expect(await verifyImageSig('karutes/k1/a.jpg', exp, sig, SECRET)).toBe(true);
    expect(await verifyImageSig('karutes/k1/b.jpg', exp, sig, SECRET)).toBe(false);
    expect(await verifyImageSig('karutes/k1/a.jpg', String(Number(exp) + 1), sig, SECRET)).toBe(false);
    expect(await verifyImageSig('karutes/k1/a.jpg', exp, undefined, SECRET)).toBe(false);
  });

  it('rejects an expired signature', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const url = new URL(await signImageUrl('/images/karutes/k1/a.jpg', SECRET, 60), 'https://x');
    vi.setSystemTime(new Date('2026-01-01T00:01:01Z'));
    expect(await verifyImageSig('karutes/k1/a.jpg', url.searchParams.get('exp')!, url.searchParams.get('sig')!, SECRET)).toBe(false);
  });
});

describe('totp', () => {
  // RFC 6238 Appendix B (SHA-1), ASCII secret "12345678901234567890", truncated to 6 digits
  const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1234567890, '005924'],
  ])('matches the RFC 6238 vector at t=%i', async (t, code) => {
    expect(await generateTotp(RFC_SECRET, t)).toBe(code);
  });

  it('accepts the current code and ±1 step, rejects others', async () => {
    vi.useFakeTimers();
    const now = 1_790_000_000;
    vi.setSystemTime(now * 1000);
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]+$/);
    expect(await verifyTotp(secret, await generateTotp(secret, now))).toBe(true);
    expect(await verifyTotp(secret, await generateTotp(secret, now - 30))).toBe(true);
    expect(await verifyTotp(secret, await generateTotp(secret, now + 30))).toBe(true);
    expect(await verifyTotp(secret, await generateTotp(secret, now - 90))).toBe(false);
  });
});

describe('sanitize', () => {
  it('strips secrets from staff, store and customer rows', () => {
    const staff = sanitizeStaff({
      id: 's1', name: 'A', password_hash: 'x', totp_secret: 'x', password_reset_token: 'x',
      staff_line_channel_secret: 'x', staff_line_access_token: 'x', staff_line_channel_id: 'cid',
    });
    expect(staff).toEqual({ id: 's1', name: 'A', staff_line_channel_id: 'cid' });
    expect(sanitizeStore({ id: 'st', line_channel_secret: 'x', line_access_token: 'x', salonboard_password: 'x', lime_password: 'x' }))
      .toEqual({ id: 'st' });
    expect(sanitizeCustomer({ id: 'c', password_hash: 'x' })).toEqual({ id: 'c' });
    expect(sanitizeStaff(null)).toBeNull();
  });
});
