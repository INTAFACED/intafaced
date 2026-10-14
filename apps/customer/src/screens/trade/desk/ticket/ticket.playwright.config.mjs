import { defineConfig } from '@playwright/test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.TICKET_HARNESS_PORT ?? 4351);

// Runs the Pro desk's ticket v2 in the desk's bare harness page with a mocked API. No real service is contacted.
//   pnpm exec playwright test --config apps/customer/src/screens/trade/desk/ticket/ticket.playwright.config.mjs
// Screenshots go to TICKET_SHOTS (outside the repo; reference images are never committed).
export default defineConfig({
  testDir: here,
  testMatch: 'ticket.pw.mjs',
  workers: 1,
  retries: 0,
  timeout: 90000,
  expect: { timeout: 8000 },
  reporter: [['list']],
  outputDir: join(process.env.TICKET_SHOTS ?? join(tmpdir(), 'intafaced-ticket-shots'), 'browser-results'),
  webServer: {
    command: `pnpm exec vite --config ${join(here, '../desk.harness.vite.config.mjs')}`,
    cwd: join(here, '../../../../..'),
    url: `http://127.0.0.1:${port}/`,
    env: { DESK_HARNESS_PORT: String(port) },
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
    // Set TICKET_CHROMIUM to a Chromium binary when the one Playwright expects is not installed.
    launchOptions: process.env.TICKET_CHROMIUM ? { executablePath: process.env.TICKET_CHROMIUM } : {},
  },
});
