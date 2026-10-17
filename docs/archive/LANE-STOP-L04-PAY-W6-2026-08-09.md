# LANE STOP — L04 PAY · wave 6 · 2026-08-09

```
LANE: L04 PAY wave 6
shipped: #1384 W5 stop banked · #1350 PayFac parent grant gates child money · #1249 nitro-pay-w3 ghost clear · #1374 routing no invent · #1366 chargeback park pin · #1378 IFSC dest shape before hold
in flight: #1367 merchant sub mandates (Context.service fix pushed) · #1380 pre-charge notify absent pin · #1430 settle dual-book heal · #1438 KYB/dispute/chargeback honesty pins
parked: chargeback wire (Nitro Class M) · pay:* grants (Nitro §8) · fee tables · crypto card mandate rail · pre-charge real notify hook · dunning ladder · split payfac recipes
Nitro must decide: pay:* grant path · chargeback wire · fee/acquirer Class X · or none this wave if only babysit
SAFE TO CLOSE: yes for this cook — ≥8 Engine A units merged or PR'd with pick-up; open PR babysit continues
tip: 2f9a7df0
```

## Engine A — units this wave

| #   | Unit                                               | Status                                 |
| --- | -------------------------------------------------- | -------------------------------------- |
| A0  | Merge #1384 W5 stop                                | **merged**                             |
| A0  | Ghost clear nitro-pay-w3                           | **#1249 merged**                       |
| A1  | PayFac area money gate                             | **#1350 merged**                       |
| A1  | Routing no invent                                  | **#1374 merged**                       |
| A1  | Chargeback park                                    | **#1366 merged**                       |
| A2  | IFSC dest shape                                    | **#1378 merged**                       |
| A2  | Sub merchant surface                               | **#1367** in flight                    |
| A2  | Pre-charge notify honest gap                       | **#1380** in flight                    |
| A3  | Dual-book settle heal pin                          | **#1430** in flight (Tests green once) |
| A3  | Honesty pins (KYB / dispute / chargeback uncalled) | **#1438** in flight                    |

## Engine B — chapter pass (short)

| Claim                      | Verdict                           |
| -------------------------- | --------------------------------- |
| Invoice-and-watch, no pull | Holds on tip                      |
| Edge BASE /v1              | Sealed (#1181 + ghost clear)      |
| PayFac areas on money      | Landed #1350                      |
| Dest shape (EVM + IFSC)    | Tip + #1378                       |
| Chargeback                 | Parked recipes; pin #1366         |
| Pre-charge notify          | Absent (pin #1380); SPEC gap      |
| WITHHELD pay:* grant       | Still Nitro §8 — never invent     |
| Sandbox prod boot refuse   | Already matrixed in posture tests |

## Engine C

WITHHELD scopes, edge strip, idempotency, sandbox vs live, status exits — no new invent. Sandbox override residual under `PAY_ALLOW_SANDBOX_RAILS` still real-ledger debit risk (README honesty).

## Babysit notes

- Tip pay suite flaked 5s timeouts on public-rest + posture under parallel load (not a product break).
- #1380 earlier red was **svc-ledger** sibling, not pay — do not dual-write ledger.
- Closed obsolete G4 fixture PRs #1314/#1317 (already on tip).

## Pick-up next cook

1. Merge greens: #1367 #1380 #1430 #1438
2. Dunning ladder (P) after #1367
3. Dual-book if #1430 proves need for code (test may already pass via ledger idempotency)
4. Never invent grants / fees / chargeback wire
