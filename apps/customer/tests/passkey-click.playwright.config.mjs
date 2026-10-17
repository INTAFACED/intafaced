import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'passkey-click.pw.mjs',
  workers: 1,
  retries: 0,
  timeout: 15000,
  outputDir: process.env.PASSKEY_CLICK_EVIDENCE || '/tmp/intafaced-passkey-click-results',
  use: {
    baseURL: process.env.PASSKEY_CLICK_BASE_URL || 'http://localhost:3210',
    launchOptions: {
      executablePath: process.env.PASSKEY_CLICK_BROWSER || '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    },
  },
});
