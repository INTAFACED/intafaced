import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'loans.pw.mjs',
  workers: 1,
  fullyParallel: false,
  reporter: 'list',
  outputDir: '/tmp/intafaced-loans-browser-results',
  use: { baseURL: 'http://127.0.0.1:3227', headless: true },
  webServer: {
    command: 'pnpm --filter @intafaced/customer exec vite --host 127.0.0.1 --port 3227',
    url: 'http://127.0.0.1:3227',
    cwd: new URL('../../..', import.meta.url).pathname,
    reuseExistingServer: false,
    timeout: 30000,
  },
});
