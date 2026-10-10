import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'market-responsive-precision.pw.mjs',
  workers: 1,
  retries: 0,
  timeout: 60000,
  expect: { timeout: 7000 },
  reporter: [
    ['list'],
    ['json', { outputFile: `${process.env.MARKET_PRECISION_EVIDENCE || '/tmp/intafaced-market-responsive-precision'}/results.json` }],
  ],
  outputDir: `${process.env.MARKET_PRECISION_EVIDENCE || '/tmp/intafaced-market-responsive-precision'}/browser-results`,
  use: {
    baseURL: process.env.MARKET_PRECISION_BASE_URL || 'http://127.0.0.1:3299',
    headless: true,
    timezoneId: 'UTC',
    viewport: { width: 1440, height: 1000 },
    trace: 'off',
    video: 'off',
    screenshot: 'off',
  },
});
