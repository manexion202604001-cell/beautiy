import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  scrypt as scryptCb,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';
import { config } from '../config.js';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/** Password hash format: scrypt$N$r$p$saltB64$hashB64 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return false;
  const [algo, n, r, p, saltB64, hashB64] = stored.split('$');
  if (algo !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT.maxmem,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

export function hmacSha256(secret: string | Buffer, input: string | Buffer, encoding: 'hex' | 'base64' | 'base64url' = 'hex') {
  return createHmac('sha256', secret).update(input).digest(encoding);
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** URL-safe random token (default 32 bytes = 256 bits) */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Hash for storing opaque tokens (refresh tokens, access links). Keyed so DB leak alone is insufficient. */
export function hashToken(token: string): string {
  return hmacSha256(config.TOKEN_SECRET, token);
}

/** Numeric OTP code */
export function otpCode(digits = 6): string {
  return String(randomInt(0, 10 ** digits)).padStart(digits, '0');
}

/** Human-friendly reference code without ambiguous chars (0/O, 1/I/L) */
export function referenceCode(length = 8): string {
  const alphabet = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[randomInt(0, alphabet.length)];
  return out;
}

function encryptionKey(): Buffer {
  const key = Buffer.from(config.ENCRYPTION_KEY, 'base64');
  if (key.length !== 32) throw new Error('ENCRYPTION_KEY must be 32 bytes base64');
  return key;
}

/** AES-256-GCM. Output: v1.<iv>.<tag>.<ciphertext> (base64url) */
export function encrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
}

export function decrypt(payload: string): string {
  const [v, ivB, tagB, ctB] = payload.split('.');
  if (v !== 'v1' || !ivB || !tagB || ctB === undefined) throw new Error('Unsupported ciphertext format');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivB, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ctB, 'base64url')), decipher.final()]).toString('utf8');
}

export function encryptJson(value: unknown): string {
  return encrypt(JSON.stringify(value));
}

export function decryptJson<T = unknown>(payload: string): T {
  return JSON.parse(decrypt(payload)) as T;
}

/** Signed, expiring compact token: base64url(json).sig — used for upload/download URLs */
export function signPayload(payload: Record<string, unknown>, ttlSec: number): string {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec })).toString(
    'base64url',
  );
  return `${body}.${hmacSha256(config.TOKEN_SECRET, body, 'base64url')}`;
}

export function verifySignedPayload<T extends Record<string, unknown>>(token: string): T | null {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  if (!safeEqual(sig, hmacSha256(config.TOKEN_SECRET, body, 'base64url'))) return null;
  const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T & { exp: number };
  if (typeof data.exp !== 'number' || data.exp < Math.floor(Date.now() / 1000)) return null;
  return data;
}
