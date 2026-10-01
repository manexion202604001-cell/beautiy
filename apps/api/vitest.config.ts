import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    globalSetup: ['src/test/global-setup.ts'],
    setupFiles: ['src/test/setup.ts'],
    testTimeout: 30000,
    hookTimeout: 60000,
    fileParallelism: false,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://salon:salon@localhost:5432/salon_test',
      DATABASE_POOL_MAX: '10',
      DEV_EXPOSE_OTP: 'true',
      STORAGE_LOCAL_DIR: './storage-test',
      API_BASE_URL: 'http://localhost:4000',
    },
  },
});
