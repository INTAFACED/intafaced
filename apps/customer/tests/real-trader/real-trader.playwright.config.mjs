import { defineConfig } from '@playwright/test';

// The stack serves the built customer app on :3210 and proxies the API through the edge; nothing is mocked.
export default defineConfig({
  testDir: '.',
  testMatch: 'real-trader.pw.mjs',
  workers: 1,
  fullyParallel: false,
  reporter: 'list',
  timeout: 120000,
  outputDir: process.env.REAL_TRADER_OUTPUT ?? '/tmp/intafaced-real-trader-results',
  use: { baseURL: process.env.REAL_TRADER_URL ?? 'http://127.0.0.1:3210', headless: true },
});
