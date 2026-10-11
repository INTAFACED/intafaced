import { defineConfig } from '@playwright/test';
const evidence = process.env.ZONED_DAILY_EVIDENCE || '/tmp/intafaced-zoned-daily-native';
export default defineConfig({
  testDir: '.',
  testMatch: 'zoned-daily.pw.mjs',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: evidence + '/results.json' }]],
  outputDir: evidence + '/results',
  use: {
    baseURL: process.env.ZONED_DAILY_BASE_URL || 'http://127.0.0.1:3248',
    headless: true,
    timezoneId: 'UTC',
    screenshot: 'off',
    trace: 'off',
    video: 'off',
  },
});
