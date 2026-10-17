# Lane stop — L06 BANK wave 6 · 2026-08-09

**Tip at writing:** re-derive (`git fetch && git log -1 --oneline origin/main`).

---

## Operator block

```
LANE: L06 BANK wave 6
shipped: #1439 loan id keeps same opening collateral + pending reconcile filter + independent reserve funding table (B-02) · #1442 blank ramp asset refuse before credit · #1450 stop note (mid-wave)
in flight: none on svc-bank wall
parked: earn day-boundary product law (Nitro) · fiat partner Class X · card issuer Class X · auto-invest/business rates §8 · commercial crypto ramp allowlist (product law; shape refuse only)
Nitro must decide: earn day-boundary (proration vs min full day) · fiat · issuer · ramp pair allowlist · or none
SAFE TO CLOSE: yes — open bank code PRs merged; parks named with pick-up
tip: re-derive
```

---

## Shipped this wave (proof)

| PR        | Unit                                             | Class  | Notes                                                                           |
| --------- | ------------------------------------------------ | ------ | ------------------------------------------------------------------------------- |
| **#1439** | Opening collateral term-compare on loan id reuse | M      | `opening_collateral` + `bank.loan_collateral_mismatch`; borrower before amounts |
| **#1439** | Pending undrawn not outstanding                  | N/P    | `drawn_at IS NOT NULL` in reconcile                                             |
| **#1439** | Independent reserve funding (B-02)               | M      | `loan_reserve_fundings`; `independent:true`; real drift                         |
| **#1442** | Blank/whitespace ramp asset refuse               | M      | `bank.ramp_invalid_asset` before row/ledger                                     |
| **#1450** | Wave 6 stop note (mid)                           | N docs | Updated by this tip for SAFE yes                                                |

Sealed re-verified: fiat socket · session ramp credit FORBIDDEN · locked standing order · spaces=ledger · cards no-issuer · earn recipes · pause/resume.

---

## Engine A scorecard

| Unit                          | Result                                              |
| ----------------------------- | --------------------------------------------------- |
| A0 open bank PR babysit       | Wall clear at orient; **#1439 #1442** shipped       |
| A1 reserve reconcile residual | **#1439** independent funding table                 |
| A1 crypto ramps residual      | Shape refuse **#1442**; commercial allowlist parked |
| A1 fiat ramp residual         | Sealed fail-closed; partner **X**                   |
| A2 spaces = ledger            | Sealed re-verify                                    |
| A2 earn pool                  | Recipes sealed; day-boundary **park**               |
| A2 loan term-compare          | **#1439** includes collateral                       |
| A2 cards                      | Sealed; issuer **X**                                |
| A2 standing orders            | Sealed lock + pause                                 |
| A3 auto-invest                | **Parked**                                          |
| A3 independent funded sum     | **#1439**                                           |
| A3 bank↔token earn            | Sealed purpose pots                                 |
| A3 Engine B chapter pass      | Below                                               |

---

## Engine B — chapter pass

| Chapter                     | Verdict                                               |
| --------------------------- | ----------------------------------------------------- |
| Where balance lives         | HONEST — ledger only                                  |
| Spaces                      | HONEST                                                |
| Transfers / standing orders | HONEST — lock on fire, pause, kill-switch             |
| Earn                        | HONEST recipes; day-boundary product-open             |
| Loans                       | HONEST; term-compare + independent reconcile shipped  |
| Cards                       | HONEST ledger half + socket                           |
| Ramps                       | HONEST crypto half + fiat socket + blank asset refuse |
| Kill-switches               | Env job flags wired                                   |
| Token coordination          | Purpose-keyed pots                                    |

---

## Next for a fresh agent

1. Earn day-boundary only after Nitro product pick.
2. Commercial ramp allowlist only with product law.
3. Do not invent fiat partner or card issuer.

**SAFE TO CLOSE:** yes for wave-6 residual craft on `services/svc-bank/**`.
