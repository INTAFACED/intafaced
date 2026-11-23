// The one budget every package's vitest run gets: 30 s a test, 30 s a hook, and on a shared machine at most
// INTAFACED_LOCAL_JOBS workers (tooling/scripts/local-jobs.mjs; unset, vitest's own default).
//
// vitest's defaults (5 s a test, 10 s a hook) are shorter than a schema reset or a seed on a loaded CI runner. Each
// package used to copy its own budget into its own config, and the ones that never did went red for it: svc-pay's
// Postgres setup hit the 10 s hook limit (#7659, #8605), svc-agents' runtime and edge tests the 5 s test limit (#8213,
// #8218), venue-sim's simulator tests (#8217) and svc-p2p's escrow suite (#7158, #8309) the same, each failing on one
// run and passing on its re-run. A timed-out hook keeps running under the next test, so one stall can cost two reds
// (svc-p2p, #8309). No assertion changes with this budget: it is only how long vitest waits.
//
// Every vitest config spreads it (`test: { ...TEST_BUDGET, ... }`); tooling/vitest/budget.test.mjs fails a package whose
// tests run on vitest without it. A package that needs longer says so after the spread, as tooling/pay-sim does.
import { localWorkers } from '../scripts/local-jobs.mjs';

/**
 * Node's own Web Storage off in the test workers on Node 25 and later, where it is on by default: with no
 * --localstorage-file its global `localStorage` is undefined, it stands in place of the DOM environment's (happy-dom,
 * jsdom), and every test that reads storage fails. On Node 26 the Customer render records failed 203 of 204 at
 * `localStorage.clear()` and the pre-push hook refused every push until the builder set
 * NODE_OPTIONS=--no-experimental-webstorage by hand (PR #9819, 23 Nov; #10218 the first time). CI runs Node 22
 * (.node-version), where it is off already: there this is nothing, and CI's runs are unchanged.
 */
export function nodeStorageOff(version = process.versions.node) {
  return Number(version.split('.')[0]) >= 25 ? { execArgv: ['--no-experimental-webstorage'] } : {};
}

export const TEST_BUDGET = Object.freeze({ testTimeout: 30_000, hookTimeout: 30_000, ...localWorkers(), ...nodeStorageOff() });
