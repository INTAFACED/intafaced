## Summary
- A lost reply from `order.hold` no longer deletes the pending order. The row stays in `hold_unknown` until `getTxByKey('order.hold:<orderId>')` answers.
- If the hold was booked, the order is submitted once. If it was not booked, the unfunded row is removed and nothing is released. A named ledger refusal still deletes the pending row.
- Orders left in `hold_unknown` are recovered by `sweepHoldUnknown`, which alerts. The same `clientOrderId` resolves the row instead of holding the funds twice.

HOLD for lead Opus review. Do not merge. Money path.

## Test plan
- [x] Timeout after the hold is booked: order opens, one hold, engine sees it once.
- [x] Timeout before the hold is booked: no order row, no hold, no release.
- [x] Definite refusal (`InsufficientFundsError`): no row, no `hold_unknown`.
- [x] Retry with the same `clientOrderId` after a failed read: one hold, order opens.
- [x] Sweep: booked hold is submitted; absent hold is deleted with no release; both alert.
- [x] `pnpm --filter @intafaced/svc-trade test` — 316 files, 2880 tests, exit 0 (VERIFIED, local Postgres, no Docker).
- [x] `pnpm --filter @intafaced/svc-trade typecheck` — clean (VERIFIED).
- [ ] Lead Opus review of this head. Not pushed. Not merged.
