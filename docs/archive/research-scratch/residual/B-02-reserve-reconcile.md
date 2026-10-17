# Residual pack — bank B-02 reconcileReserve tautology

**Severity:** MED  
**Status:** OPEN

## Claim

`funded = reserve + outstanding` and `drift = 0` always — not independent of bank rows.

## Independent sum options

1. Ledger journal sum of `loan.reserve.funded` reasons (needs ledger history API / S2S)
2. Bank `loan_reserve_fundings` table written on fundReserve

## Finish disposition

HOLD until ledger history or funding table. Comment already in loan-service. No fake drift metric.
