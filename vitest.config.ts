import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@salonos/core': path.resolve(__dirname, 'packages/core/src'),
      '@salonos/db': path.resolve(__dirname, 'packages/db/src'),
      '@': path.resolve(__dirname, 'apps/web'),
    },
  },
  test: {
    include: ['packages/**/test/**/*.test.ts', 'apps/web/tests/**/*.test.ts'],
    environment: 'node',
    // integration tests share one Postgres database
    fileParallelism: false,
    testTimeout: 30000,
    env: { DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://salonos:salonos@localhost:5432/salonos_test', PII_ENCRYPTION_KEY: 'test-encryption-key-123456', PII_HASH_KEY: 'test-hash-key-1234567' },
    globalSetup: ['apps/web/tests/integration/global-setup.ts'],
  },
});
