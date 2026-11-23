/**
 * MONEY-PATH SKIP INVENTORY — D26-P2-13 register.
 *
 * Every money-path test file that can decline to run must appear here with a
 * kind and a reason, or the skip must be deleted. The companion gate
 * (`money-skip-honesty-scan.mjs`) fails on growth and warns on paid debt:
 *
 *   · a new skip under a money root that is not listed → red (register or delete)
 *   · a listed file that no longer skips / no longer exists → warning (delete the row; a fix never fails)
 *
 * This is not a licence to skip. It is the permanent ledger of which money
 * suites are allowed to be absent from a local run, so a silent grow cannot
 * look like coverage.
 *
 * Kind meanings:
 *   · infra-journalled — skip is gated by a shared CI-aware probe that journals
 *     (`postgresAvailable` / `recordInfraProbe` / `devChainReachable`)
 *   · private-probe    — still decides on a hand-rolled connection; also owed
 *     to `unreported-suites.mjs` PRIVATE_PROBE until fixed
 *   · pending          — hard `it.skip` / `test.skip` for unfinished work
 *   · opaque           — skips by some other shape; must name what lifts it
 *
 * 2026-08-15 hunt (D26-P2-13): money roots had 0 hard `it.skip` / `xit` /
 * `test.todo` / `this.skip`. Every current skip is journalled (`postgresAvailable`
 * / `recordInfraProbe`). The pay EVM live rail still skips without a node — it
 * journals; it is not gone. Do not invent pending rows to look busy.
 */

/**
 * Money roots from D26-P2-01 promise-falsify surface (plus ledger-client). The ledger, the bank and the matching engine
 * are the Rust crates `crates/svc-ledger`, `crates/svc-bank` and `crates/svc-matching`, which this scan of TypeScript tests cannot read (the
 * engine's tests need no database, so they never skip): CI's Rust job runs its database tests with
 * REQUIRE_POSTGRES=1, so a missing database fails them rather than skipping.
 */
export const MONEY_PATH_ROOTS = [
  'services/svc-trade',
  'services/svc-pay',
  'services/svc-p2p',
  'services/svc-token',
  'services/svc-market',
  'services/svc-ws',
  'packages/ledger-client',
];

/**
 * @type {{file: string, kind: 'infra-journalled' | 'private-probe' | 'pending' | 'opaque', why: string}[]}
 */
export const MONEY_SKIP_REGISTER = [
  // ── svc-market ───────────────────────

  // ── svc-pay ────────────────────────
  {
    file: 'services/svc-pay/src/rails/evm-chain.live.test.ts',
    kind: 'infra-journalled',
    why:
      'on-chain payment rail journals via recordInfraProbe; skips locally without anvil. ' +
      'REQUIRE_PAY_EVM=1 hard-fails. CI pay-bank shard has no anvil and does not set that gate. ' +
      'LIFTS WHEN: CI runs a chain for pay (or sets REQUIRE_PAY_EVM on a job that has one). Until then the skip stays listed.',
  },

  // ── svc-token ────────────────────

  // ── svc-trade ────────────────────
];
