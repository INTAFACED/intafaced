import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.',
  testMatch: 'repeat-buy.pw.mjs',
  workers: 1,
  fullyParallel: false,
  reporter: 'list',
  outputDir: '/tmp/intafaced-repeat-buy-browser-results',
  use: { baseURL: 'http://127.0.0.1:3225', headless: true, timezoneId: 'UTC' },
  webServer: {
    command: 'pnpm --filter @intafaced/customer exec vite --host 127.0.0.1 --port 3225',
    url: 'http://127.0.0.1:3225',
    cwd: new URL('../../..', import.meta.url).pathname,
    reuseExistingServer: false,
    timeout: 30000,
  },
});
