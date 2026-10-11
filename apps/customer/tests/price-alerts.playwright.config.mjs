import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.',
  testMatch: 'price-alerts.pw.mjs',
  workers: 1,
  fullyParallel: false,
  reporter: 'list',
  outputDir: '/tmp/intafaced-price-alerts-browser-results',
  use: { baseURL: 'http://127.0.0.1:3233', headless: true, timezoneId: 'UTC' },
  webServer: {
    command:
      'pnpm --filter @intafaced/customer exec vite preview --host 127.0.0.1 --port 3233 --strictPort --outDir "$REVIEW_CUSTOMER_ARTIFACT"',
    url: 'http://127.0.0.1:3233',
    cwd: new URL('../../..', import.meta.url).pathname,
    reuseExistingServer: false,
    timeout: 30000,
  },
});
