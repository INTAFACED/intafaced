import { defineConfig } from '@playwright/test';
process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';
export default defineConfig({
  testDir: '.',
  testMatch: 'withdrawal.pw.mjs',
  workers: 1,
  retries: 0,
  timeout: 30000,
  expect: { timeout: 6000 },
  reporter: [['list'], ['json', { outputFile: process.env.WITHDRAWAL_EVIDENCE + '/results.json' }]],
  outputDir: process.env.WITHDRAWAL_EVIDENCE + '/browser-results',
  use: {
    baseURL: process.env.WITHDRAWAL_BASE_URL || 'http://127.0.0.1:3262',
    viewport: { width: 390, height: 1000 },
    trace: 'off',
    video: 'off',
    screenshot: 'off',
  },
});
