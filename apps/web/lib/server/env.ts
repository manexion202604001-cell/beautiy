import { keysFrom, type CryptoKeys } from '@salonos/core/crypto';

/**
 * Secrets never fall back to the built-in development constants in production — not even
 * with DEMO_MODE=1 (the constants are public, so PII encryption / blind indexes / cron auth
 * would be forgeable). DEMO_MODE only controls demo UX (OTP shown on screen, demo hints).
 */
export function secret(name: string, devFallback: string, prod = process.env.NODE_ENV === 'production'): string {
  const v = process.env[name];
  if (v && prod && v === devFallback) throw new Error(`${name} is set to the public development default; use a random secret in production`);
  if (v) return v;
  if (prod) throw new Error(`${name} is required in production (set it in the environment; DEMO_MODE does not provide a default)`);
  return devFallback;
}

export const env = {
  get appUrl() { return (process.env.APP_URL ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000')).replace(/\/$/, ''); },
  get cronSecret() { return secret('CRON_SECRET', 'dev-cron-secret'); },
  /** Demo UX only: OTP codes are shown on screen and demo hints rendered. Never relaxes secrets. */
  get demoMode() { return process.env.NODE_ENV !== 'production' || process.env.DEMO_MODE === '1'; },
  get s3() {
    const endpoint = process.env.S3_ENDPOINT, bucket = process.env.S3_BUCKET;
    if (!bucket || !process.env.S3_ACCESS_KEY || !process.env.S3_SECRET_KEY) return null;
    return { endpoint, bucket, accessKeyId: process.env.S3_ACCESS_KEY!, secretAccessKey: process.env.S3_SECRET_KEY!, region: process.env.S3_REGION ?? 'ap-northeast-1' };
  },
  get line() {
    return { channelSecret: process.env.LINE_CHANNEL_SECRET ?? '', accessToken: process.env.LINE_MESSAGING_CHANNEL_ACCESS_TOKEN ?? '' };
  },
  get stripe() { return { secretKey: process.env.STRIPE_SECRET_KEY ?? '', webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? '' }; },
  get square() { return { accessToken: process.env.SQUARE_ACCESS_TOKEN ?? '', signatureKey: process.env.SQUARE_WEBHOOK_SIGNATURE_KEY ?? '' }; },
};

let keys: CryptoKeys | null = null;
export function cryptoKeys(): CryptoKeys {
  if (!keys) keys = keysFrom(
    secret('PII_ENCRYPTION_KEY', 'dev-only-change-me-32bytes-minimum-key!!'),
    secret('PII_HASH_KEY', 'dev-only-hash-key-change-me'),
  );
  return keys;
}
