import { defineConfig } from '@playwright/test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PREVIEW_HARNESS_PORT ?? 4371);

// Runs the whole customer App in a bare harness page with a mocked API. No real service is contacted.
//   pnpm exec playwright test --config apps/customer/src/preview/preview.playwright.config.mjs
// PREVIEW_HARNESS_FLAG=0 runs the same page as a production build would by default (Preview off).
// Screenshots go to PREVIEW_SHOTS (outside the repo; reference images are never committed).
export default defineConfig({
  testDir: here,
  testMatch: 'preview.pw.mjs',
  workers: 1,
  retries: 0,
  timeout: 90000,
  expect: { timeout: 8000 },
  reporter: [['list']],
  outputDir: join(process.env.PREVIEW_SHOTS ?? join(tmpdir(), 'intafaced-preview-shots'), 'browser-results'),
  webServer: {
    command: `pnpm exec vite --config ${join(here, 'harness.vite.config.mjs')}`,
    cwd: join(here, '../..'),
    url: `http://127.0.0.1:${port}/`,
    env: { PREVIEW_HARNESS_PORT: String(port), VITE_PREVIEW_PRODUCTS: process.env.PREVIEW_HARNESS_FLAG ?? '' },
    reuseExistingServer: false,
    timeout: 90000,
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
    // Set PREVIEW_CHROMIUM to a Chromium binary when the one Playwright expects is not installed.
    launchOptions: process.env.PREVIEW_CHROMIUM ? { executablePath: process.env.PREVIEW_CHROMIUM } : {},
  },
});
