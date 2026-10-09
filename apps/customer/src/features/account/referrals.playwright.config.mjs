import { defineConfig } from '@playwright/test';
process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';
export default defineConfig({
  testDir: '.',
  testMatch: 'referrals.pw.mjs',
  workers: 1,
  reporter: 'list',
  outputDir: process.env.REFERRALS_ARTIFACT ? process.env.REFERRALS_ARTIFACT + '/browser-results' : '/tmp/intafaced-referrals-results',
  use: { baseURL: 'http://127.0.0.1:3224', headless: true },
  webServer: {
    command: 'pnpm --filter @intafaced/customer exec vite --host 127.0.0.1 --port 3224 --strictPort',
    url: 'http://127.0.0.1:3224',
    cwd: new URL('../../../../..', import.meta.url).pathname,
    reuseExistingServer: true,
    timeout: 30000,
  },
});
