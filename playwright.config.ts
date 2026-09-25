import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

// The spec files sign LINE links and read ids with the same secrets/DB as the dev server,
// which reads the repo-root .env. process.loadEnvFile never overrides variables already set.
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch { /* no .env: rely on the environment */ }

const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const MOBILE_SPEC = /booking-mobile\.spec\.ts/;

export default defineConfig({
  testDir: 'apps/web/tests/e2e',
  // dev-mode compiles each route on first hit, so keep the budgets generous
  timeout: 300_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 2 : 1,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL,
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    trace: 'on-first-retry',
    actionTimeout: 30_000,
    navigationTimeout: 120_000,
    launchOptions: { executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' },
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] }, testIgnore: MOBILE_SPEC },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, testMatch: MOBILE_SPEC },
  ],
  webServer: {
    command: 'npm run dev -w @salonos/web',
    url: `${baseURL}/login`,
    reuseExistingServer: true,
    timeout: 240_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
