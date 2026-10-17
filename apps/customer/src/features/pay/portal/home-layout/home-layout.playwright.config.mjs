import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '..',
  testMatch: ['home-layout/home-layout.pw.mjs', 'portal.pw.mjs', 'w3c.pw.mjs', 'w3c2.pw.mjs'],
  workers: 1,
  reporter: 'list',
  outputDir: '/private/tmp/portal-option-a-work/browser-results',
  use: {
    baseURL: 'http://127.0.0.1:4653',
    headless: true,
    ...(process.env.PORTAL_CHROMIUM ? { launchOptions: { executablePath: process.env.PORTAL_CHROMIUM } } : {}),
  },
});
