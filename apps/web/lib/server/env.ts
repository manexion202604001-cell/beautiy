import { keysFrom, type CryptoKeys } from '@salonos/core/crypto';

const isProd = process.env.NODE_ENV === 'production';

function secret(name: string, devFallback: string): string {
  const v = process.env[name];
  if (v) return v;
  if (isProd && process.env.DEMO_MODE !== '1') throw new Error(`${name} is required in production`);
  return devFallback;
}

export const env = {
  get appUrl() { return (process.env.APP_URL ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000')).replace(/\/$/, ''); },
  get cronSecret() { return secret('CRON_SECRET', 'dev-cron-secret'); },
  /** Demo/sandbox mode: OTP codes are shown on screen, external sends are simulated. */
  get demoMode() { return !isProd || process.env.DEMO_MODE === '1'; },
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
