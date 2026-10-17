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

## TRD540FIX

The Opus review of #4832 at `6677a81b4` failed. This pass applies that review on top of that commit. HOLD for lead Opus re-review. Not pushed. Not merged.

1. An absent `order.hold` key can delete or cancel only after the row has been `hold_unknown` for `HOLD_UNKNOWN_IN_FLIGHT_BOUND_SECONDS` (7 minutes) on the database clock. The bound is the same one svc-bank uses, cited from `loan-service.ts` and the ledger pool timeouts. While any of that wait is left, an absent read is treated like an unknown read: the row stays, an alert is raised, and the caller gets `trade.hold_unknown` with the seconds left. Reads do not bump `updated_at`.
2. `classifyHoldPostError` now returns `unsent` when undici's `cause.code` is `ECONNREFUSED`, `ENOTFOUND`, or `EAI_AGAIN`, walked at most three levels. That class deletes the pending row, as a named ledger refusal does. `ECONNRESET`, socket hang up, `UND_ERR_SOCKET`, any 5xx, and every other shape stay `unknown`. On the place path an unknown outcome is marked `hold_unknown` and the key is read. Present opens and submits. Absent or unknown keeps the row and throws. The place path does not delete, because the row is brand new.
3. Cancel on `hold_unknown`: unknown still throws. Absent inside the bound throws and keeps the row. Absent past the bound sets `cancelled` with `RETURNING`. Present claims `hold_unknown` to `open` with `RETURNING` and calls `finalize('cancelled')` directly, so matching is not asked to cancel an order it never received. A lost claim throws `trade.hold_unknown` ("order is being resolved; retry") and does not fall through to the engine.
4. Before a booked `hold_unknown` order is submitted, resume refuses when spot is off, the lifecycle gate throws, the market is not `active`, or a market/IOC/FOK order is older than `TRADE_HOLD_UNKNOWN_TAKER_MAX_AGE_MS` (default 30s, min 1s, max 10 min, wired through env, compose, and TradeService). A refusal claims the row and releases the full hold, with an alert that names the reason. A same-key retry whose read is absent inside the bound may re-post that identical hold after those gates pass. Success submits. A refusal or a lost reply keeps the row and throws. The sweep never re-posts.
5. `index.ts` passes `onHoldUnknownAlert` into TradeService so a lost reply is logged. `getTxByKey` returns null only when `found === false`. `found === true` requires a non-empty `txId`. Any other shape throws.
6. `presentCcxtOrder` sets `recoveryRequired` for `hold_unknown` as well as `recovery_required`, and still sets `holdUnknown`.
7. The new cases assert the hold balance, the `order.hold` and `order.hold.released` counts, whether matching was called, and the row status. They cover the late commit, the sweep inside and past the bound, all three cancel outcomes, the spot kill-switch, a stale taker, a never-sent connect error, one same-key re-post, the presenter, and `getTxByKey({})`. The empty-body case lives in `ledger-client.http.test.ts`: importing that client from the money file installs the pretrade mill and refuses every place.
8. Prettier was run on the files this branch changed, including this note and `receipts/TRD540/PR-BODY.md`.
9. A close whose hold post is not a definite refusal or a never-sent error is marked `hold_unknown` and kept. If the key is present, the close continues. One test books the hold, throws `ECONNRESET`, and checks the row and the hold are still there.

VERIFIED: `pnpm --filter @intafaced/svc-trade test` — 316 files, 2890 passed, exit 0. `pnpm --filter @intafaced/svc-trade typecheck` — clean. Postgres was `127.0.0.1:15541`, started for this job and stopped afterwards. Docker was not started. `TEST_DATABASE_URL` pointed at `trd540_admin_test`.

Nothing parked. HOLD for lead Opus re-review.
