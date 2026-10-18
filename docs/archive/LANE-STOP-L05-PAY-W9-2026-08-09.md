# LANE STOP — L05 PAY · wave 9 · 2026-08-09

```
LANE: L05 PAY wave 9
shipped: #1560 same refundId cannot mean a different amount + empty body key uses rest id + ADR/README promise-falsify (after #1507/#1527 seals re-verified)
in flight: none
parked: chargeback wire + content (Nitro Class M/X) · pay:* grants / fee tables / acquirer Class X · pre-charge real notify hook (merchant webhook extend or park) · dunning ladder · KYB money-gate product (honesty pin holds) · card mandate rail invent · tRPC optional refundId still attempt-ordinal (internal surface; REST is ADR public — supply refundId or accept unsafe under retry)
Nitro must decide: pay:* grant path · chargeback wire · fee/acquirer Class X — or none this wave
SAFE TO CLOSE: yes — residual-empty honesty (only Nitro-only / L6–L7 parks left)
tip: 62317508
```

## A0 — open pay PR bank

| PR                 | Title                                          | Result                |
| ------------------ | ---------------------------------------------- | --------------------- |
| none at cook start | —                                              | empty bank            |
| #1560              | same refundId different amount / empty rest id | **merged** `62317508` |

Sealed re-verify (do not re-ship): #1507 public refund double · #1527 reverse-refund spent id + release-heal + sub path allowlist — **HOLD** on tip at cook.

## Engine A — residual disposition

| Prio | Unit                                | Disposition                                                                      |
| ---- | ----------------------------------- | -------------------------------------------------------------------------------- |
| A0   | Open pay PR merge                   | empty at start                                                                   |
| A1   | public refund residual under tip    | **sealed** #1507 holds                                                           |
| A1   | reverse-refund / settle-release     | **sealed** #1527 holds                                                           |
| A1   | same refundId amount bind           | **done** #1560 `pay.refund_id_conflict`                                          |
| A1   | empty/whitespace body refundId      | **done** #1560 → `restRefundId`                                                  |
| A1   | subscription path honesty           | **sealed** #1527 allowlist + fire only crypto_invoice                            |
| A2   | pre-charge notify hook              | **park** honest-absent pin #1380                                                 |
| A2   | KYB/dispute/chargeback pins         | **hold** pins                                                                    |
| A2   | public door promise-falsify         | **done** #1560 ADR full-only capture + README rail refundId + hermetic rest pins |
| A3   | chargeback wire / grants / acquirer | **park** Nitro Class X                                                           |
| A3   | Engine B pass                       | this stop                                                                        |

## Engine B — chapter pass

| Claim                                              | Verdict                    |
| -------------------------------------------------- | -------------------------- |
| Public refund retry not two refunds                | Holds (#1507)              |
| Explicit refundId after reverse not free rail      | Holds (#1527)              |
| Same refundId different amount not silent success  | Holds (#1560)              |
| Empty refundId not weak ledger key                 | Holds (#1560)              |
| Settle re-run / release after lag no double credit | Holds (#1430 + #1527)      |
| Subscriptions invoice-and-watch, no auto-pull      | Holds                      |
| card_mandate silent crypto invent                  | Closed (#1527)             |
| Pre-charge notify before charge                    | Absent by honesty pin      |
| Partial capture "built"                            | Doc lie closed (#1560 ADR) |
| KYB gates money                                    | True-as-gap pin            |
| Chargebacks move money                             | Unwired; Class X           |

## Engine C — attack surface

| Surface                         | Status               |
| ------------------------------- | -------------------- |
| Double refund (public)          | Sealed #1507         |
| Double refund (reverse+same id) | Sealed #1527         |
| Same id amount desync           | Sealed #1560         |
| Empty id collision              | Sealed #1560         |
| Double settle / release lag     | Sealed #1430 + #1527 |
| Auto-pull                       | No invent            |
| Grant invent                    | Nitro §8 park        |

## Pick-up next cook (only if Nitro opens a gate)

1. KYB money-gate product law → refuse matrix (breaks #1438 pin deliberately)
2. Pre-charge `subscription.invoice_upcoming` on merchant webhook journal (no NATS invent)
3. Chargeback wire after Nitro Class M/X content
4. Dunning ladder after product law
5. Optional: require `refundId` on tRPC (product/law — internal surface today)

## Denon fence

No invent-risk PSP product-complete. Did not dual-edit Shehzad #1177. Dependabot HOLDs babysit only.
