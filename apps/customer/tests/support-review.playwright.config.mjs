import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.', testMatch: 'support-review.pw.mjs', workers: 1, timeout: 40000,
  outputDir: (process.env.SUPPORT_EVIDENCE || '/tmp/intafaced-support-review') + '/browser-results',
  use: { baseURL: process.env.SUPPORT_BASE || 'http://127.0.0.1:3231', headless: true },
  reporter: [['list'], ['json', { outputFile: process.env.SUPPORT_RESULTS }]],
});
