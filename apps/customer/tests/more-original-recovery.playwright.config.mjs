import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.',
  testMatch: 'more-original-recovery.pw.mjs',
  workers: 1,
  retries: 0,
  timeout: 30000,
  expect: { timeout: 6000 },
  reporter: [['list'], ['json', { outputFile: process.env.MORE_ORIGINAL_EVIDENCE + '/results.json' }]],
  outputDir: process.env.MORE_ORIGINAL_EVIDENCE + '/browser-results',
  use: {
    baseURL: process.env.MORE_ORIGINAL_BASE_URL || 'http://127.0.0.1:3294',
    headless: true,
    timezoneId: 'UTC',
    viewport: { width: 1440, height: 1000 },
    trace: 'off',
    video: 'off',
    screenshot: 'off',
  },
});
