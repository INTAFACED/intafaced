# LANE STOP — L07 MARKET · wave 4 · 2026-08-09

**Lane wall:** `services/svc-market/**`  
**Tip at write:** re-derive (`git fetch && git log -1 --oneline origin/main`).  
**SAFE TO CLOSE:** **no** until #1189 merges green (Class M). #1276 TRK honesty **merged**.

---

## Shipped this wave

| Unit                            | Proof                                                                                                                     | Class |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----- |
| **#1276** TRK pack honesty      | **MERGED** `071f1c17` — vendors pack + commerce pack no longer claim “no svc-market”                                      | N     |
| **#1189** market.commerce C1+C2 | **OPEN** — listings + one-time purchase + blank commission refuse + listing↔slot integrity + Class M tests + README truth | **M** |
| A2 scopes+edge                  | **Sealed on tip** — `market:read/write/ops` real; `/api/market` in edge UPSTREAMS                                         | —     |
| A3 ranking                      | **PARK** — DIRECTION §8; directory is registration order only                                                             | —     |
| A2 subscriptions                | **PARK** — `market.subscription_not_built`; needs product law (period/past-due/cancel)                                    | —     |
| A3 oversell regression          | **Sealed on tip** — `vendor-slots.test.ts` concurrent claim proof                                                         | —     |
| A3 eligibility computed         | **Sealed** — no `is_listed`; re-read on catalogue/purchase                                                                | —     |

### #1189 load-bearing fixes (on PR branch)

1. **Create gate** — approved + `claimSlot`, not `listingEligibility` (fixed first-listing `market.slot_required` CI red).
2. **Listing↔slot** — purchase/catalogue require open slot `ref = listingId` (crash orphan cannot sell).
3. **Class M tests** — insufficient funds, suspended, orphan; recipe 6/6; commerce 14/14 green in CI log.
4. **Mount scopes** — `market:write` on create/purchase.
5. **README** — removed vendors-only lies (no listings / no ledger).

### CI note

Monorepo **Tests** once failed on **svc-ws** flake (`detaches the subscription when the socket closes`) — **not** market. Commerce suite was green. Rebased + re-pushed for fresh run.

---

## Engine B — promise falsification (chapter)

| Promise                                   | Verdict                         |
| ----------------------------------------- | ------------------------------- |
| Vendors apply → vet                       | **SHIPPED** tip (#1109+)        |
| Stake slots + oversell                    | **SHIPPED** tip (#1115+)        |
| Public eligibility / no `is_listed`       | **SHIPPED** tip (#1126+)        |
| Listings + one-time purchase + commission | **#1189** (not tip until merge) |
| Subscriptions                             | **PARK** — product law missing  |
| Ranking / featured                        | **PARK** — DIRECTION §8         |
| Scopes real                               | **SHIPPED** tip                 |
| TRK “no svc-market”                       | **Falsified** — #1276           |

---

## Engine C — attack surface residual

| Surface                  | Status                                                               |
| ------------------------ | -------------------------------------------------------------------- |
| Stake unavailable        | Fail closed (throw / drop from catalogue)                            |
| Commission conservation  | Recipe floor + sum invariant tests                                   |
| Blank commission         | `market.commission_not_configured` pre-claim                         |
| Public refuse codes      | Named (`slot_required`, `stake_required`, `listing_slot_missing`, …) |
| Concurrent createListing | Slot layer proven; wrap residual optional                            |

---

## In flight

- **#1189** — babysit CI → Class M already in PR body → merge when green.

## Parked (+ why)

| Unit                     | Why                                                                                                            |
| ------------------------ | -------------------------------------------------------------------------------------------------------------- |
| C3 subscriptions         | No product law (period, past-due, cancel, access cut) — inventing would be Class X-adjacent product authorship |
| Ranking / featured       | DIRECTION §8 Nitro-only                                                                                        |
| Commission bps **value** | Mechanism refuse-closed; number is Nitro                                                                       |
| C4 premium / admin views | After C2 on tip; ranking half owner-gated                                                                      |
| Purchase NATS events     | Optional; no consumer                                                                                          |

## Nitro must decide

1. **House commission bps** (`MARKET_HOUSE_COMMISSION_BPS`) — rate itself.
2. **Subscription product law** before C3 craft.
3. **Ranking / featured placement** (or keep registration order forever).

## Pick-up for next agent (if #1189 still open)

1. `gh pr view 1189` — if Tests red only on `svc-ws` flake, `gh run rerun --failed`.
2. Merge Class M when green.
3. Tracker: `market.commerce` → `done` for C1+C2 (note C3 residual in note) + `pnpm tracker`.
4. Write final SAFE TO CLOSE only after merge + tracker honesty.

---

```
LANE: L07 MARKET wave 4
shipped: #1276 TRK honesty (vendors/commerce packs not greenfield)
in flight: #1189 listings + one-time purchase + house commission refuse blank rate (Class M)
parked: C3 subscriptions (no product law) · ranking DIRECTION 8 · commission bps value
Nitro must decide: commission bps · subscription past-due/cancel law · ranking or keep registration order
SAFE TO CLOSE: no
tip: re-derive
```
