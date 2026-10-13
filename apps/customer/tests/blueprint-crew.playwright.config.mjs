import { defineConfig } from '@playwright/test';
process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';
export default defineConfig({
  testDir: '.',
  testMatch: 'blueprint-crew.pw.mjs',
  workers: 1,
  retries: 0,
  timeout: 35000,
  expect: { timeout: 6000 },
  reporter: [['list'], ['json', { outputFile: process.env.CREW_EVIDENCE + '/results.json' }]],
  outputDir: process.env.CREW_EVIDENCE + '/browser-results',
  use: { baseURL: process.env.CREW_BASE_URL, viewport: { width: 1440, height: 1100 }, trace: 'off', video: 'off', screenshot: 'off' },
});
