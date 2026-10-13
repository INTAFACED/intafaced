import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.',
  testMatch: 'market-catalogue.pw.mjs',
  workers: 1,
  timeout: 30000,
  outputDir: (process.env.MARKET_CATALOGUE_EVIDENCE || '/tmp/intafaced-market-catalogue') + '/browser-results',
  use: { baseURL: process.env.MARKET_CATALOGUE_BASE || 'http://127.0.0.1:3230', headless: true },
  reporter: [['list'], ['json', { outputFile: process.env.MARKET_CATALOGUE_RESULTS }]],
});
