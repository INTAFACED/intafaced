# LANE STOP — L02 PAY · wave 11 · 2026-08-09

```
LANE: L02 PAY wave 11 product-velocity
shipped: #1614 merchants list mandates + subscriptions + release stale pay.subscriptions claim · #1618 merchants list settlement windows · open bank empty at cook start (#1585 already on tip)
in flight: none
parked: chargeback wire + content (Nitro Class M/X) · pay:* grants / fee tables / acquirer Class X · pre-charge real notify · dunning ladder · KYB money-gate product · card mandate rail invent · full PSP/PayFac product-complete (Denon) · pay.plugins invent · smart routing geo/risk/approval rates (Nitro §8 — refuse invent)
Nitro must decide: pay:* grant path · chargeback wire · fee/acquirer Class X · plugins reclassify — or none this wave
SAFE TO CLOSE: yes — product residual-empty under agent fences; only Nitro-only / L6–L7 parks left
tip: 1fcc3128
```

## A0 — open pay PR bank

| PR                                   | Result                                                  |
| ------------------------------------ | ------------------------------------------------------- |
| #1585                                | **already on tip** at cook start (subscription history) |
| (none open on `services/svc-pay/**`) | empty bank after tip ritual                             |

Sealed re-verify (do not re-ship): #1507 public refund double · #1527 reverse-refund + path allowlist · #1560 refundId amount bind · #1580 mandate cancel — **HOLD** under tip.

## Engine A — residual disposition

| Prio | Unit                         | Disposition                                                                |
| ---- | ---------------------------- | -------------------------------------------------------------------------- |
| A0   | Open pay PR merge            | empty; #1585 already merged                                                |
| A1   | subscriptions merchant fleet | **done** #1614 `mandate.list` + `subscription.list`                        |
| A1   | public-api ADR §4            | **already complete** (grants Nitro park)                                   |
| A1   | routing                      | **already complete** for honest preference + no invent pin                 |
| A2   | settlement fleet list        | **done** #1618 `settlement.list`                                           |
| A2   | gateway crypto               | hosted checkout + links on tip; KYB money-gate park                        |
| A2   | refund honesty residual      | seals hold — no re-cook                                                    |
| A3   | mountain-event               | **done** #1614 release nitro-agents wip left after W10 residual-empty stop |

## Engine B — promise falsification (tip `1fcc3128`)

| Claim                               | Verdict                                             |
| ----------------------------------- | --------------------------------------------------- |
| Mandate cancel immediate            | Holds (#1580)                                       |
| Sub cancel immediate                | Holds                                               |
| Merchant list mandates / subs       | Holds (#1614)                                       |
| Merchant list firings               | Holds (#1585)                                       |
| Merchant list settlements           | Holds (#1618)                                       |
| Card path no silent crypto invent   | Holds (#1527 normalise + fire `!== crypto_invoice`) |
| Public REST money idempotent refund | Holds (#1507/#1560)                                 |
| No dual book                        | Holds                                               |
| Pre-charge notify                   | Absent by honesty pin (#1380)                       |
| Chargebacks move money              | Unwired; Class X                                    |
| Smart routing invent rates          | Refused pin                                         |

## Engine C — attack surface

| Surface            | Status                   |
| ------------------ | ------------------------ |
| Double refund      | Sealed #1507/#1527/#1560 |
| Auto-pull          | No invent                |
| Fake approval rate | No invent pin            |
| Dual book          | Forbidden                |
| Grant invent       | Nitro §8 park            |

## Pick-up next cook (only if Nitro opens a gate)

1. KYB money-gate product law → refuse matrix
2. Pre-charge `subscription.invoice_upcoming` on merchant webhook journal
3. Chargeback wire after Nitro Class M/X content
4. Dunning ladder after product law
5. `pay.plugins` reclassify: one TS reference client **or** §13 socket

## Denon fence

No invent-risk PSP product-complete. Did not dual-edit Shehzad #1177.
