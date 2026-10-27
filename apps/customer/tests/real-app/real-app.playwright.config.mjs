import { defineConfig } from '@playwright/test';
import { localTestDeviceState } from '../../../../tooling/scripts/local-test-device.mjs';

// Journeys in the running app: `pnpm local:stack` must be up (Customer on 127.0.0.1:3210). Nothing is mocked; each
// spec drives the browser and, where the journey names another actor (an operator, TEST funding, another trader),
// uses the stack's own tools. Test titles start "J-<module>-NN #<step>" so `roadmap.mjs --progress --results` counts them.
export default defineConfig({
  testDir: '.',
  // The Real-app journeys workflow hands each shard its own files (tooling/scripts/journey-shards.mjs), by name.
  testMatch: process.env.JOURNEY_FILES ? process.env.JOURNEY_FILES.split(' ').filter(Boolean) : '*.pw.mjs',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 90_000,
  // The Real-app journeys workflow stops a shard's journeys here, before its job's own limit, so the shard still sends
  // its report and only the journeys it did not reach count as not run. Unset locally: no limit.
  globalTimeout: Number(process.env.JOURNEY_GLOBAL_TIMEOUT_MS ?? 0),
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
    // Full Chromium in its new headless mode, as a person's browser runs. The default headless shell always reports
    // notifications as blocked, even after a grant, so the push card (J-home-ia-05, J-home-ia-06) could never be proved.
    channel: 'chromium',
    viewport: { width: 1440, height: 900 },
    // Every context, including each `browser.newContext()`, starts as the same TEST browser, which sign-up trusts, so
    // the new-device check asks only where a journey clears this cookie on purpose (J-identity-02 #5).
    storageState: localTestDeviceState(),
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    launchOptions: process.env.JOURNEY_CHROMIUM ? { executablePath: process.env.JOURNEY_CHROMIUM } : {},
  },
});
