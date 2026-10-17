# WAVE-AUDIT RESULT — money-class mega (#226–#250)

**Verdict:** **PASS-WITH-RESIDUALS**

**Tip:** `4b77c173cd04c1d347da53cefaecb0c8fdd42c0c` (#250)  
**Since:** `cd277dcc3fc2f71d3694b2eccc12b20d0fdb3f00` (#239 residual WAVE high water)  
**Date:** 2026-07-31  
**Method:** [`WAVE-AUDIT.md`](../../WAVE-AUDIT.md) mega-wave depth on money/auth delta only  
**Archive:** this directory  
**Not go-live. Audit exit ≠ money e2e. Multi-replica live rail ≠ green.**

---

## One breath

Deep adversarial pass on **#226 live EVM rail**, **#227 positions WS**, **#228 AMM+terminal**, **#244 sell cost**, **#246 sub-account S2S**. Doctrine/auth/honesty **hold**. Local L0 doctrine + build + typecheck + test + gate **green** (money PG suites skipped). Critic **accepted** Class M residuals (broadcast journal, refund key interface, first-tx dust) and **downgraded** watcher mark-before-2xx to P2. **No agent Class M product invent this fire.** Stale AMM “does not compile” docs **fixed** in this PR.

---

## Exit checklist ([`WAVE-AUDIT.md`](../../WAVE-AUDIT.md))

| Criterion                                      | Status                                                                                                 |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| New tip SHA recorded                           | **YES** — tip above                                                                                    |
| L0 brand/custody/format/tracker (+ build/test) | **YES** — `01-L0.md` complete                                                                          |
| Every new money/auth surface judged            | **YES** — 03A–D + rollup                                                                               |
| P0 fixed or blocked with reason                | **YES** — M226-01 multi-replica **P0 hold**; pilot crash-window **P1 residual**; no fake durable store |
| Adversarial pass named for each P0/P1          | **YES** — `04-ADVERSARIAL.md`                                                                          |
| PEACE scoreboard updated                       | **YES** — this PR                                                                                      |

---

## Primary targets

| PR                       | Verdict                 |
| ------------------------ | ----------------------- |
| #246 S2S ownership       | **PASS**                |
| #227 private positions   | **PASS**                |
| #228 AMM + equity/charts | **PASS** (+ doc fix)    |
| #244 market-sell cost    | **PASS**                |
| #226 live EVM rail       | **PASS-WITH-RESIDUALS** |

---

## Residual queue (carry forward)

| #   | Item                                                     | Sev after critic | Who                                   |
| --- | -------------------------------------------------------- | ---------------- | ------------------------------------- |
| 1   | **MemoryBroadcastStore** — multi-replica double outbound | **P0 hold**      | Denon durable journal + human go-live |
| 2   | Same store — single-process crash between send and put   | **P1 residual**  | Denon + ops eyes-open pilot           |
| 3   | Refund chain key = process `refundSequence` not refundId | **P1**           | Denon interface / Class M PR          |
| 4   | First-tx-wins dust locks address                         | **P1 product**   | Denon product decision                |
| 5   | Watcher finalized before webhook 2xx                     | **P2**           | agent later                           |
| 6   | ERC-20 lookback / in-memory address book                 | **P2**           | HA track                              |
| 7   | Dual-book **policy ADR**                                 | human            | owner                                 |
| 8   | Secrets / go-live / licences                             | human            | owner                                 |
| 9   | Stream A browser PROOF                                   | Nitro desktop    | still UNVERIFIED                      |
| 10  | Money PG e2e local                                       | human env / CI   | skip ledger in 01-L0                  |

---

## Closed this fire (do not re-open without regression)

- Judgment that #246/#227 fail-closed auth and empty-honest positions
- #228 no fake equity/OHLCV/AMM reserves; compile artefacts real
- #244 cost null honesty
- #226 ledger-only booking + decimal amounts + posture fail-closed (controls)
- Stale README/compile-header “ConstantProductPool does not compile”
- Tracker: pay.rails `done` under doctrine (path under env) ≠ go-live

---

## Archive index

- `CONTINUE-AFTER-COMPACT.md` — recovery entry
- `00-PLAN-AND-FREEZE.md`
- `01-L0.md`
- `02-DELTA.md`
- `03A` … `03D` + `03-FINDINGS.md`
- `04-ADVERSARIAL.md`
- this file

---

## What Denon would still flinch at

1. Live rail outbound journal is memory-only — **no multi-replica**
2. Refund adapter keys not durable across process restart
3. Dust first-tx product hole on open invoices
4. Money PG suites not re-run here
5. Dual-book ADR + secrets still owner

**Ship posture:** single-process pilot with eyes open; **do not** claim multi-replica or go-live green.
