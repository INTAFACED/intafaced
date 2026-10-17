# Residual pack — M226-04 first-tx-wins dust

**Severity:** P1 product  
**Status:** OPEN · **product decision required** before agent rewrite

## Claim

First inbound tx wins forever on acceptance address; dust can trap correct payment.

## Options (Denon/product)

A. Prefer amount ≥ expected (replace underpay)  
B. Sum multi-transfer until target  
C. Expire address + rotate  
D. Keep first-tx-wins; ops manual credit only

## DoD after decision

Implement chosen policy + tests + live note.  
**Agent ban:** inventing amount-match without decision.

## Finish disposition

HOLD human/product. Named residual only.
