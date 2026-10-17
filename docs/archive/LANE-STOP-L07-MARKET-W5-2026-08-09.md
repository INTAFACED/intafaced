# LANE STOP — L07 MARKET · wave 5 · 2026-08-09

**Lane wall:** `services/svc-market/**`  
**Tip at write:** `8f193a8e` (re-derive).  
**SAFE TO CLOSE:** **no** — Class M commerce still on open **#1189**; monorepo Tests red on **sibling** suites (pay G4 fixture + agents fleet matrix), not on market package logic.

---

## Shipped this wave (on #1189 branch unless noted)

| Unit                                       | Proof                                                                                                       | Class   |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | ------- |
| **#1311** W4 stop banked                   | **MERGED**                                                                                                  | N       |
| **#1276** TRK honesty (W4)                 | **MERGED** earlier                                                                                          | N       |
| Registry count = 50 after `marketPurchase` | #1189 `packages/ledger-client/.../registry.test.ts`                                                         | N       |
| Class M re-drive                           | pending-only settle; post from claim snapshot; pre-post eligibility re-check; RED crash/bps/insufficient-id | **M**   |
| Listings honesty                           | archive slot release; capacity exhaust no orphan; hide `subscription` from public catalogue                 | P       |
| Over-capacity prune                        | `entitledListingRefs` oldest-first; catalogue + purchase refuse `market.listing_over_capacity`              | **M**/P |
| mapError commerce codes                    | PRECONDITION / CONFLICT / NOT_FOUND; mount RED matrix                                                       | P       |
| #1100 honesty                              | comments/README no longer claim unmerged always-500                                                         | N       |
| Local non-PG market suite                  | 56 pass + mount 31 (Postgres suites skip without Docker)                                                    | —       |

## In flight

- **#1189** — listings + one-time purchase + house commission refuse blank rate + W5 Class M residual above.
  - **Merge blocked:** monorepo Tests fail-fast on **svc-pay** (`0xg4finish` invalid EVM fixture — sibling **#1314**) and/or **svc-agents** fleet matrix (`merchant` still asserted unmounted after #1284).
  - Ledger `market.test` + registry green in CI logs before fail-fast.
  - Class M self-audit + adversarial comment on PR.

## Parked (+ why)

| Unit                            | Why                                                                      |
| ------------------------------- | ------------------------------------------------------------------------ |
| C3 subscriptions product        | No period/past-due/cancel/access law — inventing is product authorship   |
| Ranking / featured              | DIRECTION §8 Nitro-only; directory stays registration order              |
| Commission **bps value**        | Mechanism refuse-closed; number is Nitro (`MARKET_HOUSE_COMMISSION_BPS`) |
| Concurrent createListing wrap   | Slot layer proven; optional wrap residual                                |
| Purchase NATS events            | No consumer; wiring gate reds orphan subjects                            |
| Pay G4 / agents matrix tip reds | **Sibling walls** L04 / L01 — L07 does not dual-write                    |

## Engine A card tally (≥8)

| Prio | Unit                        | Disposition                                   |
| ---- | --------------------------- | --------------------------------------------- |
| A0   | Babysit commerce Class M    | **In flight** #1189 (CI sibling block)        |
| A1   | one-time + blank commission | **On #1189** (mechanism + REDs)               |
| A1   | listings honesty residual   | **On #1189** (sub hide, archive, exhaust)     |
| A2   | subscriptions               | **PARK** product law                          |
| A2   | scopes+edge                 | **Sealed tip** (W4)                           |
| A2   | eligibility computed        | **Sealed tip** + over-capacity prune on #1189 |
| A3   | ranking                     | **PARK** DIRECTION 8                          |
| A3   | commission bps value        | **PARK** Nitro                                |
| A3   | oversell/stake regression   | **Sealed tip** + over-capacity commerce       |
| A3   | README matrix               | **On #1189** (C1+C2 truth + re-drive + prune) |

## Engine B — promise chapter (summary)

| Promise                          | Verdict                                              |
| -------------------------------- | ---------------------------------------------------- |
| Vendors 1–3                      | **SHIPPED tip**                                      |
| Listings + one-time + commission | **#1189** not tip until merge                        |
| Blank commission refuse          | **On #1189**                                         |
| Crash re-drive / snapshot        | **On #1189**                                         |
| Over-held listing prune          | **On #1189**                                         |
| Subscriptions                    | **PARK** (storable; catalogue hide; purchase refuse) |
| Ranking                          | **PARK** registration order                          |
| TRK no-svc-market lie            | **Falsified** #1276                                  |

## Engine C — attack surface residual

| Surface                 | Status                  |
| ----------------------- | ----------------------- |
| Stake unavailable       | Fail closed (tip)       |
| Commission conservation | Recipe floor + sum REDs |
| Blank commission        | Pre-claim refuse        |
| Orphan listing          | `listing_slot_missing`  |
| Over-held after unstake | `listing_over_capacity` |
| Public refuse codes     | Named + mount map       |

## Nitro must decide

1. **House commission bps** (`MARKET_HOUSE_COMMISSION_BPS`) — the rate itself.
2. **Subscription product law** before C3 craft.
3. **Ranking / featured** (or keep registration order forever).

## Pick-up (next agent)

1. `gh pr checks 1189` — when monorepo Tests green (after L01 agents matrix + L04 #1314 or tip equivalent), **merge Class M**.
2. Tracker: `market.commerce` → `done` for C1+C2; note C3 residual; `pnpm tracker`.
3. Re-derive tip; re-run commerce Postgres suites in CI (local Docker was down this session).
4. Do **not** invent commission bps / ranking / subscription law.

---

```
LANE: L07 MARKET wave 5
shipped: #1311 W4 stop · #1189 branch Class M residual (registry 50, re-drive, over-capacity, catalogue honesty, mapError, #1100 docs)
in flight: #1189 commerce C1+C2 Class M (CI blocked by sibling pay G4 + agents matrix — not market)
parked: C3 subscriptions (no product law) · ranking DIRECTION 8 · commission bps value · concurrent create wrap
Nitro must decide: commission bps · subscription past-due/cancel law · ranking or keep registration order
SAFE TO CLOSE: no
tip: 8f193a8e
```
