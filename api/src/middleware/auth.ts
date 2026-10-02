import { Context, Next } from 'hono';
import { getCookie } from 'hono/cookie';
import * as jose from 'jose';
import type { Bindings, Variables, Staff, Customer } from '../types';

export async function getJwtSecret(c: Pick<Context<{ Bindings: Bindings }>, 'env'>) {
  const secret = c.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET environment variable is not set');
  }
  return new TextEncoder().encode(secret);
}

export async function signToken(
  payload: { sub: string; type: 'staff' | 'customer'; role?: string; storeId?: string },
  c: Pick<Context<{ Bindings: Bindings }>, 'env'>
) {
  const secret = await getJwtSecret(c);
  return await new jose.SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(secret);
}

export async function verifyToken(
  token: string,
  c: Pick<Context<{ Bindings: Bindings }>, 'env'>
): Promise<jose.JWTPayload | null> {
  try {
    const secret = await getJwtSecret(c);
    const { payload } = await jose.jwtVerify(token, secret);
    return payload;
  } catch {
    return null;
  }
}

// Staff authentication middleware
export async function staffAuth(
  c: Context<{ Bindings: Bindings; Variables: Variables }>,
  next: Next
) {
  const token = getCookie(c, 'auth_token') || c.req.header('Authorization')?.replace('Bearer ', '');

  if (!token) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const payload = await verifyToken(token, c);
  if (!payload || payload.type !== 'staff') {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  // Get staff from database
  const staff = await c.env.DB.prepare('SELECT * FROM staff WHERE id = ? AND is_active = 1')
    .bind(payload.sub)
    .first<Staff>();

  if (!staff) {
    return c.json({ error: 'Staff not found' }, 401);
  }

  c.set('staff', staff);
  await next();
}

// Customer authentication middleware
export async function customerAuth(
  c: Context<{ Bindings: Bindings; Variables: Variables }>,
  next: Next
) {
  const token =
    getCookie(c, 'customer_token') || c.req.header('Authorization')?.replace('Bearer ', '');

  if (!token) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const payload = await verifyToken(token, c);
  if (!payload || payload.type !== 'customer') {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  // Get customer from database
  const customer = await c.env.DB.prepare('SELECT * FROM customers WHERE id = ?')
    .bind(payload.sub)
    .first<Customer>();

  if (!customer) {
    return c.json({ error: 'Customer not found' }, 401);
  }

  c.set('customer', customer);
  await next();
}

// Role-based access control
export function requireRole(...roles: Staff['role'][]) {
  return async (c: Context<{ Bindings: Bindings; Variables: Variables }>, next: Next) => {
    const staff = c.get('staff');
    if (!staff) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    if (!roles.includes(staff.role)) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    await next();
  };
}

// Check if staff can access store
export function requireStoreAccess() {
  return async (c: Context<{ Bindings: Bindings; Variables: Variables }>, next: Next) => {
    const staff = c.get('staff');
    if (!staff) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    // system_admin can access all stores
    if (staff.role === 'system_admin') {
      await next();
      return;
    }

    // Other roles can only access their own store
    const storeId = c.req.param('storeId') || c.req.query('store_id');
    if (storeId && staff.store_id !== storeId) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    await next();
  };
}

// RPi API key authentication middleware
export async function rpiApiKeyAuth(
  c: Context<{ Bindings: Bindings; Variables: Variables }>,
  next: Next
) {
  const apiKey = c.req.header('X-RPI-API-Key');
  const expectedKey = c.env.RPI_API_KEY;

  if (!expectedKey || !apiKey || apiKey !== expectedKey) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  await next();
}

// Password hashing utilities
// New format: pbkdf2$<iterations>$<salt-hex>$<hash-hex>
// Legacy format (unsalted SHA-256): 64-char hex — still verifiable; rehashed on next login
const PBKDF2_ITERATIONS = 100000;

function toHex(buf: ArrayBuffer | Uint8Array): string {
  return Array.from(buf instanceof Uint8Array ? buf : new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    keyMaterial, 256
  );
  return toHex(bits);
}

async function sha256Legacy(password: string): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(password));
  return toHex(hashBuffer);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toHex(salt)}$${hash}`;
}

// True if the stored hash is the legacy unsalted SHA-256 format
export function isLegacyHash(hash: string): boolean {
  return !hash.startsWith('pbkdf2$');
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  if (isLegacyHash(hash)) {
    return timingSafeEqualHex(await sha256Legacy(password), hash);
  }
  const [, iterStr, saltHex, expected] = hash.split('$');
  const iterations = parseInt(iterStr, 10);
  if (!iterations || !saltHex || !expected) return false;
  const actual = await pbkdf2(password, fromHex(saltHex), iterations);
  return timingSafeEqualHex(actual, expected);
}

// Rehash a legacy password to PBKDF2 after successful verification (fire-and-forget safe)
export async function rehashIfLegacy(
  db: D1Database,
  table: 'staff' | 'customers',
  id: string,
  password: string,
  currentHash: string
): Promise<void> {
  if (!isLegacyHash(currentHash)) return;
  try {
    const newHash = await hashPassword(password);
    await db.prepare(`UPDATE ${table} SET password_hash = ? WHERE id = ? AND password_hash = ?`)
      .bind(newHash, id, currentHash).run();
  } catch (e) {
    console.error('Password rehash failed:', e instanceof Error ? e.message : String(e));
  }
}
