import { Context, Next } from 'hono';
import type { Bindings, Variables } from '../types';

// Generate HMAC-SHA256 signature for public endpoint access
// Token format: base64url(JSON({resource, exp})).signature
export async function generatePublicToken(
  resource: string,
  secret: string,
  expiresInHours: number = 72
): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + expiresInHours * 3600;
  const payload = btoa(JSON.stringify({ resource, exp }))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const signature = await sign(payload, secret);
  return `${payload}.${signature}`;
}

// Verify HMAC token and return resource identifier
export async function verifyPublicToken(
  token: string,
  secret: string
): Promise<{ resource: string } | null> {
  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [payload, signature] = parts;
  const expectedSig = await sign(payload, secret);

  if (!timingSafeEqual(signature, expectedSig)) return null;

  try {
    const padded = payload.replace(/-/g, '+').replace(/_/g, '/');
    const decoded = JSON.parse(atob(padded));

    if (!decoded.exp || decoded.exp < Math.floor(Date.now() / 1000)) return null;
    if (!decoded.resource) return null;

    return { resource: decoded.resource };
  } catch {
    return null;
  }
}

async function sign(data: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

// Middleware: validate public token from query parameter or header
export function requirePublicToken(resourceParam: string = 'id') {
  return async (c: Context<{ Bindings: Bindings; Variables: Variables }>, next: Next) => {
    const token = c.req.query('token') || c.req.header('X-Public-Token');
    if (!token) {
      return c.json({ error: 'Access token required' }, 403);
    }

    const secret = c.env.JWT_SECRET;
    if (!secret) {
      return c.json({ error: 'Server configuration error' }, 500);
    }

    const result = await verifyPublicToken(token, secret);
    if (!result) {
      return c.json({ error: 'Invalid or expired token' }, 403);
    }

    // Verify the token's resource matches the requested resource
    const requestedResource = c.req.param(resourceParam);
    if (requestedResource && result.resource !== requestedResource) {
      return c.json({ error: 'Token does not match requested resource' }, 403);
    }

    await next();
  };
}
