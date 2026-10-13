import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.',
  testMatch: 'keyboard-focus.pw.mjs',
  workers: 1,
  retries: 0,
  timeout: 45000,
  expect: { timeout: 7000 },
  reporter: 'list',
  outputDir: process.env.KEYBOARD_FOCUS_EVIDENCE
    ? process.env.KEYBOARD_FOCUS_EVIDENCE + '/browser-results'
    : '/tmp/intafaced-keyboard-focus-results',
  use: {
    baseURL: process.env.KEYBOARD_FOCUS_URL || 'http://127.0.0.1:3232',
    headless: true,
    timezoneId: 'UTC',
    trace: 'retain-on-failure',
  },
});
