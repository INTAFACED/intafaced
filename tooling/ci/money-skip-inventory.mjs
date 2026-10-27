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

/** Money roots from D26-P2-01 promise-falsify surface (plus ledger-client). */
export const MONEY_PATH_ROOTS = [
  'services/svc-ledger',
  'services/svc-trade',
  'services/svc-pay',
  'services/svc-bank',
  'services/svc-p2p',
  'services/svc-matching',
  'services/svc-token',
  'services/svc-market',
  'services/svc-ws',
  'packages/ledger-client',
];

/**
 * @type {{file: string, kind: 'infra-journalled' | 'private-probe' | 'pending' | 'opaque', why: string}[]}
 */
export const MONEY_SKIP_REGISTER = [
  // ── svc-bank ───────────────────────────
  {
    file: 'services/svc-bank/src/earn/position-default-pending.test.ts',
    kind: 'infra-journalled',
    why:
      'Earn positions must default to pending, not active, so a claim cannot accrue before its ledger post; this also proves the 0019 up and down migrations (rolled back in a transaction). Gated by postgresAvailable, which journals and THROWS under CI / REQUIRE_POSTGRES=1; ' +
      'svc-bank runs in Tests (full), which sets both with a live Postgres, so this runs on every PR that changes it and skips only on a laptop without the DB. ' +
      'LIFTS WHEN: converted to the PG-hard pattern (TEST_DATABASE_URL, no skipIf on postgresAvailable), as the svc-ledger H8a suites are.',
  },
  {
    file: 'services/svc-bank/src/transfers/rejected-omits-ledger-tx.db.test.ts',
    kind: 'infra-journalled',
    why:
      'A rejected transfer execution must carry a rejection code and must not point at a ledger posting (check constraint transfer_executions_rejected_omits_ledger_tx_ck), proven with raw SQL. Gated by postgresAvailable, which journals and THROWS under CI / REQUIRE_POSTGRES=1; ' +
      'svc-bank runs in Tests (full), which sets both with a live Postgres, so this runs on every PR that changes it and skips only on a laptop without the DB. ' +
      'LIFTS WHEN: converted to the PG-hard pattern (TEST_DATABASE_URL, no skipIf on postgresAvailable), as the svc-ledger H8a suites are.',
  },

  // ── svc-ledger ───────────────────────
  {
    file: 'services/svc-ledger/src/db/durable-freeze-down.test.ts',
    kind: 'infra-journalled',
    why:
      '0002 down migration must lock posting_freeze so a concurrent freeze cannot be dropped (#4532). Gated by postgresAvailable, which journals and THROWS under CI / REQUIRE_POSTGRES=1; ' +
      'Tests (full) sets both with a live Postgres, so this runs on every PR that changes it and skips only on a laptop without the DB. ' +
      'LIFTS WHEN: converted to the svc-ledger H8a PG-hard pattern (TEST_DATABASE_URL or Testcontainers, no postgresAvailable), as service.freeze.test.ts already is.',
  },
  {
    file: 'services/svc-ledger/src/db/outbox-down.test.ts',
    kind: 'infra-journalled',
    why:
      '0013 down migration must lock ledger_tx_outbox so an unpublished posting intent cannot be dropped (#4532). Gated by postgresAvailable, which journals and THROWS under CI / REQUIRE_POSTGRES=1; ' +
      'Tests (full) sets both with a live Postgres, so this runs on every PR that changes it and skips only on a laptop without the DB. ' +
      'LIFTS WHEN: converted to the svc-ledger H8a PG-hard pattern (TEST_DATABASE_URL or Testcontainers, no postgresAvailable), as service.freeze.test.ts already is.',
  },
  {
    file: 'services/svc-ledger/src/db/purpose-keyed-holds-down.test.ts',
    kind: 'infra-journalled',
    why:
      '0001 down migration must refuse (P0001) while zero-balance duplicate holds remain (#4532). Gated by postgresAvailable, which journals and THROWS under CI / REQUIRE_POSTGRES=1; ' +
      'Tests (full) sets both with a live Postgres, so this runs on every PR that changes it and skips only on a laptop without the DB. ' +
      'LIFTS WHEN: converted to the svc-ledger H8a PG-hard pattern (TEST_DATABASE_URL or Testcontainers, no postgresAvailable), as service.freeze.test.ts already is.',
  },

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
