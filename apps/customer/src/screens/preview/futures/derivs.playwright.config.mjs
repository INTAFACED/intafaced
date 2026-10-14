import { defineConfig } from '@playwright/test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const preview = join(here, '../../../preview');
const port = Number(process.env.DERIVS_HARNESS_PORT ?? 4373);

// Runs the whole customer App in the shared Preview harness page with a mocked API. No real service is contacted.
// One config for the three derivatives Preview screens (futures, options, margin); each has its own test file next to its screen.
//   pnpm exec playwright test --config apps/customer/src/screens/preview/futures/derivs.playwright.config.mjs
// Screenshots go to DERIVS_SHOTS (outside the repo; reference images are never committed).
export default defineConfig({
  testDir: join(here, '..'),
  testMatch: '{futures,options,margin}/*.pw.mjs',
  workers: 1,
  retries: 0,
  timeout: 90000,
  expect: { timeout: 8000 },
  reporter: [['list']],
  outputDir: join(process.env.DERIVS_SHOTS ?? join(tmpdir(), 'intafaced-derivs-shots'), 'browser-results'),
  webServer: {
    command: `pnpm exec vite --config ${join(preview, 'harness.vite.config.mjs')}`,
    cwd: join(here, '../../../..'),
    url: `http://127.0.0.1:${port}/`,
    env: { PREVIEW_HARNESS_PORT: String(port), VITE_PREVIEW_PRODUCTS: '1' },
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
    // Set DERIVS_CHROMIUM to a Chromium binary when the one Playwright expects is not installed.
    launchOptions: process.env.DERIVS_CHROMIUM ? { executablePath: process.env.DERIVS_CHROMIUM } : {},
  },
});
