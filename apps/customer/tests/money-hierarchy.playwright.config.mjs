import { defineConfig } from '@playwright/test';

const evidence = process.env.MONEY_HIERARCHY_EVIDENCE || '/tmp/intafaced-money-hierarchy';
export default defineConfig({
  testDir: '.',
  testMatch: 'money-hierarchy.pw.mjs',
  workers: 1,
  retries: 0,
  timeout: 60000,
  expect: { timeout: 7000 },
  reporter: [['list'], ['json', { outputFile: `${evidence}/results.json` }]],
  outputDir: `${evidence}/browser-results`,
  use: {
    baseURL: process.env.MONEY_HIERARCHY_BASE_URL || 'http://127.0.0.1:3317',
    headless: true,
    timezoneId: 'UTC',
    viewport: { width: 1440, height: 1000 },
    trace: 'off',
    video: 'off',
    screenshot: 'off',
  },
});
