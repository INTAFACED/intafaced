import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'session-persist.pw.mjs',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 8_000 },
  reporter: 'list',
  outputDir: '/tmp/intafaced-session-persist-results',
  use: {
    baseURL: 'http://127.0.0.1:3241',
    headless: true,
    // Optional: point at an already-installed Chromium when the pinned download is absent.
    ...(process.env.PW_CHROMIUM ? { launchOptions: { executablePath: process.env.PW_CHROMIUM } } : {}),
  },
  webServer: {
    command: 'pnpm --filter @intafaced/customer exec vite --host 127.0.0.1 --port 3241 --strictPort',
    url: 'http://127.0.0.1:3241',
    cwd: new URL('../../..', import.meta.url).pathname,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
