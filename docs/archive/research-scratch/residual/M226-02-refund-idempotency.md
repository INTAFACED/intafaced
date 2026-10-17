# Residual pack — M226-02 refund chain idempotency key

**Severity:** P1 Class M  
**Status 2026-07-31 residual-pay close:** **FIXED** (agent) — PR residual/pay-m226-close

## Claim (was)

`pay.refund:${ref}:${++refundSequence}` process-local; restart could double on-chain refund.

## Fix

1. `RailAdapter.refund(ref, amount, opts?: { refundId })` optional third arg
2. Payment core Phase 2 passes durable `prepared.refundId`
3. `CryptoNativeAdapter` keys `pay.refund:${ref}:${refundId}` when set; sequence fallback only without id
4. Same-process completed-key cache so retry does not double-count refunded totals
5. Test: durable refundId + adapter reset still single outbound send (`rails.test.ts`)

## Residual after fix

- Process-local `refunded` amount map still not multi-replica (over-refund guard is best-effort in adapter; core ledger is authority)
- Conformance paths without refundId still use sequence (tests only)

## Critic

ACCEPT fix for chain key durability. HOLD product go-live until pilot ops accepts send→put P1 window (M226-01).
