import { defineConfig } from '@playwright/test';
if (!process.env.LOCALE_BASE_URL || !process.env.LOCALE_EVIDENCE) throw new Error('Explicit locale origin and evidence directory required');
export default defineConfig({
  testDir: '.',
  testMatch: 'locale-preferences.pw.mjs',
  workers: 1,
  retries: 0,
  timeout: 30000,
  expect: { timeout: 6000 },
  reporter: [['list'], ['json', { outputFile: process.env.LOCALE_EVIDENCE + '/results.json' }]],
  outputDir: process.env.LOCALE_EVIDENCE + '/browser-results',
  use: {
    baseURL: process.env.LOCALE_BASE_URL,
    headless: true,
    timezoneId: 'UTC',
    viewport: { width: 1440, height: 1000 },
    trace: 'off',
    video: 'off',
    screenshot: 'off',
  },
});
