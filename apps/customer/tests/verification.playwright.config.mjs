import { defineConfig } from '@playwright/test';
process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';
export default defineConfig({
  testDir: '.',
  testMatch: 'verification.pw.mjs',
  workers: 1,
  retries: 0,
  timeout: 30000,
  expect: { timeout: 6000 },
  reporter: [['list'], ['json', { outputFile: process.env.VERIFICATION_EVIDENCE + '/results.json' }]],
  outputDir: process.env.VERIFICATION_EVIDENCE + '/browser-results',
  use: {
    baseURL: process.env.VERIFICATION_BASE_URL || 'http://127.0.0.1:3242',
    viewport: { width: 1440, height: 1000 },
    trace: 'off',
    video: 'off',
    screenshot: 'off',
  },
});
