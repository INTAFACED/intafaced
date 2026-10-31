/**
 * No journey leaves the platform posting freeze on (lead, 2026-10-31: on run 1037 J-identity-08 #7 timed out inside its
 * freeze, its `finally` never lifted it, and J-ops-console-22 and J-pay-03 went red for the rest of the shard).
 *
 * Every journey's `test` comes from apps/customer/tests/real-app/journey.mjs, whose automatic fixture calls
 * `guardPostingFreeze` around each test: it reads svc-ledger's posting switch before and after, and a test that turned
 * posting off and left it off fails by name, after the freeze is lifted through the founders' own door with fresh
 * sessions (`local-test-gates.mjs posting-freeze lift-leaked`). A freeze that was already on before the test is not
 * that test's: it is reported, never blamed or lifted here.
 */

/**
 * The verdict for one test from the ledger's posting switch before and after it (`true` = posting enabled):
 *   - `clean` when posting is on afterwards, or could not be read afterwards;
 *   - `inherited` when posting was already off before the test (an earlier leak, or a stack frozen on purpose);
 *   - `leaked` when posting is off afterwards and was not seen off before, including when the ledger did not answer
 *     before (restarting, still booting): a freeze nobody can place is still lifted, so the next journey starts open.
 */
export function freezeVerdict(before, after) {
  if (after !== false) return 'clean';
  if (before === false) return 'inherited';
  return 'leaked';
}

/** How long the guard lets a timed-out test's own `finally` lift its freeze before the guard lifts it. */
export const GRACE_MS = 10_000;

/**
 * Run `body` (the test; Playwright's fixture `use()`, which resolves whether the test passed, failed or timed out)
 * between two reads of the posting switch. On a leak: wait up to `graceMs` for the test's own cleanup (Playwright does
 * not cancel a timed-out test's body, so its `finally` may still be lifting), then lift it, then throw an error naming
 * the test, whether or not the lift worked, so the shard's next journeys start open and the leak is red where it
 * happened. `readPosting` resolves to true (posting on), false (frozen) or null (unreadable); `lift` resolves to a
 * one-line account of what it did, or throws.
 */
export async function guardPostingFreeze({
  title,
  readPosting,
  lift,
  body,
  graceMs = GRACE_MS,
  stepMs = 1_000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const before = await readPosting();
  await body();
  let after = await readPosting();
  if (freezeVerdict(before, after) !== 'leaked') return;
  for (let waited = 0; after === false && waited < graceMs; waited += stepMs) {
    await sleep(stepMs);
    after = await readPosting();
  }
  // The test's own cleanup lifted it within the grace: not a leak.
  if (after !== false) return;
  let lifted;
  try {
    lifted = `the guard lifted it: ${await lift()}`;
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    lifted =
      (await readPosting()) === true
        ? `posting is open again, though the guard's own lift was refused (${why})`
        : `the guard could NOT lift it (${why}); every journey after this one runs frozen`;
  }
  const unseen = before === null ? ' (the ledger did not answer before it, so it may have been frozen already)' : '';
  throw new Error(`FREEZE LEAK: "${title}" left the platform posting freeze on${unseen}; ${lifted}`);
}

/** svc-ledger's posting switch from its `/health` body (`postingEnabled`), or null when it does not say. */
export function postingFromHealth(json) {
  return typeof json?.postingEnabled === 'boolean' ? json.postingEnabled : null;
}

/** Freezes a journey makes are labelled LOCAL TEST (local-test-gates.mjs, J-identity-08 #7); only those are lifted. */
export const JOURNEY_FREEZE_LABEL = /^LOCAL TEST\b/;

/**
 * What `posting-freeze lift-leaked` does with the freeze record it read: `skip` when posting is open, `run` for a
 * LOCAL TEST freeze, and `refuse` for any other reason (a reconciliation self-freeze on the stack is a finding to read,
 * not a leak to clear) or a record without the version an approval is bound to.
 */
export function leakedFreezePlan(state) {
  if (!state || typeof state.frozen !== 'boolean') return { action: 'refuse', why: 'the ledger did not report its freeze state' };
  if (!state.frozen) return { action: 'skip' };
  if (!JOURNEY_FREEZE_LABEL.test(String(state.reason ?? '')))
    return {
      action: 'refuse',
      why: `the ledger is frozen for a reason no journey gives (${JSON.stringify(state.reason)}, by ${state.actor ?? 'unknown'}): read it, do not clear it`,
    };
  if (typeof state.version !== 'string' || state.version.length === 0)
    return { action: 'refuse', why: 'the ledger did not report the freeze version an approval is bound to' };
  return { action: 'run' };
}
