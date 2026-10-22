/**
 * MONEY-PATH SKIP INVENTORY — D26-P2-13 register.
 *
 * Every money-path test file that can decline to run must appear here with a
 * kind and a reason, or the skip must be deleted. The companion gate
 * (`money-skip-honesty-scan.mjs`) fails in both directions:
 *
 *   · a new skip under a money root that is not listed → red (register or delete)
 *   · a listed file that no longer skips / no longer exists → red (delete the row)
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
 * `test.todo` / `this.skip`. Every current skip is journalled Postgres or the
 * one private-probe rail. Do not invent pending rows to look busy.
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

const PG = 'skips when Postgres unreachable; uses shared journalled postgresAvailable (local OK, CI hard-fails)';

/**
 * @type {{file: string, kind: 'infra-journalled' | 'private-probe' | 'pending' | 'opaque', why: string}[]}
 */
export const MONEY_SKIP_REGISTER = [
  // ── svc-bank ───────────────────────────────────────────
  { file: 'services/svc-bank/src/auto-invest/auto-invest.test.ts', kind: 'infra-journalled', why: PG },
  { file: 'services/svc-bank/src/auto-invest/auto-invest.reachable.test.ts', kind: 'infra-journalled', why: PG },
  { file: 'services/svc-bank/src/bank-service.test.ts', kind: 'infra-journalled', why: PG },
  { file: 'services/svc-bank/src/business/business.test.ts', kind: 'infra-journalled', why: PG },
  { file: 'services/svc-bank/src/cards/cards.reachable.test.ts', kind: 'infra-journalled', why: PG },
  { file: 'services/svc-bank/src/cards/cards-auth-product.test.ts', kind: 'infra-journalled', why: PG },
  { file: 'services/svc-bank/src/cards/cards.test.ts', kind: 'infra-journalled', why: PG },
  { file: 'services/svc-bank/src/cards/sovereign-card-product.test.ts', kind: 'infra-journalled', why: PG },
  { file: 'services/svc-bank/src/earn/earn-product.test.ts', kind: 'infra-journalled', why: PG },
  { file: 'services/svc-bank/src/loans/loans.test.ts', kind: 'infra-journalled', why: PG },
  { file: 'services/svc-bank/src/promise-falsify-public-doors.test.ts', kind: 'infra-journalled', why: PG },
  { file: 'services/svc-bank/src/ramps/ramps.reachable.test.ts', kind: 'infra-journalled', why: PG },
  { file: 'services/svc-bank/src/ramps/ramps-fiat-product.test.ts', kind: 'infra-journalled', why: PG },
  { file: 'services/svc-bank/src/ramps/ramps.test.ts', kind: 'infra-journalled', why: PG },

  // ── svc-ledger ───────────────────────────────────────
  { file: 'services/svc-ledger/src/db/guards-executed.test.ts', kind: 'infra-journalled', why: PG },
  { file: 'services/svc-ledger/src/db/idempotency-key-backstop.test.ts', kind: 'infra-journalled', why: PG },
  { file: 'services/svc-ledger/src/db/schema-drift.test.ts', kind: 'infra-journalled', why: PG },
  { file: 'services/svc-ledger/src/ledger/asset-registry.test.ts', kind: 'infra-journalled', why: PG },
  { file: 'services/svc-ledger/src/ledger/history-postgres.test.ts', kind: 'infra-journalled', why: PG },
  { file: 'services/svc-ledger/src/ledger/owner-identity.test.ts', kind: 'infra-journalled', why: PG },
  { file: 'services/svc-ledger/src/ledger/postgres-ledger.test.ts', kind: 'infra-journalled', why: PG },
  { file: 'services/svc-ledger/src/ledger/purposed-locks.test.ts', kind: 'infra-journalled', why: PG },
  { file: 'services/svc-ledger/src/service.freeze.test.ts', kind: 'infra-journalled', why: PG },

  // ── svc-market ───────────────────────────────────────
  { file: 'services/svc-market/src/commerce/commerce.test.ts', kind: 'infra-journalled', why: PG },
  { file: 'services/svc-market/src/commerce/commerce-subscriptions.test.ts', kind: 'infra-journalled', why: PG },
  { file: 'services/svc-market/src/listing-eligibility.test.ts', kind: 'infra-journalled', why: PG },
  { file: 'services/svc-market/src/vendor-slots.test.ts', kind: 'infra-journalled', why: PG },

  // ── svc-p2p ────────────────────────────────────────
  { file: 'services/svc-p2p/src/dispute-ruling-invariant.test.ts', kind: 'infra-journalled', why: PG },
  { file: 'services/svc-p2p/src/erase-take-race.test.ts', kind: 'infra-journalled', why: PG },
  { file: 'services/svc-p2p/src/erasure.test.ts', kind: 'infra-journalled', why: PG },
  { file: 'services/svc-p2p/src/instrument-service.test.ts', kind: 'infra-journalled', why: PG },
  { file: 'services/svc-p2p/src/merchant-service.test.ts', kind: 'infra-journalled', why: PG },
  { file: 'services/svc-p2p/src/p2p-service.test.ts', kind: 'infra-journalled', why: PG },
  { file: 'services/svc-p2p/src/promise-falsify-public-doors.test.ts', kind: 'infra-journalled', why: PG },
  { file: 'services/svc-p2p/src/take-refusal-deadlock.test.ts', kind: 'infra-journalled', why: PG },

  // ── svc-pay ────────────────────────────────────────
  { file: 'services/svc-pay/src/kyb-service.test.ts', kind: 'infra-journalled', why: PG },
  { file: 'services/svc-pay/src/merchant-state-service.test.ts', kind: 'infra-journalled', why: PG },
  { file: 'services/svc-pay/src/payment-service.test.ts', kind: 'infra-journalled', why: PG },
  { file: 'services/svc-pay/src/psp-mode.test.ts', kind: 'infra-journalled', why: PG },
  { file: 'services/svc-pay/src/public-rest.money.test.ts', kind: 'infra-journalled', why: PG },
  {
    file: 'services/svc-pay/src/rails/evm-chain.live.test.ts',
    kind: 'private-probe',
    why:
      'on-chain payment rail — private createPublicClient probe + REQUIRE_PAY_EVM gate CI never sets. ' +
      'Also on tooling/ci/unreported-suites.mjs PRIVATE_PROBE. LIFTS WHEN: probe journals AND CI runs a chain or states it will not.',
  },
  { file: 'services/svc-pay/src/rails/broadcast-store.db.test.ts', kind: 'infra-journalled', why: PG },
  { file: 'services/svc-pay/src/rails/chain-watcher.db.test.ts', kind: 'infra-journalled', why: PG },
  { file: 'services/svc-pay/src/submerchants.test.ts', kind: 'infra-journalled', why: PG },
  { file: 'services/svc-pay/src/subscriptions/charge-cycle.db.test.ts', kind: 'infra-journalled', why: PG },
  { file: 'services/svc-pay/src/subscriptions/subscriptions-done-bar.test.ts', kind: 'infra-journalled', why: PG },
  { file: 'services/svc-pay/src/user-money-service.test.ts', kind: 'infra-journalled', why: PG },

  // ── svc-token ────────────────────────────────────
  { file: 'services/svc-token/src/promise-falsify-public-doors.test.ts', kind: 'infra-journalled', why: PG },
  { file: 'services/svc-token/src/token-service.test.ts', kind: 'infra-journalled', why: PG },

  // ── svc-trade ────────────────────────────────────
  { file: 'services/svc-trade/src/copy/follow-store.sql.test.ts', kind: 'infra-journalled', why: PG },
  { file: 'services/svc-trade/src/futures/closing-position-uniqueness.test.ts', kind: 'infra-journalled', why: PG },
  { file: 'services/svc-trade/src/futures/dated-futures-settlement.money.test.ts', kind: 'infra-journalled', why: PG },
  { file: 'services/svc-trade/src/futures/funding-margin-idempotency.test.ts', kind: 'infra-journalled', why: PG },
  { file: 'services/svc-trade/src/futures/isolated-margin-storage.test.ts', kind: 'infra-journalled', why: PG },
  { file: 'services/svc-trade/src/futures/liquidation-waterfall.money.test.ts', kind: 'infra-journalled', why: PG },
  { file: 'services/svc-trade/src/futures/margin-mode-switch.money.test.ts', kind: 'infra-journalled', why: PG },
  { file: 'services/svc-trade/src/futures/mark-from-venue-payout.test.ts', kind: 'infra-journalled', why: PG },
  { file: 'services/svc-trade/src/futures/orderable-path.test.ts', kind: 'infra-journalled', why: PG },
  { file: 'services/svc-trade/src/futures/portfolio-margin-refuse.money.test.ts', kind: 'infra-journalled', why: PG },
  { file: 'services/svc-trade/src/futures/position-close-concurrency.test.ts', kind: 'infra-journalled', why: PG },
  { file: 'services/svc-trade/src/futures/position-service.test.ts', kind: 'infra-journalled', why: PG },
  { file: 'services/svc-trade/src/spot/fill-sequence-conflict.test.ts', kind: 'infra-journalled', why: PG },
  { file: 'services/svc-trade/src/spot/gtd-gtt-place.test.ts', kind: 'infra-journalled', why: PG },
  { file: 'services/svc-trade/src/spot/oco-place.test.ts', kind: 'infra-journalled', why: PG },
  { file: 'services/svc-trade/src/spot/order-route-chaos.test.ts', kind: 'infra-journalled', why: PG },
  { file: 'services/svc-trade/src/spot/order-route-properties.test.ts', kind: 'infra-journalled', why: PG },
  { file: 'services/svc-trade/src/spot/order-route-reconcile.test.ts', kind: 'infra-journalled', why: PG },
  { file: 'services/svc-trade/src/spot/order-route-seed.test.ts', kind: 'infra-journalled', why: PG },
  { file: 'services/svc-trade/src/spot/qty-up-amend.test.ts', kind: 'infra-journalled', why: PG },
  { file: 'services/svc-trade/src/spot/reduce-only-place.test.ts', kind: 'infra-journalled', why: PG },
  { file: 'services/svc-trade/src/spot/sequence-guard.test.ts', kind: 'infra-journalled', why: PG },
  { file: 'services/svc-trade/src/spot/trade-service.test.ts', kind: 'infra-journalled', why: PG },
  { file: 'services/svc-trade/src/spot/gtd-gtt-place.test.ts', kind: 'infra-journalled', why: PG },
  { file: 'services/svc-trade/src/spot/qty-up-amend.test.ts', kind: 'infra-journalled', why: PG },
  { file: 'services/svc-trade/src/spot/reduce-only-place.test.ts', kind: 'infra-journalled', why: PG },
  { file: 'services/svc-trade/src/spot/close-position.test.ts', kind: 'infra-journalled', why: PG },
];
