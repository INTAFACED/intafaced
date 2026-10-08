import { defineConfig } from '@playwright/test';
process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';
export default defineConfig({
  testDir: '.', testMatch: 'review.pw.mjs', workers: 1, reporter: 'list',
  outputDir: '/tmp/intafaced-security-review-results',
  use: { baseURL: 'http://127.0.0.1:3218', headless: true },
  webServer: {
    command: 'pnpm --filter @intafaced/customer exec vite --host 127.0.0.1 --port 3218',
    url: 'http://127.0.0.1:3218', cwd: new URL('../../../../..', import.meta.url).pathname,
    reuseExistingServer: false, timeout: 30000,
  },
});
