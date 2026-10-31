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
 *   - `clean` when posting is on afterwards, or the switch could not be read before (nothing to compare);
 *   - `inherited` when posting was already off before the test (an earlier leak, or a stack frozen on purpose);
 *   - `leaked` when this test turned posting off and left it off.
 */
export function freezeVerdict(before, after) {
  if (after !== false) return 'clean';
  if (before === false) return 'inherited';
  if (before === true) return 'leaked';
  return 'clean';
}

/**
 * Run `body` (the test) between two reads of the posting switch. On a leak: lift it, then throw an error naming the
 * test, whether or not the lift worked, so the shard's next journeys start open and the leak is red where it happened.
 * `readPosting` resolves to true (posting on), false (frozen) or null (unreadable); `lift` resolves to a one-line
 * account of what it did, or throws.
 */
export async function guardPostingFreeze({ title, readPosting, lift, body }) {
  const before = await readPosting();
  try {
    await body();
  } finally {
    const verdict = freezeVerdict(before, await readPosting());
    if (verdict === 'leaked') {
      let lifted;
      try {
        lifted = `the guard lifted it: ${await lift()}`;
      } catch (err) {
        lifted = `the guard could NOT lift it (${err instanceof Error ? err.message : String(err)}); every journey after this one runs frozen`;
      }
      // Thrown from `finally`, this replaces the test's own error: the leak is the finding that poisons the shard,
      // and the test's own failure is still in its trace and steps.
      throw new Error(`FREEZE LEAK: "${title}" left the platform posting freeze on; ${lifted}`);
    }
  }
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
