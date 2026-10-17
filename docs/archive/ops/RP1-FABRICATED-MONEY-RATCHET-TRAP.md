# RP1 trap — fabricated-money ratchet (#449)

**Status:** BINDING for any agent touching `Exchange.vue` / money display on shell  
**Source:** Denon agent 2026-08-03 (hit this on his own branch)

## What happens

The fabricated-money scan freezes **12 findings by exact matched text**. It fails if findings **grow or shrink** without baseline update.

~**8 of 12 strings live in `Exchange.vue`** (scale/fee/0.00/float product patterns).

Doing **RP1 correctly** (remove float invent) makes CI **red** until you **delete those baseline rows in the same commit**.

## Combat

1. Read `tooling/ci/fabricated-money-scan.mjs` baseline before editing Exchange.vue
2. Same PR: code fix **and** baseline shrink
3. Do **not** revert the honesty fix when red — lower the ratchet
4. Residual stamp may note ratchet updated

## Related claims

RP1 · any residual that removes frozen fabricated strings on shell
