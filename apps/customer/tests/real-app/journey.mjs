import { test as base } from '@playwright/test';
import { guardPostingFreeze, postingFromHealth } from '../../../../tooling/scripts/journey-freeze-guard.mjs';
import { tool } from './stack.mjs';

// Every journey imports `test` (and `expect`) from here, never from '@playwright/test' directly
// (tooling/scripts/journey-freeze-guard.test.mjs fails a file that does). Everything else is Playwright's own.
export * from '@playwright/test';

const LEDGER = 'http://127.0.0.1:14501';

/** svc-ledger's posting switch: true (open), false (frozen) or null when the ledger does not answer. */
async function readPosting() {
  try {
    const res = await fetch(`${LEDGER}/health`, { signal: AbortSignal.timeout(5_000) });
    return postingFromHealth(await res.json());
  } catch {
    return null;
  }
}

/** Lift a LOCAL TEST freeze through the founders' freeze door, signing them in afresh (refuses any other freeze). */
async function lift() {
  const out = tool('local-test-gates.mjs', 'posting-freeze', 'lift-leaked');
  return out.trim().split('\n').at(-1) ?? 'lifted';
}

export const test = base.extend({
  // No journey leaves the platform posting freeze on for the journeys after it (journey-freeze-guard.mjs).
  postingFreezeGuard: [
    async ({}, use, testInfo) => {
      await guardPostingFreeze({ title: testInfo.titlePath.slice(1).join(' › '), readPosting, lift, body: () => use() });
    },
    // Its own time, apart from the test's: a test that timed out inside its freeze is exactly the one to lift.
    { auto: true, timeout: 150_000 },
  ],
});
