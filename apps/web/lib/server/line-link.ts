// Signed links that carry a LINE userId into the public booking flow
// (e.g. rich-menu "予約する" → /book/<shop>?lk=<token>) so the booking is
// attached to the customer's LINE identity without requiring an account.
import { hmacHex, safeEqual } from '@salonos/core/crypto';
import { cryptoKeys } from './env';

const TTL_MS = 7 * 86400000;

function sign(payload: string) {
  return hmacHex(cryptoKeys().hashKey.toString('hex'), `line-link:${payload}`).slice(0, 32);
}

export function signLineLink(orgId: string, lineUserId: string, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ o: orgId, u: lineUserId, e: now + TTL_MS })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export function verifyLineLink(token: string | null | undefined, now = Date.now()): { orgId: string; lineUserId: string } | null {
  if (!token) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig || !safeEqual(sig, sign(payload))) return null;
  try {
    const j = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof j.e !== 'number' || j.e < now) return null;
    return { orgId: String(j.o), lineUserId: String(j.u) };
  } catch { return null; }
}
