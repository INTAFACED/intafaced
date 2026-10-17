# LANE STOP — L01 PAY · wave 10 · 2026-08-09

```
LANE: L01 PAY wave 10 product-velocity
shipped: #1580 mandate cancel + cascade (stop charging now) · #1585 subscription firing history list · seals re-verified #1507/#1527/#1560 hold
in flight: none
parked: chargeback wire + content (Nitro Class M/X) · pay:* grants / fee tables / acquirer Class X · pre-charge real notify · dunning ladder · KYB money-gate product · card mandate rail invent · full PSP/PayFac product-complete (Denon) · pay.plugins Woo/Magento/OpenCart invent (reclassify: TS reference client or §13 only) · smart routing geo/risk/approval rates (Nitro §8 — refuse invent)
Nitro must decide: pay:* grant path · chargeback wire · fee/acquirer Class X · open plugins as TS client vs §13 — or none this wave
SAFE TO CLOSE: yes — product residual-empty under agent fences; only Nitro-only / L6–L7 parks left
tip: df3d57c6
```

## A0 — open pay PR bank

| PR    | Result                                                |
| ----- | ----------------------------------------------------- |
| none  | empty at cook start                                   |
| #1580 | **merged** — mandate cancel + cascade + tracker claim |
| #1585 | **merged** — `subscription.listExecutions`            |

Sealed re-verify (do not re-ship): #1507 public refund double · #1527 reverse-refund + path allowlist · #1560 refundId amount bind — **HOLD** on tip.

## Engine A — residual disposition

| Prio | Unit                            | Disposition                                                                           |
| ---- | ------------------------------- | ------------------------------------------------------------------------------------- |
| A0   | Open pay PR merge               | empty bank                                                                            |
| A1   | subscriptions mandate lifecycle | **done** #1580 cancel + cascade; create/get/cancel sub already on tip                 |
| A1   | subscription firing visibility  | **done** #1585 listExecutions                                                         |
| A1   | public-api ADR §4               | **already complete** on tip (REST+webhooks+sandbox+quickstart)                        |
| A1   | routing                         | **already complete** for honest preference + no invent pin (#1527 path + #1374 rates) |
| A2   | settlement                      | **crypto settle+payout on tip**; bank-payout absent (socket)                          |
| A2   | gateway crypto                  | **hosted checkout + links on tip**; KYB money-gate park                               |
| A2   | fraud mechanism                 | chargeback recipes unwired (Class M/X park); scoring content Class X                  |
| A2   | plugins                         | **park** — no SPEC done bar; not three PHP plugins                                    |
| A3   | refund honesty residual         | seals hold — no re-cook                                                               |
| A3   | Engine B pass                   | this stop                                                                             |

## Engine B — promise falsification (tip)

| Claim                               | Verdict                                             |
| ----------------------------------- | --------------------------------------------------- |
| Mandate cancel immediate            | Holds (#1580)                                       |
| Sub cancel immediate                | Holds (prior #1367)                                 |
| Card path no silent crypto invent   | Holds (#1527 normalise + fire `!== crypto_invoice`) |
| Merchant can see firings            | Holds (#1585)                                       |
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
5. `pay.plugins` reclassify: one TS reference client **or** §13 socket (not Woo/Magento packages)

## Denon fence

No invent-risk PSP product-complete. Did not dual-edit Shehzad #1177.
