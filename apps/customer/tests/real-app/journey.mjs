import { test as base, expect as baseExpect } from '@playwright/test';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { guardPostingFreeze, postingFromHealth } from '../../../../tooling/scripts/journey-freeze-guard.mjs';
import { FAIL_FAST, failFastSteps, failsFast } from '../../../../tooling/scripts/journey-fail-fast.mjs';
import { guardOwnerSwitches } from '../../../../tooling/scripts/local-test-owner-switch.mjs';
import { LEDGER, ROOT } from './stack.mjs';

// Every journey imports `test` (and `expect`) from here, never from '@playwright/test' directly
// (tooling/scripts/journey-freeze-guard.test.mjs fails a file that does), and so does every helper that asserts, so a
// step that fails fast waits the same everywhere. Everything else is Playwright's own.
export * from '@playwright/test';

/** svc-ledger's posting switch: true (open), false (frozen) or null when the ledger does not answer. */
async function readPosting() {
  try {
    const res = await fetch(`${LEDGER}/health`, { signal: AbortSignal.timeout(2_000) });
    return postingFromHealth(await res.json());
  } catch {
    return null;
  }
}

/** Lift a LOCAL TEST freeze through the founders' freeze door, signing them in afresh (refuses any other freeze). */
async function lift() {
  // Asynchronous, so the worker keeps answering Playwright while two founders sign in.
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [path.join(ROOT, 'tooling/scripts/local-test-gates.mjs'), 'posting-freeze', 'lift-leaked'],
    { cwd: ROOT, encoding: 'utf8', timeout: 120_000 },
  );
  return stdout.trim().split('\n').at(-1) ?? 'lifted';
}

// The planner's fail-fast plan, on a full CI run only (tooling/scripts/journey-fail-fast.mjs); empty elsewhere.
const FAST_PLAN = failFastSteps();

/** True inside a step that fails fast. Outside a test (a helper at import time) it is false. */
function inFastStep() {
  if (FAST_PLAN.steps.size === 0) return false;
  try {
    return failsFast(FAST_PLAN, test.info().title);
  } catch {
    return false;
  }
}

const fastExpect = baseExpect.configure({ timeout: FAIL_FAST.waitMs });

/**
 * Playwright's `expect`, except that inside a step that fails fast an assertion with no timeout of its own waits
 * FAIL_FAST.waitMs. `expect.poll`, `expect.soft` and the rest are Playwright's own.
 */
export const expect = new Proxy(baseExpect, {
  apply: (target, self, args) => Reflect.apply(inFastStep() ? fastExpect : target, self, args),
});

export const test = base.extend({
  // No journey leaves the platform posting freeze on for the journeys after it (journey-freeze-guard.mjs).
  postingFreezeGuard: [
    async ({}, use, testInfo) => {
      await guardPostingFreeze({ title: testInfo.titlePath.slice(1).join(' › '), readPosting, lift, body: () => use() });
    },
    // Its own time, apart from the test's: a test that timed out inside its freeze is exactly the one to lift.
    { auto: true, timeout: 150_000 },
  ],
  // No owner switch (withOwnerSwitch, local-test-owner-switch.mjs) outlives its test, even one that timed out mid-switch.
  ownerSwitchGuard: [
    async ({}, use, testInfo) => {
      await guardOwnerSwitches({ title: testInfo.titlePath.slice(1).join(' › '), body: () => use() });
    },
    // Its own time: clearing restarts the switched service.
    { auto: true, timeout: 200_000 },
  ],
  // A test that fails fast ends after FAIL_FAST.testMs, unless it has a limit other than the project's: one set before this
  // runs (describe.configure, test.use, test.slow) is kept, and one set inside the test (test.setTimeout) comes after it.
  failFastStep: [
    async ({}, use, testInfo) => {
      const ordinary = testInfo.timeout === testInfo.project.timeout && testInfo.timeout > 0;
      if (ordinary && failsFast(FAST_PLAN, testInfo.title)) testInfo.setTimeout(FAIL_FAST.testMs);
      await use();
    },
    { auto: true },
  ],
  // ...and every page it opens, through the `page` fixture or its own browser.newContext(), waits FAIL_FAST.waitMs for an
  // action and FAIL_FAST.testMs for a navigation, unless the call names its own timeout (Playwright applies these two
  // options to each context the test creates).
  actionTimeout: async ({ actionTimeout }, use, testInfo) => use(failsFast(FAST_PLAN, testInfo.title) ? FAIL_FAST.waitMs : actionTimeout),
  navigationTimeout: async ({ navigationTimeout }, use, testInfo) =>
    use(failsFast(FAST_PLAN, testInfo.title) ? FAIL_FAST.testMs : navigationTimeout),
});
