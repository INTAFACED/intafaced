import { defineConfig } from '@playwright/test';
process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';
export default defineConfig({
  testDir: '.',
  testMatch: 'more.pw.ts',
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:3292' },
  webServer: {
    command: 'node browser-harness.mjs',
    url: 'http://127.0.0.1:3292',
    reuseExistingServer: false,
    timeout: 20000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 1000 },
  },
  outputDir: '/tmp/intafaced-more-browser-results',
});
