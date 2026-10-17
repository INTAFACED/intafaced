import { defineConfig } from '@playwright/test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.ROOMS_HARNESS_PORT ?? 4351);
const shots = process.env.ROOMS_SHOTS ?? '/Users/Nitro/.codex/context/work/design/trade-rooms/TROPT/harness/';

// Runs the Options, Execution and Quote desk rooms in a bare harness page with a mocked API (TEST data only).
//   pnpm exec playwright test --config src/screens/trade/rooms/harness/rooms.playwright.config.mjs
// Screenshots go to ROOMS_SHOTS (outside the repo; reference images are never committed).
// Playwright's bundled headless Chromium is used, never the daily browser. Override with ROOMS_CHROMIUM.
const chromium =
  process.env.ROOMS_CHROMIUM ??
  join(homedir(), 'Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell');

export default defineConfig({
  testDir: here,
  testMatch: 'rooms.pw.mjs',
  workers: 1,
  retries: 0,
  timeout: 120000,
  expect: { timeout: 8000 },
  reporter: [['list']],
  outputDir: join(shots, 'browser-results'),
  webServer: {
    command: `pnpm exec vite --config ${join(here, 'rooms.harness.vite.config.mjs')}`,
    cwd: join(here, '../../../../..'),
    url: `http://127.0.0.1:${port}/`,
    env: { ROOMS_HARNESS_PORT: String(port) },
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
    launchOptions: { executablePath: chromium },
  },
});
