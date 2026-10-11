import { defineConfig } from '@playwright/test';
process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';
export default defineConfig({
  testDir: '.',
  testMatch: 'money.browser.pw.mjs',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  outputDir: process.env.MONEY_PROOF_DIR ?? '/tmp/intafaced-money-browser-results',
  use: { baseURL: 'http://127.0.0.1:3216', headless: true, timezoneId: 'UTC' },
  webServer: {
    command: 'pnpm --filter @intafaced/customer exec vite --host 127.0.0.1 --port 3216',
    url: 'http://127.0.0.1:3216',
    cwd: new URL('../../../../..', import.meta.url).pathname,
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
