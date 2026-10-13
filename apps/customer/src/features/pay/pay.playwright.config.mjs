import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'pay.browser.pw.mjs',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  outputDir: process.env.PAY_PROOF_DIR ?? '/tmp/intafaced-pay-browser-results',
  use: { baseURL: 'http://127.0.0.1:3214', headless: true },
  webServer: {
    command: 'pnpm --filter @intafaced/customer exec vite --host 127.0.0.1 --port 3214',
    url: 'http://127.0.0.1:3214',
    cwd: new URL('../../../../..', import.meta.url).pathname,
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
