import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'availability.browser.pw.mjs',
  workers: 1,
  fullyParallel: false,
  reporter: 'list',
  outputDir: '/tmp/intafaced-account-availability-results',
  use: {
    baseURL: 'http://127.0.0.1:3237',
    headless: true,
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH },
  },
  webServer: {
    command: 'pnpm --filter @intafaced/customer exec vite --host 127.0.0.1 --port 3237 --strictPort',
    url: 'http://127.0.0.1:3237',
    cwd: new URL('../../../../..', import.meta.url).pathname,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
