import { defineConfig } from '@playwright/test';

const port = process.env.PORTAL_PW_PORT ?? '3226';
export default defineConfig({
  testDir: '.',
  testMatch: 'portal.pw.mjs',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  outputDir: process.env.PORTAL_PW_OUT ?? '/tmp/intafaced-portal-browser-results',
  // PORTAL_CHROMIUM points at a browser binary when Playwright's own download is not on this machine.
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    headless: true,
    ...(process.env.PORTAL_CHROMIUM ? { launchOptions: { executablePath: process.env.PORTAL_CHROMIUM } } : {}),
  },
  webServer: {
    command: `pnpm --filter @intafaced/customer exec vite --host 127.0.0.1 --port ${port}`,
    url: `http://127.0.0.1:${port}`,
    cwd: new URL('../../../../../..', import.meta.url).pathname,
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
