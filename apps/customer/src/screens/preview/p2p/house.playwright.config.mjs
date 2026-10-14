import { defineConfig } from '@playwright/test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const previewDir = join(here, '../../../preview');
const port = Number(process.env.PREVIEW_HARNESS_PORT ?? 4381);

// Runs the Preview screens of the "house" batch (P2P, Card, IFC, Academy) inside the real App with a mocked API.
//   pnpm exec playwright test --config apps/customer/src/screens/preview/p2p/house.playwright.config.mjs --workers=1
// It reuses the shared harness page (src/preview/harness). Screenshots go to PREVIEW_SHOTS (outside the repo).
export default defineConfig({
  testDir: join(here, '..'),
  testMatch: ['p2p/p2p.pw.mjs', 'card/card.pw.mjs', 'ifc/ifc.pw.mjs', 'academy/academy.pw.mjs'],
  workers: 1,
  retries: 0,
  timeout: 90000,
  expect: { timeout: 8000 },
  reporter: [['list']],
  outputDir: join(process.env.PREVIEW_SHOTS ?? join(tmpdir(), 'intafaced-house-shots'), 'browser-results'),
  webServer: {
    command: `pnpm exec vite --config ${join(previewDir, 'harness.vite.config.mjs')}`,
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
    // Set PREVIEW_CHROMIUM to a Chromium binary when the one Playwright expects is not installed.
    launchOptions: process.env.PREVIEW_CHROMIUM ? { executablePath: process.env.PREVIEW_CHROMIUM } : {},
  },
});
