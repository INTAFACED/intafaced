# TRK-p2p.merchants — research / spec pack

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Tracker id:** `p2p.merchants`  
**Title:** P2P merchant programme — badges, limits, API  
**Module / phase:** `p2p` · phase **3** · plane **custodial P2P**  
**Status on tip:** `ready` · **owner:** none  
**Depends on:** `p2p.reputation`  
**Tip freeze:** `origin/main` @ `56696496` (re-derive before implement)  
**Pack type:** research only — no invent escrow money; no dual-edit open Denon p2p PRs (#428 instruments); no `features.mjs` edit.

---

## 1 · What “done” means (plain language)

1. A **merchant programme** exists as product law: tiers or packages that raise limits / unlock API beyond organic reputation badges alone.
2. Badges remain **derived** from counters (never a permanent grant table that can lie after behaviour degrades).
3. Raised limits and API access are **checkable** against the same reputation snapshot the UI shows — no silent second scorecard.
4. Operator freeze / programme revoke paths exist without inventing escrow recipes outside ledger.
5. Tracker title’s full promise (badges + limits + API) is true in a real env — not a stub route.

---

## 2 · Current code state (tip)

### 2.1 Service spine

| Area             | Path                               | Role                                   |
| ---------------- | ---------------------------------- | -------------------------------------- |
| Service          | `services/svc-p2p`                 | Offers, trades, disputes, reputation   |
| Reputation pure  | `src/reputation.ts`                | Counters → rates → **badges** (no I/O) |
| Reputation tests | `src/reputation.test.ts`           | Badge thresholds + outcome application |
| HTTP             | `GET /internal/reputation/:userId` | Snapshot + badges array                |
| Schema           | `db/schema.ts` `p2p_reputation`    | Durable counters + badges array column |

Money for escrow remains **ledger-only** via `ledger-client` (do not invent recipes here).

### 2.2 Badge rules on tip (derived, auto-revoke)

From `BADGE_RULES` in `reputation.ts`:

| id             | Rule (checkable)                                     |
| -------------- | ---------------------------------------------------- |
| `first-trade`  | `completed >= 1`                                     |
| `reliable`     | `completed >= 10` and `completionRate >= 0.95`       |
| `fast-release` | `releaseSamples >= 10` and avg release ≤ 300s        |
| `spotless`     | `completed >= 50`, rate ≥ 0.98, `disputesLost === 0` |

Comments in code: badges recomputed every update so revoke is automatic; `spotless` is the hard bar rank-perks raise limits off.

### 2.3 What is **not** the merchant programme yet

| Gap              | Reality                                                                                                                 |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Programme entity | No separate “merchant application / KYC tier / API key” product table                                                   |
| Limits packaging | Rank-perk mapping to raised P2P limits is referenced in comments; full programme packaging residual                     |
| Merchant API     | Beyond internal reputation GET — public merchant API residual                                                           |
| Open money PR    | Denon **#428** p2p payment instruments — **MERGEABLE but red** (Prettier + Typecheck) — path-check before any p2p craft |

### 2.4 Related tracker

- `p2p.reputation` — spine shipped; this row **depends on** it and packages programme on top.
- Open instruments work is **partner-owned** until #428 lands or closes.

---

## 3 · Doctrine constraints

| Law           | Implication                                                               |
| ------------- | ------------------------------------------------------------------------- |
| Escrow money  | Only via `packages/ledger-client` recipes                                 |
| Badge honesty | Derived rules only; no permanent “granted forever” flag without recompute |
| No dual-edit  | Path-intersect Denon #428 (and any open p2p) before implement             |
| Class X       | Sanctions / KYC **content** for merchant onboarding is human/counsel      |

---

## 4 · DoD sketch (checkable — staged)

### Slice A — programme law (docs + types)

- [ ] Written tier table: organic badges vs programme tiers
- [ ] Which badge(s) gate which limit (spotless etc.) — single source
- [ ] Explicit non-goal: inventing volume metrics without trades

### Slice B — limits enforcement

- [ ] Limit raise applied where offers/trades enforce max size
- [ ] Tests: lose spotless → limit falls without manual revoke row
- [ ] No second shadow scorecard

### Slice C — API (if title requires)

- [ ] Authenticated merchant API surface with rate limits
- [ ] Keys revocable; no world-open write

### Tracker `done` bar

Flip only when badges + limits + API (as titled) work in a real env with ledger escrow honesty intact.

---

## 5 · Open questions

1. Same reputation table vs separate programme membership entity?
2. KYC tier gate for API keys (Class X content adjacent)?
3. Does programme require Shehzad pay rails (#346) or is pure crypto P2P enough for v1?

---

## 6 · Estimated size

| Slice                          | Size    |
| ------------------------------ | ------- |
| Law + limit map + tests        | **S–M** |
| Full merchant API + ops freeze | **M–L** |

---

## 7 · Related docs / code

- `services/svc-p2p/src/reputation.ts` · `reputation.test.ts`
- `services/svc-p2p/src/db/schema.ts` (`p2p_reputation`)
- `services/svc-p2p/src/index.ts` internal reputation route
- Long-form twin: [TRK-p2p.merchants.md](./TRK-p2p.merchants.md)

---

## 8 · Explicit non-goals for this pack

- No inventing escrow ledger recipes.
- No fake merchant badges or hardcoded leaderboard rows.
- No dual-edit of Denon #428 file set.
- No implement swarm from this research pack alone.
