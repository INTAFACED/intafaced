// The one time budget every package's vitest run gets: 30 s a test, 30 s a hook.
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
export const TEST_BUDGET = Object.freeze({ testTimeout: 30_000, hookTimeout: 30_000 });
