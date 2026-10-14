import { defineConfig } from '@playwright/test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.COIN_HARNESS_PORT ?? 4377);

// Runs the Coin page in a bare harness page with a mocked API. No real service is contacted.
//   pnpm exec playwright test --config apps/customer/src/screens/coin/coin.playwright.config.mjs
// Screenshots go to COIN_SHOTS (outside the repo; reference images are never committed).
export default defineConfig({
  testDir: here,
  testMatch: 'coin.pw.mjs',
  workers: 1,
  retries: 0,
  timeout: 90000,
  expect: { timeout: 7000 },
  reporter: [['list']],
  outputDir: join(process.env.COIN_SHOTS ?? join(tmpdir(), 'intafaced-coin-shots'), 'browser-results'),
  webServer: {
    command: `pnpm exec vite --config ${join(here, 'coin.harness.vite.config.mjs')}`,
    cwd: join(here, '../../..'),
    url: `http://127.0.0.1:${port}/`,
    env: { COIN_HARNESS_PORT: String(port) },
    reuseExistingServer: false,
    timeout: 60000,
  },
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    headless: true,
    timezoneId: 'UTC',
    locale: 'en-US',
    viewport: { width: 1440, height: 900 },
    trace: 'off',
    video: 'off',
    screenshot: 'off',
    // Set COIN_CHROMIUM to a Chromium binary when the one Playwright expects is not installed.
    launchOptions: process.env.COIN_CHROMIUM ? { executablePath: process.env.COIN_CHROMIUM } : {},
  },
});
