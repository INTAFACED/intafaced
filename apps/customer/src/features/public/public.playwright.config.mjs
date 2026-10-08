import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'public.browser.pw.mjs',
  workers: 1,
  fullyParallel: false,
  reporter: 'list',
  outputDir: '/tmp/intafaced-public-locale-results',
  use: { baseURL: 'http://127.0.0.1:3222', headless: true },
  webServer: {
    command: 'pnpm --filter @intafaced/customer exec vite --host 127.0.0.1 --port 3222',
    url: 'http://127.0.0.1:3222',
    cwd: new URL('../../../../..', import.meta.url).pathname,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
