import { defineConfig } from '@playwright/test';
process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';
export default defineConfig({
  testDir: '.',
  testMatch: 'market-review.pw.mjs',
  workers: 1,
  retries: 0,
  timeout: 45000,
  expect: { timeout: 7000 },
  reporter: 'list',
  outputDir: (process.env.MARKET_REVIEW_EVIDENCE || '/tmp/intafaced-market-review') + '/browser-results',
  use: { baseURL: 'http://127.0.0.1:3230', headless: true, timezoneId: 'UTC' },
});
