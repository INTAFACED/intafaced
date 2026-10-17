# LANE STOP — L07 MARKET · wave 6 · 2026-08-09

**Lane wall:** `services/svc-market/**`  
**Tip at write:** `c9c9c453` (re-derive).  
**SAFE TO CLOSE:** **yes** for residual craft on this wall — C1+C2 Class M **merged**; only Nitro product law remains parked.

---

## Shipped this wave

| Unit                             | Proof                                                                                                | Class |
| -------------------------------- | ---------------------------------------------------------------------------------------------------- | ----- |
| **#1189** commerce C1+C2 Class M | **MERGED** `44b9bb23` — listings + one-time purchase + blank commission refuse                       | **M** |
| Rebase babysit                   | Tip pay `0xg4finish` already fixed; rebase cleared monorepo Tests red (was sibling, not market)      | N     |
| Concurrent create wrap           | `commerce.test.ts` 6 concurrent creates @ capacity 2 → 2 ok / 4 `slots_exhausted` / no orphan active | P     |
| Commission conservation dust     | `market.test.ts` price×bps table: debit sum == price always                                          | **M** |
| Scopes + edge residual           | mount: anonymous purchase refuse; buyer always edge principal; archive needs write                   | P     |
| Public refuse matrix             | + `listing_not_owned` → CONFLICT; named codes stable                                                 | P     |
| Catalogue order honesty          | public listings `created_at ASC` (registration order; not newest-first invent)                       | N     |
| Closed stale **#1401**           | W4 stop claimed commerce green while #1189 open — closed; superseded by #1387 W5 + this W6           | N     |
| Tracker mountain                 | `market.commerce` → `done` (C3 residual named)                                                       | N     |

## In flight

- none on L07 wall (docs stop PR is this commit)

## Parked (+ why)

| Unit                        | Why                                                                                                            |
| --------------------------- | -------------------------------------------------------------------------------------------------------------- |
| C3 subscriptions product    | No period / past-due / cancel / access law — inventing is product authorship                                   |
| Ranking / featured          | DIRECTION §8 Nitro-only; directory + catalogue stay registration order                                         |
| Commission **bps value**    | Mechanism refuse-closed; number is Nitro (`MARKET_HOUSE_COMMISSION_BPS`)                                       |
| Crash-orphan GC             | Active listing without slot is not buyable (`listing_slot_missing`); myListings litter only — optional cleanup |
| Stake outage message detail | Fail-closed typed; internal status may appear in 500 message — soft residual, not free path                    |

## Engine A card tally (≥8)

| Prio | Unit                        | Disposition                                        |
| ---- | --------------------------- | -------------------------------------------------- |
| A0   | Commerce Class M            | **MERGED #1189**                                   |
| A1   | one-time + blank commission | **Shipped** #1189                                  |
| A1   | listings honesty            | **Shipped** #1189 (+ W6 concurrent/order residual) |
| A1   | stake-gate                  | **Sealed tip** (vendors) + commerce re-check       |
| A2   | concurrent create wrap      | **Shipped** W6 RED on #1189                        |
| A2   | commission conservation     | **Shipped** recipe + dust table                    |
| A2   | public refuse codes         | **Shipped** mount matrix                           |
| A2   | scopes + edge               | **Shipped** tip + W6 pins                          |
| A3   | eligibility computed        | **Sealed tip** + over-capacity commerce            |
| A3   | subscriptions               | **PARK** product law                               |
| A3   | ranking DIRECTION 8         | **PARK** Nitro                                     |
| A3   | Engine B chapter pass       | **This note**                                      |

## Engine B — promise chapter

| Promise                           | Verdict                                   |
| --------------------------------- | ----------------------------------------- |
| README vendors 1–3                | **SHIPPED tip**                           |
| Listings + one-time + commission  | **SHIPPED tip** (#1189)                   |
| Blank commission refuse           | **SHIPPED** — never invent free           |
| Crash re-drive / snapshot         | **SHIPPED**                               |
| Over-held listing prune           | **SHIPPED**                               |
| Concurrent create cannot oversell | **SHIPPED** (W6)                          |
| Catalogue boring order            | **SHIPPED** ASC (W6)                      |
| Subscriptions                     | **PARK** refuse + catalogue hide          |
| Ranking                           | **PARK** registration order               |
| TRK / tracker honesty             | **Updated** commerce `done` + C3 residual |

## Engine C — attack surface

| Surface                          | Status                                    |
| -------------------------------- | ----------------------------------------- |
| Stake forge                      | Closed (token path only)                  |
| Commission zero invent           | Closed (blank refuse)                     |
| Double listing / concurrent slot | Closed (FOR UPDATE + create wrap RED)     |
| Self-asserted vendor / buyer     | Closed (principal-only)                   |
| Buy after delist                 | Closed (archive + re-check)               |
| Subscription without law         | Closed as refuse                          |
| Ranking invent                   | Closed as non-rank                        |
| Class M replay mid commerce      | Closed (idempotent purchaseId + snapshot) |

## Nitro must decide

1. **House commission bps** (`MARKET_HOUSE_COMMISSION_BPS`) — the rate itself.
2. **Subscription product law** before C3 craft (period / past-due / cancel / access).
3. **Ranking / featured** (or keep registration order forever).

## Pick-up (next agent)

1. Ops: set commission bps when ready to sell; without it purchases refuse closed.
2. Do **not** invent subscription / ranking / bps value.
3. Optional: crash-orphan GC job for active listings without slots (not buyable today).
4. Re-derive tip; local Postgres commerce suite needs Docker when proving money path offline.

---

```
LANE: L07 MARKET wave 6
shipped: #1189 commerce C1+C2 Class M (merged) · concurrent create wrap · commission dust table · edge principal pins · refuse matrix · catalogue ASC · closed #1401 · tracker commerce done
in flight: none
parked: C3 subscriptions (no product law) · ranking DIRECTION 8 · commission bps value · optional orphan GC
Nitro must decide: commission bps · subscription past-due/cancel law · ranking or keep registration order
SAFE TO CLOSE: yes
tip: c9c9c453
```
