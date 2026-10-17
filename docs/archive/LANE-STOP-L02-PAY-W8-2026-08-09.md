# LANE STOP — L02 PAY · wave 8 · 2026-08-09

```
LANE: L02 PAY wave 8
shipped: #1507 public refund double (tip at cook start) · #1527 reverse-refund reuse refuse + settle-release heal + sub path/fire honesty
in flight: none
parked: chargeback wire + content (Nitro Class M/X) · pay:* grants / fee tables / acquirer Class X · pre-charge real notify hook · dunning ladder · KYB money-gate product (honesty pin holds) · card mandate rail invent
Nitro must decide: pay:* grant path · chargeback wire · fee/acquirer Class X — or none this wave
SAFE TO CLOSE: yes — residual-empty honesty (only Nitro-only / L6–L7 parks left)
tip: df1f03de
```

## A0 — open pay PR bank

| PR                                | Title                                               | Result                |
| --------------------------------- | --------------------------------------------------- | --------------------- |
| (none open on wall at cook start) | —                                                   | empty bank            |
| #1527                             | reverse-refund / settle-release / sub path residual | **merged** `df1f03de` |

Sealed re-verify (do not re-ship): #1507 public refund double — tip at start.

## Engine A — residual disposition

| Prio | Unit                                  | Disposition                                                                    |
| ---- | ------------------------------------- | ------------------------------------------------------------------------------ |
| A0   | Open pay PR merge                     | **empty** at start                                                             |
| A1   | public refund idempotency             | **sealed** #1507 — re-verified                                                 |
| A1   | same refundId after reverse free-rail | **done** #1527 — `pay.refund_id_spent`                                         |
| A1   | settle re-run / double credit         | **sealed** #1430; release-after-lag heal **done** #1527                        |
| A1   | subscription honesty                  | path allowlist + fire reuse **done** #1527; pre-notify pin holds; no auto-pull |
| A2   | KYB / dispute / chargeback pins       | **hold** pins (#1438 / #1366)                                                  |
| A2   | mandate residual                      | no invent rail — card refuse + path allowlist                                  |
| A2   | public door promise-falsify           | #1507 + spent-id residual closed                                               |
| A3   | chargeback wire / pay grants          | **park** Nitro Class X                                                         |

## Engine B — chapter pass (tip `df1f03de`)

| Claim                                         | Verdict                                         |
| --------------------------------------------- | ----------------------------------------------- |
| Public refund retry not two refunds           | Holds (#1507)                                   |
| Explicit refundId after reverse not free rail | Holds (#1527 `pay.refund_id_spent`)             |
| Settle re-run no double credit                | Holds (#1430)                                   |
| Ops release after dual-book lag               | Heals (#1527) — does not free for second credit |
| Subscriptions invoice-and-watch, no auto-pull | Holds                                           |
| Unknown / card_mandate path silent crypto     | Closed (#1527 allowlist + fire refuse)          |
| Pre-charge notify before charge               | Absent by honesty pin                           |
| KYB gates money                               | True-as-gap pin                                 |
| Disputes / chargebacks move money             | Unwired pins; Class X                           |

## Engine C — attack surface

| Surface                         | Status                    |
| ------------------------------- | ------------------------- |
| Double refund (public)          | Sealed #1507              |
| Double refund (reverse+same id) | Sealed #1527              |
| Double settle / release lag     | Sealed #1430 + #1527 heal |
| Auto-pull                       | No invent                 |
| Path invent → crypto open       | Closed #1527              |
| Grant invent                    | Nitro §8 park             |

## Thrift note

Hard thrift at cook. One fat Class M residual PR with `THRIFT_ALLOW=1`. Docs stop is docs-only.

## Pick-up next cook (only if Nitro opens a gate)

1. KYB money-gate product law → refuse matrix (breaks #1438 pin deliberately)
2. Pre-charge `subscription.invoice_upcoming` on merchant webhook journal
3. Chargeback wire after Nitro Class M/X content
4. Dunning ladder after product law

## Denon fence

Did not dual-edit #1502 empty-denominator or #1494 support desk. No invent-risk PSP product-complete.
