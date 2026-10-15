import { defineConfig } from 'vitest/config';

/**
 * ONE DATABASE, ONE FILE AT A TIME.
 *
 * svc-p2p has three suites that talk to Postgres — `p2p-service.test.ts`
 * (escrow), `instrument-service.test.ts` (payment instruments) and
 * `erasure.test.ts` (export/erase) — and they are not separable by table. An
 * instrument is attached to a trade, a trade belongs to an offer, the
 * disclosure rules are decided from the trade's status, and erase has to read
 * all three to decide what it is allowed to delete. So each of them creates
 * real offers and real trades, and each of them TRUNCATEs the same connected
 * set between tests.
 *
 * Vitest runs test FILES in parallel by default, so without this they delete
 * each other's rows mid-assertion. That does not fail cleanly: it surfaces as
 * "trade not found" immediately after a successful take, in tests that have
 * nothing to do with the change being made — 24 of them, in the run that
 * produced this file, spread across both suites and every one of them a false
 * red. The same hazard is documented in `svc-pay/src/payment-service.test.ts`,
 * which solved it by keeping one connected table set in one file.
 *
 * That option was available here and was rejected: it would mean a single
 * ~2,000-line suite in which the escrow invariants, the disclosure rules and
 * the erase manifest — three genuinely different subjects — are read together
 * because of a test-runner default. Serialising the files costs a few seconds
 * of wall clock and keeps each subject readable on its own.
 *
 * The hazard predates this file. It was already true of `p2p-service.test.ts`
 * and `instrument-service.test.ts` and had simply never been observed, because
 * vitest only spreads files across workers once there are enough of them to
 * bother. A money suite that passes because the scheduler happened to
 * serialise it is not a passing money suite.
 *
 * The right long-term fix is per-suite database isolation (`createTestDb` in
 * `@intafaced/db`, which stamps each run its own). That needs an admin URL
 * pointing at a `*_test` database, which the local `.env` does not currently
 * supply — so this is the honest interim: correct, one line of behaviour, and
 * it costs a few seconds of wall clock rather than a day of chasing a flake.
 *
 * The pure suites (state, pricing, reputation, field validation) touch no
 * database and are unaffected by anything here; they are milliseconds.
 */
export default defineConfig({
  test: {
    env: { APP_ENV: 'test' },
    include: ['src/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
  },
});
