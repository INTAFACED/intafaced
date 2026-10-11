import { defineConfig } from '@playwright/test';
const evidence = process.env.TEAM_LEDGER_EVIDENCE;
if (!evidence) throw new Error('TEAM_LEDGER_EVIDENCE must name an isolated local evidence directory');
export default defineConfig({
  testDir: '.',
  testMatch: 'ledger-journey.browser.pw.mjs',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  outputDir: `${evidence}/native-results`,
  reporter: [['list'], ['json', { outputFile: `${evidence}/native-report.json` }]],
  use: { baseURL: 'http://127.0.0.1:3154', browserName: 'chromium', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
