import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.',
  testMatch: 'options.pw.mjs',
  workers: 1,
  reporter: 'list',
  outputDir: '/private/tmp/portal-layout-options-preview/browser-results',
  use: {
    baseURL: 'http://127.0.0.1:4653',
    headless: true,
    ...(process.env.PORTAL_CHROMIUM ? { launchOptions: { executablePath: process.env.PORTAL_CHROMIUM } } : {}),
  },
});
