import { defineConfig } from '@playwright/test';
process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';
export default defineConfig({
  testDir: '.',
  testMatch: 'public-auth.pw.mjs',
  workers: 1,
  retries: 0,
  timeout: 45000,
  expect: { timeout: 6500 },
  reporter: [['list'], ['json', { outputFile: process.env.PUBLIC_AUTH_EVIDENCE + '/results.json' }]],
  outputDir: process.env.PUBLIC_AUTH_EVIDENCE + '/browser-results',
  use: {
    baseURL: process.env.PUBLIC_AUTH_BASE_URL || 'http://localhost:3236',
    viewport: { width: 1440, height: 1000 },
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
});
