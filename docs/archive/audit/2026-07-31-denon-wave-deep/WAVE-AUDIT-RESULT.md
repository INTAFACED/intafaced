# WAVE-AUDIT RESULT — Denon money/spine deep (#201–#218 + fixes)

**Verdict:** **PASS-WITH-RESIDUALS** (backend only · no frontend)

**Tip base:** `2dc706b` (#251)  
**Date:** 2026-07-31  
**Scope:** adversarial depth on Denon money/spine merges that prior WAVE never fully proved; agent fixes for B-01 + M226-03

**Not go-live. Not multi-replica live rail. No Stream A / vendor UI.**

---

## One breath

Deep backend pass on **bank loans #202**, **hosted checkout #214**, **trade #201/#206**, **venue/factory/indexer #209/#210/#217/#218**. Trade + plane **PASS**. Checkout **PASS-WITH-RESIDUALS** (no new P0). Bank had **HIGH B-01** (shortfall zeroed debt without insurance post) — **fixed this fire**. Pay watcher **M226-03** mark-after-2xx **fixed** with tests. Prior money-class M226-01 multi-replica journal **still held**.

---

## Judgments

| Target                          | Verdict                      | Doc                            |
| ------------------------------- | ---------------------------- | ------------------------------ |
| #202 bank loans                 | **CONDITIONAL → fixed B-01** | `03-BANK-202.md`               |
| #214 hosted checkout            | **PASS-WITH-RESIDUALS**      | `03-PAY-214.md`                |
| #201 / #206 trade               | **PASS**                     | `03-TRADE-201-206.md`          |
| #209 / #210 / #217 / #218 plane | **PASS**                     | `03-PLANE-209-218.md`          |
| M226-03 watcher                 | **FIXED** this PR            | chain-watcher + test           |
| M226-01 broadcast journal       | **HOLD** Denon               | stress test documents residual |

---

## Fixes shipped this fire

1. **B-01** `outstanding()` only counts shortfall when `bad_debt_ledger_tx_id` set; `coverOpenShortfalls` re-drives insurance; extract `coverShortfallTranche`
2. **M226-03** `drainFinalized` peeks; `markFinalizedEmitted` only after webhook 2xx/202; unit tests + broadcast crash residual test

---

## Residual queue (carry)

| Item                                         | Sev        | Who                                    |
| -------------------------------------------- | ---------- | -------------------------------------- |
| MemoryBroadcastStore multi-replica           | P0 hold    | Denon                                  |
| Refund chain key sequence                    | P1         | Denon Class M                          |
| First-tx dust                                | P1 product | Denon                                  |
| Bank reconcileReserve drift hardcoded 0      | MED B-02   | agent later                            |
| Bank service suite skip without PG           | MED B-04   | CI/human                               |
| Checkout maxUses advisory / resolveLink leak | P2         | agent later                            |
| Dual-book **policy ADR**                     | human      | **other chat / owner — not this fire** |
| Stream A / frontend                          | other chat | **out of scope**                       |

---

## Proof

- `pnpm --filter @intafaced/svc-pay test` — 334 passed (incl. new watcher + broadcast)
- `pnpm --filter @intafaced/svc-bank test` — 58 passed (PG service suite still skippable)
- Full monorepo build green in worktree before ship

## Critic on B-01 patch (04-CRITIC-B01.md)

**DOWNGRADE of “fully fixed” claim:** core HIGH hole closed; follow-up patch closes status-stuck + repay dual-cover residuals. Still two ledger posts (not atomic). Service PG failure test still residual (B-04).
