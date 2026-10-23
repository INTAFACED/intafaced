import { defineConfig } from '@playwright/test';

// Journeys in the running app: `pnpm local:stack` must be up (Customer on 127.0.0.1:3210). Nothing is mocked; each
// spec drives the browser and, where the journey names another actor (an operator, TEST funding, another trader),
// uses the stack's own tools. Test titles start "J-<module>-NN #<step>" so `roadmap.mjs --progress --results` counts them.
export default defineConfig({
  testDir: '.',
  testMatch: '*.pw.mjs',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  // A sharded run (the Real-app journeys workflow) also writes a blob per shard, which one job merges into the JSON report.
  reporter: [
    ['list'],
    ['json', { outputFile: process.env.JOURNEY_REPORT ?? '/tmp/intafaced-real-app/report.json' }],
    ...(process.env.JOURNEY_BLOB_DIR ? [['blob', { outputDir: process.env.JOURNEY_BLOB_DIR }]] : []),
  ],
  outputDir: '/tmp/intafaced-real-app/results',
  use: {
    baseURL: 'http://127.0.0.1:3210',
    headless: true,
    viewport: { width: 1440, height: 900 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    launchOptions: process.env.JOURNEY_CHROMIUM ? { executablePath: process.env.JOURNEY_CHROMIUM } : {},
  },
});
