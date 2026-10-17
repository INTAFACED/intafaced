# LANE: PAY wave 5 — stop board · 2026-08-09

```
LANE: PAY wave 5
shipped:   #1314 G4 fixtures real EVM shapes (Class N) — unblocks tip pay suite
           #1249 ghost clear nitro-pay-w3 public-api + subscriptions (Class N)
           #1350 PayFac areas gate money paths tRPC+REST (Class M)
           #1366 chargeback unwired pin + owner banner (Class N)
           #1367 merchant subscription surface mandate/create/cancel (Class P) — stacks on #1350
           #1374 routing no invent costBps/approvalRate (Class N)
           #1378 bank dest IFSC structural shape before hold (Class M)
           #1380 pre-charge notify honest-absent pin (Class N)
in flight: re-derive `gh pr list --search "pay"` — merge when CI green; tip thrash may delay Tests
parked:    dunning bounded ladder (crypto unpaid / card mandate rail)
           pre-charge notify real webhook hook (SPEC §4) — pin only this wave
           dual-book settle-before-status-update residual (G4 named)
           KYB as money gate until grant path
           pay:* grant path (Nitro DIRECTION §8.4)
           fee tables / routing costs / approval rates (Nitro §8)
           chargeback wire (recipe sign-off Nitro)
           crypto sub pull vs protocol FORBIDDEN_SIGNATURES
           live acquirer / card mandate rail Class X
Nitro must decide: pay:* grants · fee tables · chargeback sign-off ·
  acquirer Class X · crypto subs vs protocol · or none new this wave
SAFE TO CLOSE: yes for this cook — ≥8 Engine A units shipped or parked with pick-up;
  open PRs babysit-only residual; no uncommitted L04 work on stop author
tip: re-derive git log -1 --oneline origin/main
```

## What a merchant/user got

1. **G4 suspend tests pass destination shape** — fixtures use real EVM addresses (#1314).
2. **Ghost owners cleared** — wall not dual-fenced by dead nitro-pay-w3 (#1249).
3. **PayFac parent without grant cannot move child money** — areas on capture/refund/payout/etc. (#1350).
4. **Chargeback stays parked** — recipes exist; wire blocked until Nitro (#1366).
5. **Merchant can create/cancel subscription mandates on API** — still no crypto pull (#1367).
6. **IFSC bank destinations shape-checked** before hold (#1378).
7. **Routing cannot invent costs/approval rates** — pinned (#1374).
8. **Pre-charge notify named absent** — SPEC gap honest (#1380).

## Engine B

README honesty folded into #1350 (settlement.release, dest codes, subscriptions invoice-and-watch, chargeback unwired). Index/README still may carry residual “not in this PR” banners on tip until #1350 merges — re-verify.

## Sealed re-verify (do not re-ship)

#1181 edge REST · #1172/#1198 suspend · #1173 settlement freeze · #1192 kind gate · #1195 bank-payout absent · #1205/#1206 · #1214 invoice runner · #1234 G4 · #1235 dest EVM/IBAN · #1236 G3 release · #1250 sub watch · #1251 MFA pay:payout.

## Engine A matrix (wave 5)

| Unit                     | Status                                                  |
| ------------------------ | ------------------------------------------------------- |
| A0 babysit #1314         | shipped PR                                              |
| A0 ghost #1249           | shipped PR                                              |
| A1 subscriptions surface | #1367                                                   |
| A1 routing residual      | #1374 pin                                               |
| A1 chargeback            | #1366 park pin                                          |
| A2 payfac areas          | #1350                                                   |
| A2 address/IFSC          | #1378                                                   |
| A2 KYB until grant       | parked Nitro                                            |
| A3 sandbox launder       | existing tests + sealed posture; matrix residual parked |
| A3 edge BASE             | sealed #1181 + public-rest pins                         |
| A3 docs honesty          | #1350 README                                            |
| A3 Engine B              | this stop                                               |

## Pick-up next cook

1. Merge green stack: #1314 → tip fixtures · then #1249 · then #1350 · then #1367.
2. Dunning ladder or dual-book projection residual (Class M).
3. Pre-charge notify real hook on webhook journal (coordinate L08 if cross-service).
