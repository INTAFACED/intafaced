import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.',
  testMatch: 'quant-review.pw.mjs',
  workers: 1,
  retries: 0,
  timeout: 45000,
  expect: { timeout: 7000 },
  reporter: 'list',
  outputDir: process.env.QUANT_EVIDENCE + '/test-output',
  use: { baseURL: process.env.QUANT_BASE || 'http://127.0.0.1:3226', headless: true, timezoneId: 'UTC' },
});
