## Summary

- A lost reply from `order.hold` no longer deletes the pending order. The row stays in `hold_unknown` until `getTxByKey('order.hold:<orderId>')` answers, and an absent answer is not trusted until the row has been `hold_unknown` for 7 minutes on the database clock.
- A connect error proven to have happened before any byte was sent (`ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN` on `cause`, three levels) still deletes the pending row. `ECONNRESET`, a socket hang up, and any 5xx do not.
- A booked `hold_unknown` order is submitted only after the spot kill-switch, the market lifecycle gate, market status, and the taker-age cap are checked again. A refusal releases the hold. Cancel of a booked `hold_unknown` row releases it directly and does not ask matching. Customers see `hold_unknown` as `recoveryRequired`.

HOLD for lead Opus re-review. Do not merge. Money path.

## Test plan

- [x] Late commit: the read says absent, the hold is booked afterwards, the row stays, and the next sweep submits it.
- [x] Sweep absent inside the 7-minute bound keeps the row; past the bound it deletes, with no release.
- [x] Cancel on `hold_unknown`: unknown throws; absent inside the bound throws; absent past the bound cancels; present releases the full hold and never calls matching.
- [x] Sweep with spot disabled, hold present: no submit, hold released, row `rejected`.
- [x] Taker older than `TRADE_HOLD_UNKNOWN_TAKER_MAX_AGE_MS`: released, not submitted.
- [x] `ECONNREFUSED` before send deletes the row immediately.
- [x] Same-key retry inside the bound with an absent read re-posts once and submits.
- [x] `hold_unknown` is presented with `recoveryRequired: true`.
- [x] `getTxByKey` throws on `{}`.
- [x] A close whose hold post throws `ECONNRESET` after booking keeps the row and the hold.
- [x] `pnpm --filter @intafaced/svc-trade test` — 316 files, 2890 tests, exit 0 (VERIFIED, local Postgres `127.0.0.1:15541`, no Docker).
- [x] `pnpm --filter @intafaced/svc-trade typecheck` — clean (VERIFIED).
- [ ] Lead Opus re-review of this head. Not pushed. Not merged.
