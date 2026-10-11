import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.',
  testMatch: 'agents-session.pw.mjs',
  workers: 1,
  retries: 0,
  timeout: 45000,
  expect: { timeout: 6500 },
  reporter: [['list'], ['json', { outputFile: process.env.AGENTS_EVIDENCE + '/results.json' }]],
  outputDir: process.env.AGENTS_EVIDENCE + '/browser-results',
  use: { baseURL: 'http://127.0.0.1:3233', headless: true, timezoneId: 'UTC', viewport: { width: 1440, height: 1000 } },
});
