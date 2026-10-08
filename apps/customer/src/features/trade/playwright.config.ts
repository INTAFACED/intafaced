import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.',
  testMatch: '*.pw.ts',
  use: { baseURL: 'http://127.0.0.1:3291', headless: true },
  workers: 1,
  webServer: {
    command: 'node browser-harness.mjs',
    url: 'http://127.0.0.1:3291',
    reuseExistingServer: false,
    timeout: 20000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 1000 },
  },
  reporter: 'list',
  outputDir: '/tmp/intafaced-trade-browser-results',
});
