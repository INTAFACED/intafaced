import { defineConfig } from '@playwright/test';
process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';
export default defineConfig({
  testDir: '.',
  testMatch: 'room-auth-return-fragment.pw.mjs',
  workers: 1,
  retries: 0,
  timeout: 25000,
  expect: { timeout: 2500 },
  reporter: [['list'], ['json', { outputFile: process.env.ROOM_RETURN_EVIDENCE + '/results.json' }]],
  outputDir: process.env.ROOM_RETURN_EVIDENCE + '/browser-results',
  use: {
    baseURL: process.env.ROOM_RETURN_BASE_URL,
    trace: 'off',
    video: 'off',
    screenshot: 'off',
    viewport: { width: 1440, height: 1100 },
  },
});
