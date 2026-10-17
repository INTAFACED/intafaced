# LANE STOP — L02 PAY · wave 7 · 2026-08-09

```
LANE: L02 PAY wave 7
shipped: #1430 settle re-run heals after ledger crash (no double credit) · #1438 KYB gap / silent dispute webhooks / unwired chargeback pins · #1380 subscription charges not pre-notified (honest gap) · #1367 merchant mandate + subscription create/get/cancel (no auto-pull) · #1449 W6 stop banked
in flight: none (open pay PR bank empty)
parked: chargeback wire + content (Nitro Class M/X) · pay:* grants / fee tables / acquirer Class X · pre-charge real notify hook (events/webhook journal) · dunning ladder · KYB money-gate product (honesty pin holds: assertMerchantActive still status-only) · crypto card mandate rail invent
Nitro must decide: pay:* grant path · chargeback wire · fee/acquirer Class X — or none this wave
SAFE TO CLOSE: yes — residual-empty honesty (only Nitro-only / L6–L7 parks left); thrift hard at stop (merge-bank only, no pad)
tip: b4c7d260
```

## A0 — open pay PR merge bank (this cook)

| PR    | Title                                   | Result                |
| ----- | --------------------------------------- | --------------------- |
| #1430 | settle re-run heals after ledger crash  | **merged** `277a053f` |
| #1438 | KYB / dispute / chargeback honesty pins | **merged** `5002b4b8` |
| #1380 | pre-charge notify absent pin            | **merged** `3da61203` |
| #1367 | merchant subscription mandates surface  | **merged** `4297af58` |
| #1449 | W6 L04 PAY lane stop                    | **merged** `ac1d9c88` |

All five were CI-green + mergeable before squash. Local branch delete noise only (worktrees still checked out).

## Engine A — residual disposition

| Prio | Unit                                           | Disposition                                                                                                                             |
| ---- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| A0   | Open pay PR merge bank                         | **done** — five merged                                                                                                                  |
| A1   | settle re-run heal                             | **done** — #1430; ledger idempotency + projection re-run                                                                                |
| A1   | KYB / silent dispute / unwired chargeback pins | **done** — #1438 (+ prior #1366 chargeback park)                                                                                        |
| A1   | subscription pre-notify honesty                | **done** — #1380                                                                                                                        |
| A2   | mandate manage                                 | **done** — #1367; default `crypto_invoice`, no pull invent                                                                              |
| A2   | address/ref validation before money            | **already on tip** — `assertPayoutDestinationKind` before `withdrawHold` (merchant payout + user withdraw); IFSC/IBAN/EVM matrix tested |
| A2   | ghost owner / tracker honesty                  | **no mountain event** — `pay.gateway` owner Nitro + reclaimed-agents note still accurate; not a ghost                                   |
| A3   | chargeback list content                        | **park Class X**                                                                                                                        |

## Engine B — chapter pass (tip)

| Claim                                          | Verdict                                                                         |
| ---------------------------------------------- | ------------------------------------------------------------------------------- |
| Settle: no double credit after ledger crash    | Holds (#1430 + recipe key `settlement:merchant:window:asset`)                   |
| Subscriptions: invoice-and-watch, no auto-pull | Holds (#1367 surface + default path + fire refuse on card without rail)         |
| Pre-charge notify before charge                | Absent by honesty (#1380) — not invented                                        |
| KYB gates money                                | **True-as-gap** (#1438 pin); product wire waits real approver / Nitro grant law |
| Disputes / chargebacks move money              | Unwired pins hold; content/wire Nitro Class M/X                                 |
| Gateway refuse (inactive, posture, dest shape) | Holds; dest refuse before hold on tip                                           |
| WITHHELD pay:* grants                          | Still Nitro §8 — never invent                                                   |

## Engine C — attack surface

| Surface                             | Status                                             |
| ----------------------------------- | -------------------------------------------------- |
| Double settle                       | Pinned sequential + crash heal; locks + ledger key |
| Auto-pull                           | No invent; crypto_invoice default                  |
| Fake KYB as gate                    | Honesty pin (decorative until product law)         |
| Dual-write `packages/ledger-client` | Not touched this wave                              |

## Thrift note

Stop-time thrift was **hard** (total/docs/ci caps). This cook only **merged already-green** PRs (allowed under thrift preflight) and opens one **docs** stop PR with `THRIFT_ALLOW=1` if required. No pad / no dual-write thrash.

## Pick-up next cook (only if Nitro opens a gate)

1. KYB money-gate product law → refuse matrix (breaks #1438 pin deliberately)
2. Pre-charge `subscription.invoice_upcoming` on merchant webhook journal (coord L08 notify)
3. Chargeback wire after Nitro Class M/X content
4. Dunning ladder after product law

## Denon fence

No invent-risk PSP product-complete. Did not dual-edit Denon open files (#1472 venue · #1463 Java map · #1461 rulings · #1457 spine; #1467 staging already on tip earlier this cook).
