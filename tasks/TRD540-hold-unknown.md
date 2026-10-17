A lost order-hold reply no longer deletes the order. The row stays in `hold_unknown` until the order's own hold key is read back.

## Started
Branch `fix/trade-hold-unknown-outcome` from `origin/main` (`beab17b9b`) in `~/projects/sovereign-worktrees/cursor-trd540`. Money code. Not pushed. Not merged.

## What changed
`services/svc-trade/src/spot/trade-service.ts` used to delete a `pending` order on any error from `order.hold`, including a timeout after the hold was booked. The funds could stay held with no order.

Now:
- A named ledger refusal (`ledger.insufficient_funds`, invalid entry, unbalanced, owner identity, frozen, unauthenticated, freeze attributed) still deletes the pending row and rethrows.
- Any other error, including a dropped connection, sets the row to `hold_unknown` and reads `order.hold:<orderId>` through `ledger.getTxByKey`.
- If that transaction exists, the order is opened and submitted once.
- If the read says the hold is absent, the unfunded row is deleted and nothing is released.
- If the read itself fails, the row stays `hold_unknown`, an alert is raised, and the caller gets `trade.hold_unknown`.
- The same `clientOrderId` resolves that row instead of opening a second hold.
- `sweepHoldUnknown` repeats the read for stuck rows. It submits a booked hold, deletes an absent one, and alerts either way. The timer starts with svc-trade (`TRADE_HOLD_UNKNOWN_SWEEP_ENABLED`, default on, 60s).

`recovery_required` is unchanged. That status is for a lost matching-engine reply after the hold is already known.

## Checked
VERIFIED on this machine, Postgres `127.0.0.1:15490` (a database started for these tests, then stopped), `TEST_DATABASE_URL` set so the suite did not start Docker.

- `pnpm --filter @intafaced/svc-trade test` — 316 files, 2880 tests, exit 0.
- `pnpm --filter @intafaced/svc-trade typecheck` — clean.
- The new cases in `trade-service.test.ts`: timeout after the hold is booked, timeout before it is booked, a definite refusal, retry with the same key, sweep recovery of a booked hold and of an unfunded intent.

## Held
HOLD for lead Opus review. Not merged. Not pushed. No GitHub call was made.

## Finished
Local head is the commit on `fix/trade-hold-unknown-outcome`. See `receipts/TRD540/PR-BODY.md`.
