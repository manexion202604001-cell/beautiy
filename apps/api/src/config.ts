import { existsSync } from 'node:fs';
import { z } from 'zod';

// Load .env for local development (tests configure env explicitly)
if (process.env.NODE_ENV !== 'test' && existsSync('.env')) process.loadEnvFile('.env');

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(4000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.string().default('info'),
  DATABASE_URL: z.string().default('postgres://salon:salon@localhost:5432/salon'),
  DATABASE_POOL_MAX: z.coerce.number().int().default(20),
  /** Public base URL of the API (used for signed upload URLs / webhooks) */
  API_BASE_URL: z.string().default('http://localhost:4000'),
  /** Public base URL of the web app (customer-facing links) */
  WEB_BASE_URL: z.string().default('http://localhost:5173'),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  /** Trust X-Forwarded-* headers: false | true | hop count | comma-separated proxy IPs/CIDRs (set behind a load balancer) */
  TRUST_PROXY: z.string().default('false'),
  JWT_SECRET: z.string().min(32).default('dev-only-jwt-secret-change-me-0123456789abcdef'),
  JWT_ACCESS_TTL_SEC: z.coerce.number().int().default(900),
  JWT_REFRESH_TTL_SEC: z.coerce.number().int().default(60 * 60 * 24 * 30),
  CUSTOMER_JWT_TTL_SEC: z.coerce.number().int().default(60 * 60 * 24 * 7),
  /** 32-byte key (base64) for AES-256-GCM encryption of credentials */
  ENCRYPTION_KEY: z.string().default('ZGV2LW9ubHktZW5jcnlwdGlvbi1rZXktMzJieXRlcyE='),
  /** HMAC secret for opaque access tokens & signed URLs */
  TOKEN_SECRET: z.string().default('dev-only-token-secret-change-me'),
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('./storage'),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().optional(),
  S3_ENDPOINT: z.string().optional(),
  /** Messaging: 'mock' logs instead of sending (default for dev/test) */
  LINE_DRIVER: z.enum(['mock', 'live']).default('mock'),
  EMAIL_DRIVER: z.enum(['mock', 'smtp']).default('mock'),
  SMS_DRIVER: z.enum(['mock', 'live']).default('mock'),
  PAYMENT_PROVIDER: z.enum(['mock', 'stripe']).default('mock'),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-5-5'),
  WORKER_CONCURRENCY: z.coerce.number().int().default(4),
  WORKER_POLL_MS: z.coerce.number().int().default(1000),
  RATE_LIMIT_MAX: z.coerce.number().int().default(300),
  /** Expose OTP codes in API responses (dev/test only, never production) */
  DEV_EXPOSE_OTP: bool.default(false),
});

export type Config = z.infer<typeof schema>;

function load(): Config {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`Invalid environment configuration: ${parsed.error.message}`);
  }
  const cfg = parsed.data;
  if (cfg.NODE_ENV === 'production') {
    if (cfg.JWT_SECRET.startsWith('dev-only') || cfg.TOKEN_SECRET.startsWith('dev-only')) {
      throw new Error('JWT_SECRET / TOKEN_SECRET must be set in production');
    }
    if (cfg.DEV_EXPOSE_OTP) throw new Error('DEV_EXPOSE_OTP must be false in production');
  }
  return cfg;
}

export const config = load();

export function trustProxySetting(): boolean | string | ((address: string, hop: number) => boolean) {
  const v = config.TRUST_PROXY.trim();
  if (v === 'true') return true;
  if (v === 'false' || v === '') return false;
  if (/^\d+$/.test(v)) {
    const hops = Number(v);
    return (_address, hop) => hop < hops;
  }
  return v;
}
