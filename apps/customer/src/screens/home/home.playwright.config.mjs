import { defineConfig } from '@playwright/test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.HOME_HARNESS_PORT ?? 4317);

// Runs the Home screen in a bare harness page with a mocked API. No real service is contacted.
//   pnpm exec playwright test --config apps/customer/src/screens/home/home.playwright.config.mjs
// Screenshots go to HOME_SHOTS (outside the repo; reference images are never committed).
export default defineConfig({
  testDir: here,
  testMatch: 'home.pw.mjs',
  workers: 1,
  retries: 0,
  timeout: 60000,
  expect: { timeout: 7000 },
  reporter: [['list']],
  outputDir: join(process.env.HOME_SHOTS ?? join(tmpdir(), 'intafaced-home-shots'), 'browser-results'),
  webServer: {
    command: `pnpm exec vite --config ${join(here, 'harness.vite.config.mjs')}`,
    cwd: join(here, '../../..'),
    url: `http://127.0.0.1:${port}/`,
    env: { HOME_HARNESS_PORT: String(port) },
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
    // Set HOME_CHROMIUM to a Chromium binary when the one Playwright expects is not installed.
    launchOptions: process.env.HOME_CHROMIUM ? { executablePath: process.env.HOME_CHROMIUM } : {},
  },
});
