# LANE: L06 BANK wave 4 · 2026-08-09

**Tip at writing:** re-derive (`git fetch && git log -1 --oneline origin/main`).  
Paste tip was `f3ba09f0` — **tip wins**.

---

## Shipped

| Item                   | Proof      | Plain words                                     |
| ---------------------- | ---------- | ----------------------------------------------- |
| **#1186**              | **MERGED** | User session cannot credit an on-ramp           |
| **#1267**              | **MERGED** | README stops lying about loans/cards/ramps      |
| Sealed **#1102** holds | on tip     | Card hold recovery                              |
| Sealed **#1159** pause | on tip     | Standing-order pause/resume — do not re-ship    |
| Sealed **#1174** JIT   | on tip     | Card settlement ≠ funding asset; no invent rate |

---

## In flight (babysit → merge when green)

| PR        | Unit                                           | Class | Notes                                |
| --------- | ---------------------------------------------- | ----- | ------------------------------------ |
| **#1194** | earn/loan id term-compare                      | M-adj | Rebased; Class M audit posted        |
| **#1229** | standing order honors space lock/archive       | P/M   | Reject + named code; no silent drain |
| **#1265** | loan false-cure after full coll sale           | M     | Residual interest ≠ healthy active   |
| **#1270** | earn pending deposit resume                    | M     | Typecheck may need fix — babysit     |
| **#1271** | transfer kill-switch on ops + offramp conflict | N     | Flag parity + named ramp conflict    |
| **#1277** | cardResumeSettlement user FORBIDDEN            | N     | Same shape as #1186                  |

---

## Parked (+ why)

| Unit                             | Why                                           |
| -------------------------------- | --------------------------------------------- |
| Earn day-boundary full-day yield | **Nitro product** — proration vs min full day |
| Fiat ramp partner                | Class X / §13                                 |
| Live card issuer                 | Class X                                       |
| Auto-invest / business           | No Done bar without rates/KYB                 |
| On-chain sovereign JIT           | Shehzad — babysit only                        |

---

## Engine B / C (summary)

- spaces = ledger **holds**
- pause **sealed** (#1159)
- schedule lock residual → **#1229**
- earn pending strand → **#1270**; day-boundary **Nitro**
- loans false-cure → **#1265**
- cards #1102/#1174 sealed; resume ops gate → **#1277**
- ramps crypto + #1186 on tip; fiat X

---

## Nitro must decide

1. Earn day-boundary product (proration vs min day)
2. Fiat partner Class X
3. Card issuer Class X  
   **or none** for pure merge babysit of green bank PRs.

---

## Engine A count (8+)

1. #1186 land
2. #1194 term-compare
3. #1229 schedule lock
4. #1265 loan false-cure
5. #1270 earn pending resume
6. #1271 killswitch + offramp
7. #1267 README
8. #1277 cardResume FORBIDDEN

```
LANE: L06 BANK wave 4
shipped: #1186 user cannot credit on-ramp · #1267 README truth · sealed #1102/#1159/#1174
in flight: #1194 #1229 #1265 #1270 #1271 #1277
parked: earn day-boundary (Nitro) · fiat X · issuer X · auto-invest/business
Nitro must decide: day-boundary · fiat · issuer · or none
SAFE TO CLOSE: no — open bank PRs still in CI
tip: re-derive
```
