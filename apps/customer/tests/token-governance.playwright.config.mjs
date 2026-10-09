import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.', testMatch: 'token-governance.pw.mjs', workers: 1, retries: 0,
  timeout: 60000, expect: { timeout: 7000 }, reporter: 'list',
  outputDir: (process.env.TOKEN_GOVERNANCE_EVIDENCE || '/tmp/intafaced-token-governance') + '/test-output',
  use: { baseURL: process.env.TOKEN_GOVERNANCE_BASE || 'http://127.0.0.1:3237', headless: true, timezoneId: 'UTC' },
});
