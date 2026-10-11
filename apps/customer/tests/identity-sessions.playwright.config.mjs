import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.',
  testMatch: 'identity-sessions.pw.mjs',
  workers: 1,
  retries: 0,
  timeout: 45000,
  expect: { timeout: 6500 },
  reporter: [['list'], ['json', { outputFile: process.env.IDENTITY_SESSION_EVIDENCE + '/results.json' }]],
  outputDir: process.env.IDENTITY_SESSION_EVIDENCE + '/browser-results',
  use: {
    baseURL: process.env.IDENTITY_SESSION_BASE_URL || 'http://127.0.0.1:3234',
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
