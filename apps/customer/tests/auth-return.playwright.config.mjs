import { defineConfig } from '@playwright/test';
process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';
export default defineConfig({
  testDir: '.',
  testMatch: 'auth-return.pw.mjs',
  workers: 1,
  retries: 0,
  timeout: 30000,
  expect: { timeout: 6500 },
  reporter: [['list'], ['json', { outputFile: process.env.AUTH_RETURN_EVIDENCE + '/results.json' }]],
  outputDir: process.env.AUTH_RETURN_EVIDENCE + '/browser-results',
  use: {
    baseURL: process.env.AUTH_RETURN_BASE_URL || 'http://localhost:3250',
    viewport: { width: 1440, height: 1000 },
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
});
