import { defineConfig, devices } from '@playwright/test';

/**
 * E2E smoke tests (optional): `pnpm --filter @salon/web test:e2e`
 * Prerequisites (see README):
 *  - API running with a seeded DB (default http://localhost:4100, DEV_EXPOSE_OTP=true)
 *  - Web dev server (started automatically unless E2E_BASE_URL is given)
 *  - Chromium: PLAYWRIGHT_BROWSERS_PATH (or PW_CHROMIUM_PATH for a custom executable)
 */
const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
const executablePath = process.env.PW_CHROMIUM_PATH || undefined;

export default defineConfig({
  testDir: './e2e',
  testIgnore: process.env.SCREENSHOTS ? [] : ['**/screenshots.spec.ts'],
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL,
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    trace: 'retain-on-failure',
    launchOptions: executablePath ? { executablePath } : undefined,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: 'pnpm exec vite --port 5173 --strictPort',
        url: baseURL,
        reuseExistingServer: true,
        timeout: 60_000,
      },
});
