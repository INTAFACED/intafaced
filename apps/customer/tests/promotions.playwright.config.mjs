import { defineConfig } from '@playwright/test';
process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';
export default defineConfig({
  testDir: '.',
  testMatch: 'promotions.pw.mjs',
  workers: 1,
  retries: 0,
  timeout: 30000,
  expect: { timeout: 6000 },
  reporter: [['list'], ['json', { outputFile: process.env.PROMOTIONS_EVIDENCE + '/results.json' }]],
  outputDir: process.env.PROMOTIONS_EVIDENCE + '/browser-results',
  use: {
    baseURL: process.env.PROMOTIONS_BASE_URL || 'http://127.0.0.1:3243',
    viewport: { width: 1440, height: 1000 },
    trace: 'off',
    video: 'off',
    screenshot: 'off',
  },
});
