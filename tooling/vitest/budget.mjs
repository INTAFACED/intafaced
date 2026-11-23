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
import { fileURLToPath } from 'node:url';
import { localWorkers } from '../scripts/local-jobs.mjs';
import { RESULTS_ENV } from '../ci/test-results-reporter.mjs';

const RESULTS_REPORTER = fileURLToPath(new URL('../ci/test-results-reporter.mjs', import.meta.url));

/**
 * When CI's Tests job asks for them (INTAFACED_TEST_RESULTS, a folder), vitest's own reporters plus the one that writes
 * what the run failed as data (tooling/ci/test-results-reporter.mjs; the Tests job's verdict, tooling/ci/base-failures.mjs,
 * reads it). Naming any reporter replaces vitest's defaults, so they are named too, as vitest picks them: `default`, and
 * `github-actions` on GitHub's runners. Unset, nothing: vitest picks its own.
 */
export function testResults(env = process.env) {
  if (!env[RESULTS_ENV]) return {};
  return { reporters: ['default', ...(env.GITHUB_ACTIONS === 'true' ? ['github-actions'] : []), RESULTS_REPORTER] };
}

export const TEST_BUDGET = Object.freeze({ testTimeout: 30_000, hookTimeout: 30_000, ...localWorkers(), ...testResults() });
