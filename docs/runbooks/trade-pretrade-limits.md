# Runbook — owner pre-trade limits (svc-trade)

**Code:** `services/svc-trade/src/futures/pretrade-limits.ts` (the comparison), `pretrade-credit.ts` (the "must be published" refusal) · **Issue:** #4725.
**Config:** three env integers the owner publishes. This runbook does not set them; the values are the owner's decision (`docs/LOCAL-TEST-STACK.md` lists the LOCAL TEST values only).

| Env                  | What it caps                                                                                                                                    | Refusal code               |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `TRADE_MAX_ORDER`    | Notional (price x quantity) of ONE order, one convert accept, or one futures open.                                                              | `trade.limit_max_order`    |
| `TRADE_MAX_POSITION` | Notional of the user's resulting futures position on ONE market after an open, valued at the entry mark.                                        | `trade.limit_max_position` |
| `TRADE_MAX_LOSS`     | The user's current unrealised loss on open futures positions in that quote asset (losing positions summed; a winning one does not offset them). | `trade.limit_max_loss`     |

**Units.** Each is a whole integer number of the market's QUOTE asset (USDT for `BTC/USDT`), compared exactly (no floats). `1000000` means 1,000,000 USDT on a USDT market. Exactly at the limit is allowed; one unit over is refused. A published `0` refuses every new order or open (0 is a number the owner published, not a default).

## What the user sees

HTTP **422**, ccxt class `InvalidOrder` (not retryable unchanged), body `intafacedCode` = the code above, and a message that states the limit and the requested value, for example `order notional 200.02 USDT exceeds the max-order limit of 200 USDT (TRADE_MAX_ORDER)`. Nothing was held, locked or posted: the refusal comes before the hold or margin lock.

A separate family still exists: `trade.max_order_unset`, `trade.max_position_unset`, `trade.max_loss_unset` mean the env is blank or not an integer. Every new order or open refuses (fail closed) until all three are published, on every door including copy mirror and algo children.

## Where it applies

- Spot and futures-book orders (`placeOrder`, replace, copy mirror, algo child orders): `trade.limit_max_order`. A market buy is valued at its protection price (the most it can pay); a market sell at the best bid, and with no bid it is refused because it cannot be valued.
- Convert: the bound fill notional, on a fresh accept only (a recovery of an already-bound quote is never newly refused).
- Native quantity increase on an open order: the grown order must fit `TRADE_MAX_ORDER`.
- Futures open (`PositionService.open`): all three, in the order max-order, max-position, max-loss.

**Never refused** (reducing risk is never blocked): cancel, mass cancel, closing a position, liquidation, ADL, reconcile and funding jobs, seeded market-maker orders, paper markets, and retries of an order or open that was already admitted.

## What an operator does

1. **A user says an order was refused with `trade.limit_max_order` or `trade.limit_max_position`.** This is the limit working. Tell them the limit in the message and to resubmit smaller (position: reduce or close part of the existing position first; a reducing open or a close is never refused). Do not raise a limit to unblock one user: it is firm-wide and the owner decides it.
2. **`trade.limit_max_loss`.** The user is already down more than the limit across open futures positions. New risk stays blocked until the loss recovers (mark moves back) or they close positions. Closing is always allowed. Their loss is the sum of the losing positions at current marks, so closing the worst one brings it down.
3. **Many users hit `trade.max_*_unset` at once.** One of the three env vars is blank, has a decimal point, or has a typo. Check the svc-trade container env, publish the missing integer (owner's value), restart svc-trade. Do not invent a number to get trading back.
4. **Everyone is refused with a limit code.** Check the units first (whole quote units, not cents or base units), then whether the owner meant a limit that low. A value of `0` blocks everything by design.

## Known limits of this check (owner awareness)

- **Realised loss is not counted.** `TRADE_MAX_LOSS` compares current unrealised loss only. svc-trade does not store realised PnL (a closed position keeps no PnL column and a liquidated one keeps no exit price), and the owner has not named a window (session or day) for a realised figure. Counting it would need a stored realised-PnL ledger and an owner-chosen window.
- **MAX_POSITION applies to futures opens only.** Orders placed on a futures book through `placeOrder` do not create a row in `trade.positions`, and spot has no position, so only `TRADE_MAX_ORDER` caps them.
- **Positions are not netted in storage.** One-way mode counts the net across the user's long and short rows on that market; a short opened against a long is a second row, not a reduction of the first. Hedge mode counts each side on its own.
- **Concurrency.** There is at most one open row per (user, market, side), so two parallel opens cannot stack one side past `TRADE_MAX_POSITION`: the second fails at insert and its margin is released. `TRADE_MAX_LOSS` reads other markets without a lock, so it is a best-effort gate on new risk per request.
