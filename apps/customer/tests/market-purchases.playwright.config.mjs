import { defineConfig } from '@playwright/test';
process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';
export default defineConfig({
  testDir: '.',
  testMatch: 'market-purchases.pw.mjs',
  workers: 1,
  retries: 0,
  timeout: 45000,
  expect: { timeout: 7000 },
  reporter: 'list',
  outputDir: process.env.MARKET_PURCHASES_EVIDENCE
    ? process.env.MARKET_PURCHASES_EVIDENCE + '/browser-results'
    : '/tmp/intafaced-market-purchases-results',
  use: { baseURL: 'http://127.0.0.1:3230', headless: true, timezoneId: 'UTC' },
});
