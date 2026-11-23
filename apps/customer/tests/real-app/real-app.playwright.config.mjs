import { defineConfig } from '@playwright/test';
import { JOURNEY_TMP, anotherCheckoutsStack, localTestDeviceState, stackUrl } from '../../../../tooling/scripts/local-test-facts.mjs';

// Never run on another checkout's stack (local-test-facts.mjs anotherCheckoutsStack).
const borrowed = anotherCheckoutsStack();
if (borrowed) throw new Error(borrowed);

// Journeys in the running app: `pnpm local:stack` must be up, on the same LOCAL_STACK_SLOT (Customer on 127.0.0.1:3210 in slot 0). Nothing is mocked; each
// spec drives the browser and, where the journey names another actor (an operator, TEST funding, another trader),
// uses the stack's own tools. Test titles start "J-<module>-NN #<step>" so `roadmap.mjs --progress --results` counts them.
export default defineConfig({
  testDir: '.',
  // The Real-app journeys workflow hands each shard its own files (tooling/scripts/journey-shards.mjs), by name.
  testMatch: process.env.JOURNEY_FILES ? process.env.JOURNEY_FILES.split(' ').filter(Boolean) : '*.pw.mjs',
  workers: 1,
  fullyParallel: false,
  // A run on main retries a failed test once (JOURNEY_RETRIES=1, set by the Real-app journeys workflow), so a test that
  // fails and then passes on the same commit ends "flaky" and the machine sets its step aside; a money step never
  // (tooling/ci/journey-verdict.mjs, owner decision 2026-11-07). Everywhere else, no retry: a builder's run shows a red.
  // A test of a step the fail-fast plan expects to fail runs once even on main (fail-fast-once.mjs, below).
  retries: process.env.JOURNEY_RETRIES === '1' ? 1 : 0,
  // A focused test (`.only` in any form) runs alone and drops every other journey test in the run; CI refuses it outright
  // (R3 C6, review 7550-R3), since the test judge reads only the steps a change touches.
  forbidOnly: Boolean(process.env.CI),
  timeout: 90_000,
  // The Real-app journeys workflow stops a shard's journeys here, before its job's own limit, so the shard still sends
  // its report and only the journeys it did not reach count as not run. Unset locally: no limit.
  globalTimeout: Number(process.env.JOURNEY_GLOBAL_TIMEOUT_MS ?? 0),
  expect: { timeout: 15_000 },
  // A sharded run (the Real-app journeys workflow) also writes a blob per shard, which one job merges into the JSON report.
  reporter: [
    // First, so it takes the retry off each test that fails fast before the run starts and before any other reporter
    // records the plan (tooling/scripts/journey-fail-fast.mjs, noRetryForFailFast).
    ['./fail-fast-once.mjs'],
    ['list'],
    ['json', { outputFile: process.env.JOURNEY_REPORT ?? `${JOURNEY_TMP}/report.json` }],
    ...(process.env.JOURNEY_BLOB_DIR ? [['blob', { outputDir: process.env.JOURNEY_BLOB_DIR }]] : []),
  ],
  outputDir: `${JOURNEY_TMP}/results`,
  use: {
    baseURL: stackUrl('customer'),
    headless: true,
    // Full Chromium in its new headless mode, as a person's browser runs. The default headless shell always reports
    // notifications as blocked, even after a grant, so the push card (J-home-ia-05, J-home-ia-06) could never be proved.
    channel: 'chromium',
    viewport: { width: 1440, height: 900 },
    // Every context, including each `browser.newContext()`, starts as the same TEST browser, which sign-up trusts, so
    // the new-device check asks only where a journey clears this cookie on purpose (J-identity-02 #5).
    storageState: localTestDeviceState(),
    // Every test that opens a page leaves a picture of what the app showed as it ended, passed or failed (project-state
    // d88: "proof kept for every pass"): `<outputDir>/<file>-<title, from "J-<module>-NN-<step>">/test-finished-1.png`,
    // one per page. A test with no page (an API-only step) leaves none. Pixels only: a password field draws dots and no
    // screen shows a session token, while a trace would carry both, so CI keeps passing `--trace off`. These are the window
    // of every page open in the worker; the step's own picture, the whole of the test's own page, is journey.mjs `stepPicture`.
    screenshot: 'on',
    trace: 'retain-on-failure',
    launchOptions: process.env.JOURNEY_CHROMIUM ? { executablePath: process.env.JOURNEY_CHROMIUM } : {},
  },
});
