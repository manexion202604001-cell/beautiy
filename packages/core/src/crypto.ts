// Server-only crypto: PII field encryption, blind indexes, tokens, password hashing.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';

function deriveKey(secret: string, label: string): Buffer {
  return createHash('sha256').update(`${label}:${secret}`).digest();
}

export interface CryptoKeys { encKey: Buffer; hashKey: Buffer }

export function keysFrom(encSecret: string, hashSecret: string): CryptoKeys {
  if (!encSecret || encSecret.length < 16) throw new Error('PII_ENCRYPTION_KEY must be at least 16 chars');
  if (!hashSecret || hashSecret.length < 16) throw new Error('PII_HASH_KEY must be at least 16 chars');
  return { encKey: deriveKey(encSecret, 'pii-enc-v1'), hashKey: deriveKey(hashSecret, 'pii-idx-v1') };
}

/** AES-256-GCM. Output: v1.<iv>.<tag>.<ciphertext> (base64url). */
export function encrypt(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

export function decrypt(blob: string, key: Buffer): string {
  const [v, iv, tag, ct] = blob.split('.');
  if (v !== 'v1' || !iv || !tag || ct === undefined) throw new Error('bad ciphertext');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}

/** Deterministic HMAC for equality search over encrypted fields. */
export function blindIndex(normalized: string, key: Buffer): string {
  return createHmac('sha256', key).update(normalized).digest('base64url');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function otpCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [alg, s, h] = stored.split('$');
  if (alg !== 'scrypt' || !s || !h) return false;
  const expected = Buffer.from(h, 'base64url');
  const actual = scryptSync(pw, Buffer.from(s, 'base64url'), expected.length, { N: 16384, r: 8, p: 1 });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function hmacHex(secret: string, data: string): string {
  return createHmac('sha256', secret).update(data).digest('hex');
}

export function hmacBase64(secret: string, data: string): string {
  return createHmac('sha256', secret).update(data).digest('base64');
}
