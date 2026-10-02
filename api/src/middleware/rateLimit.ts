import { Context, Next } from 'hono';
import type { Bindings, Variables } from '../types';

// Simple rate limiter using D1
// Uses a table to track request counts per IP+endpoint within a time window
export function rateLimit(maxRequests: number, windowSeconds: number) {
  return async (c: Context<{ Bindings: Bindings; Variables: Variables }>, next: Next) => {
    const ip = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || 'unknown';
    const endpoint = c.req.path;
    const key = `${ip}:${endpoint}`;
    const now = Math.floor(Date.now() / 1000);
    const windowStart = now - windowSeconds;

    try {
      // Clean old entries and count recent requests in one go
      const result = await c.env.DB.prepare(
        `SELECT COUNT(*) as count FROM rate_limits WHERE key = ? AND timestamp > ?`
      ).bind(key, windowStart).first<{ count: number }>();

      const count = result?.count || 0;

      if (count >= maxRequests) {
        return c.json(
          { error: 'Too many requests. Please try again later.' },
          429
        );
      }

      // Record this request
      await c.env.DB.prepare(
        `INSERT INTO rate_limits (key, timestamp) VALUES (?, ?)`
      ).bind(key, now).run();

      // Cleanup old entries (fire-and-forget, don't block the request)
      c.executionCtx.waitUntil(
        c.env.DB.prepare(
          `DELETE FROM rate_limits WHERE timestamp < ?`
        ).bind(windowStart - 60).run()
      );
    } catch (e) {
      // If rate limiting fails (e.g., table doesn't exist), allow the request
      console.error('Rate limit error:', e);
    }

    await next();
  };
}
