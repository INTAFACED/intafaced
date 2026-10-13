import { defineConfig } from '@playwright/test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.TRADE_HARNESS_PORT ?? 4327);
const shots = process.env.TRADE_SHOTS ?? join(tmpdir(), 'intafaced-trade-shots');

// Runs the Buy and Convert screens in a bare harness page with a mocked API. No real service is contacted.
//   pnpm exec playwright test --config apps/customer/src/screens/trade/buy/trade.playwright.config.mjs
// Screenshots go to TRADE_SHOTS (outside the repo; reference images are never committed).
export default defineConfig({
  testDir: join(here, '..'),
  testMatch: ['buy/buy.pw.mjs', 'convert/convert.pw.mjs'],
  workers: 1,
  retries: 0,
  timeout: 90000,
  expect: { timeout: 7000 },
  reporter: [['list']],
  outputDir: join(shots, 'browser-results'),
  webServer: {
    command: `pnpm exec vite --config ${join(here, 'harness.vite.config.mjs')}`,
    cwd: join(here, '../../../..'),
    url: `http://127.0.0.1:${port}/`,
    env: { TRADE_HARNESS_PORT: String(port) },
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
    // Set TRADE_CHROMIUM to a Chromium binary when the one Playwright expects is not installed.
    launchOptions: process.env.TRADE_CHROMIUM ? { executablePath: process.env.TRADE_CHROMIUM } : {},
  },
});
