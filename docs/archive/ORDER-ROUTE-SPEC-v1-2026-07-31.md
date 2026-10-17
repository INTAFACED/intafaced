> **Supersession (2026-08-09):** Any line that treats **Actions thrift**, run-count caps, `THRIFT_ALLOW`, or holding PRs for CI spend as current law is **void**. The repo is public; thrift was deleted 2026-08-07. See [`GITHUB-CI-SPEND-CONTROL-2026-07-31.md`](GITHUB-CI-SPEND-CONTROL-2026-07-31.md). Historical text below may still _mention_ thrift as what was once believed.

# SPEC v1 — Order-route / DEX–CEX money-path harden

**Status:** SPEC STANDS · contract for Build  
**Date:** 2026-07-31  
**Phase:** Rung 2 complete → Architect + Plan done → **Build starts at Plan P0→P1-1**  
**Parents:**

- Frame + method: `docs/ORDER-ROUTE-FRAME-AND-PLANNING-METHODOLOGY-2026-07-31.md`
- **Tools/workflows landscape:** `docs/ORDER-ROUTE-TOOLS-WORKFLOWS-LANDSCAPE-v2-2026-07-31.md` (Tier A mandatory in Plan; last30days + star map)
- Domain inventory: `docs/ORDER-ROUTE-HARDEN-PROGRAM-2026-07-31.md`
- Law: doctrine · agent protocol · ownership · Denon DIRECTION (#272)

**How to use:** Every Build task must map to at least one **REQ-ID** below. Verify proves REQs. No REQ → out of scope or needs Spec amend.

**Altitude rule:** This is **what must be true** (checkable). It is **not** the implementation plan (task order / files). Plan = next rung after Architect notes on open seams.

---

## 0 · Phase map (for Nitro — what you’re looking at)

| Phase           | Artifact                            | You look for                                              | Done when                                              |
| --------------- | ----------------------------------- | --------------------------------------------------------- | ------------------------------------------------------ |
| **1 Frame**     | Methodology + outcome               | What / why / done-outcome / how we run                    | Working (this program)                                 |
| **2 Spec**      | **This file**                       | Checkable REQs — security, money, failure, out-of-scope   | Adversarial pass + no holes on named board             |
| **3 Architect** | Mini design notes (only hard seams) | 2–3 options + pick + failure modes                        | Seams decided for dual-book, chaos harness, seed model |
| **4 Plan**      | Task graph (decompose)              | Ordered pieces, each with a check, walking skeleton first | Complete vs Spec (every REQ has a task)                |
| **5 Build**     | PRs / worktrees                     | One concern, TDD money paths                              | Code exists                                            |
| **6 Verify**    | Fresh agent evidence                | Tests + assembled path green                              | Proof you can see (links/output)                       |
| **7 Review**    | Fresh agent                         | Money / security / bloat                                  | Issues fixed or accepted trade-off                     |
| **8 Ship**      | Merge                               | CI + Class matrix                                         | On main                                                |
| **9 Operate**   | Scoreboard / WAVE-AUDIT             | Green-red axes; go-live still human                       | Living                                                 |

**Spec vs Plan (one line):**  
**Spec** = _what must be true and how we know._  
**Plan** = _in what order, which files, which tests first, which PR cuts._  
You are looking at **Spec now**. Plan comes after Spec stands + Architect for ambiguous seams.

---

## 1 · Problem statement (Spec altitude)

INTAFACED’s spot CEX order path and DEX quote plane exist and are partially strong. They are **not** yet proven “stable under real-money conditions” because:

1. A second book can still exist in vendored Java money surfaces (dual-book not enforced).
2. Failure/recovery paths between trade ↔ matching ↔ ledger ↔ bus are not fully proven as an **assembled** system under chaos.
3. DEX can quote honestly but must never invent execute/fills; residual quote integrity still has holes (rate-limit, audit fields).
4. Market depth for real trading surfaces needs seed/mm with **honesty**, without futures-first product invent.
5. Go-live remains human; agents must not claim it.

**Success:** Denon (and Nitro) can trust a **readiness scoreboard** that the above are closed or explicitly residual with proof.

---

## 2 · Actors & planes

| Actor                     | Plane                     | Allowed money motion                                            |
| ------------------------- | ------------------------- | --------------------------------------------------------------- |
| User via trade:write      | Fiat / CEX (`svc-trade`)  | Hold / fill / release via ledger recipes only                   |
| Matching engine           | None (no balances)        | Match funded orders only                                        |
| DEX quote caller          | Protocol                  | Quotes only; no platform custody of user funds on protocol path |
| Seed/mm bot               | Fiat book                 | Seeded orders flagged; kill-switchable                          |
| Java vendored controllers | Must not be a second book | Disabled at door / mutators banned                              |

---

## 3 · Global constraints (every REQ inherits these)

| ID        | Constraint                                                                                                                                                                                                                                                     |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **GC-1**  | Money only via `packages/ledger-client` recipes; no balances outside ledger; no money as JS `number` on wire/storage of value.                                                                                                                                 |
| **GC-2**  | No vendor/partner names in user-facing copy (brand-scan).                                                                                                                                                                                                      |
| **GC-3**  | Class M merge: green CI + self-audit + adversarial; **carve-outs stay Denon** — external value out, scope grants, **new/changed ledger recipes**, posture/kill/custody scan changes.                                                                           |
| **GC-4**  | Denon §8 never agent-closed: go-live, secrets, prod RPC, listing policy, fee recipes invent, sanctions content, leverage params beyond defaults, “audited/insured” claims.                                                                                     |
| **GC-5**  | Engine product order: **seed/mm → multi-asset → futures → OTC → TWAP**. Futures engine not started as a program mountain until seed + multi-asset bars in this Spec. Futures **recipes** already on main are OK; **engine MVP** is not this Spec’s early path. |
| **GC-6**  | Worktree only; never main checkout; one concern per PR; `pnpm verify` real; local green before push (Actions thrift deleted 2026-08-07).                                                                                                                       |
| **GC-7**  | Builder never grades own work — Verify/Review fresh session or fresh agent.                                                                                                                                                                                    |
| **GC-8**  | Stream A shell craft: coordinate LIVE-LANES; do not steal Wave A UI PRs for unrelated polish.                                                                                                                                                                  |
| **GC-9**  | Tracker honesty: never `done` without reachable + tested + unpropped.                                                                                                                                                                                          |
| **GC-10** | Live git wins over any frozen SHA in docs.                                                                                                                                                                                                                     |

---

## 4 · Requirements (checkable)

### 4.1 Dual-book (Option B)

| REQ      | Requirement                                                                                                                               | Acceptance (how we know)                                                                                                                    | Class       |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| **DB-1** | `ledger.*` is the only balance of record for platform money.                                                                              | Written enforcement: no live write path to `member_wallet` (or equivalent) from money controllers; ADR dual-book **Accepted** on main.      | M / posture |
| **DB-2** | All vendored money controllers that mutate balances are **disabled at the door** (unreachable), not merely unused.                        | Attempted call path returns refuse/disabled; inventory of controllers listed in PR body; count ≥ Denon’s “25” class or current audit count. | M / posture |
| **DB-3** | Four DAO mutators (`increaseBalance`, `decreaseBalance`, `freezeBalance`, `thawBalance` or exact Java names) are **hard-banned by scan**. | `vendor-shell-scan` fails CI if patterns reappear.                                                                                          | P/M         |
| **DB-4** | `custody-scan` (or successor) **reads Java** under vendor money paths, not only TS.                                                       | Scan reports Java files scanned; fails on forbidden balance mutators / ledger bypass.                                                       | P           |
| **DB-5** | Projection (if any) of balances into shell tables is **read-only** from ledger truth — never reverse.                                     | Doc + test or scan proof; no write recipe from Java into ledger invent.                                                                     | M           |

### 4.2 CEX order route (spot) — behavior already partly true; Spec forces residual proof

| REQ       | Requirement                                                                                                                                          | Acceptance                                                                                                  | Class |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----- |
| **CX-1**  | Order funding order is hold **before** matching sees the order.                                                                                      | Existing unit tests remain green; no regression.                                                            | M     |
| **CX-2**  | Same `clientOrderId` (per user/market) is exactly-once for place: one order, one hold key.                                                           | Concurrent + retry tests green.                                                                             | M     |
| **CX-3**  | Fill settle is idempotent on engine business key (re-delivery safe).                                                                                 | Redelivery test green.                                                                                      | M     |
| **CX-4**  | Cancel after partial fill releases **only** remainder once.                                                                                          | Double-release trap tests green.                                                                            | M     |
| **CX-5**  | Kill-switch / market halt: new places refuse; **cancel still works**.                                                                                | Tests green.                                                                                                | M     |
| **CX-6**  | Engine transport failure after hold: order stays open with hold; recovery path is cancel (404 → full release if never live).                         | Unit test for indeterminate + **documented/automated reconcile** path.                                      | M     |
| **CX-7**  | **Chaos suite (new):** inject at least the fault catalog in §5; steady state conserved.                                                              | Dedicated test module green in CI (or nightly with explicit gate).                                          | M     |
| **CX-8**  | **Assembled path:** trade + matching + ledger (+ bus if events used) under one integration harness or platform:up script — not unit-only.            | Integration proof command documented; green evidence in Verify.                                             | M     |
| **CX-9**  | Open-order ↔ ledger hold ↔ engine live **reconcile** is defined (job or operator procedure with tests for happy/orphan cases).                       | Spec’d states + tests for at least: orphan pending, open+hold no engine, open+engine no hold (fail closed). | M     |
| **CX-10** | Matching recovery: journal-first; process restart rebuilds book without emitting duplicate economic effects on bus consumers (idempotent consumers). | Existing determinism tests + consumer idempotency remain green.                                             | M     |
| **CX-11** | clientOrderId policy: uniqueness rules documented (recommend day-scope or global unique constraint); retries without id documented as unsafe.        | Doc + optional DB uniqueness if already partial.                                                            | P     |
| **CX-12** | No stop-order funding without solved design (current refuse remains or Spec amend).                                                                  | Existing refuse stays unless Spec v2.                                                                       | —     |

### 4.3 DEX plane

| REQ      | Requirement                                                                                                                                                | Acceptance                                     | Class |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ----- |
| **DX-1** | Live `quote` only from sourced venues; never caller-supplied prices as “quote.”                                                                            | Existing tests + no regression of invent path. | P     |
| **DX-2** | Stale / future clock / no venue → machine-readable refuse, not guess.                                                                                      | Tests green.                                   | P     |
| **DX-3** | Multi-venue degrade/singleVenue disclosed; never claim best-of-N when one answered.                                                                        | Tests green.                                   | P     |
| **DX-4** | Effective price routing (fees + settlement cost), not headline-only.                                                                                       | Tests green.                                   | P     |
| **DX-5** | Every adapter `submit` **throws / refuses** — no synthetic fills.                                                                                          | Tests green; code path audited.                | M ban |
| **DX-6** | Quote response includes audit fields sufficient for later TCA: venues configured, venues used, ages, effective prices, degraded flags (extend if missing). | Schema + tests.                                | P     |
| **DX-7** | Rate-limit / 429 from venue: degrade to unavailable, not stale invent.                                                                                     | Test with fake venue.                          | P     |
| **DX-8** | Plane/custodial disclosure retained on venues.                                                                                                             | Tests/docs.                                    | P     |
| **DX-9** | Shell must not render `routePreview` as a live price (coord Stream A if needed).                                                                           | Honesty check or issue + fix.                  | N/P   |

### 4.4 Seed books / mm-bot (Denon #1 engine order)

| REQ      | Requirement                                                                                                              | Acceptance                                                    | Class     |
| -------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- | --------- |
| **SD-1** | Seeded liquidity can rest on markets used by product surfaces.                                                           | Seed path works on tip (resume seeder / bot as needed).       | eng       |
| **SD-2** | Every seeded order **flagged** in data model **and** API response.                                                       | Field present; test.                                          | M product |
| **SD-3** | Seeded volume **excluded** from user-facing 24h volume / any “real activity” stat.                                       | Test: seed trades do not inflate public volume.               | M         |
| **SD-4** | Bot killable via kill-switch surface like other routes.                                                                  | Test.                                                         | M         |
| **SD-5** | Bot does not manufacture unfair crosses that invent fills users would not get (liquidity provision only; tape-provable). | Written rule + test or tape assertion.                        | M         |
| **SD-6** | Mongo/driver pin for vendored seeder stack fixed if seeder depends on it (OP_QUERY vs mongo:6).                          | Seeder boots or residual named with Denon spine resume proof. | eng       |

### 4.5 Multi-asset (Denon #2)

| REQ      | Requirement                                                                               | Acceptance                            | Class       |
| -------- | ----------------------------------------------------------------------------------------- | ------------------------------------- | ----------- |
| **MA-1** | Resume `feat/multi-asset-instruments` (rebase), not greenfield rewrite.                   | PR from rebased branch.               | eng         |
| **MA-2** | Additive: existing spot suite unchanged behavior.                                         | Spot suite green identical.           | M           |
| **MA-3** | Missing trading schedule entry → **refuse**, not throw.                                   | Test.                                 | P           |
| **MA-4** | Forex/commodities not listed as production-tradable without rails (honest refuse/socket). | Config/listing guard or doc + refuse. | product law |

### 4.6 Adjacent money (same real-money story)

| REQ      | Requirement                                                        | Acceptance          | Class |
| -------- | ------------------------------------------------------------------ | ------------------- | ----- |
| **PY-1** | Crypto broadcast durable across process death (claim→put journal). | Tests; Denon §3 #1. | M     |
| **PY-2** | No merchant scope invent; no card scaffold; no go-live.            | PR scope check.     | ban   |

### 4.7 Futures / other engines (explicit bounds)

| REQ      | Requirement                                                                                                 | Acceptance                             | Class     |
| -------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------- | --------- |
| **FT-1** | No futures **engine** MVP claim in this program’s early ships.                                              | Tracker not `done` for futures engine. | ban early |
| **FT-2** | If later futures work starts: Denon six MVP conditions mandatory (isolated only, insurance, gap liq, etc.). | Future Spec v2.                        | —         |
| **FT-3** | Copy trading not scaffolded.                                                                                | Grep/scan clean of new copy product.   | ban       |
| **FT-4** | Algo v1 = TWAP only if ever started; icebergs out.                                                          | Scope check.                           | ban       |

### 4.8 Security / custody / ops (invisible REQs)

| REQ      | Requirement                                                                                    | Acceptance            | Class |
| -------- | ---------------------------------------------------------------------------------------------- | --------------------- | ----- |
| **SC-1** | Protocol plane services do not import ledger write surface (existing custody-scan).            | CI green.             | P     |
| **SC-2** | trade:withdraw never on API keys (existing INTERACTIVE_ONLY).                                  | No regression.        | M     |
| **SC-3** | Sub-account ownership fail-closed before hold.                                                 | Existing tests green. | M     |
| **SC-4** | Secrets / prod RPC / kill-drill sign-off **listed on scoreboard as human**, never agent-green. | Scoreboard axes.      | X     |
| **SC-5** | WAVE-AUDIT after every 3–4 product money ships.                                                | Archive linked.       | N     |

### 4.9 Readiness scoreboard

| REQ      | Requirement                                                                                                                                                   | Acceptance                                 | Class |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ----- |
| **RS-1** | Durable scoreboard doc (or section) with axes: Dual-book · CEX chaos · CEX assemble · DEX honesty · Seed honesty · Multi-asset · Pay durable · Human X items. | Each axis green/red/residual + proof link. | N     |
| **RS-2** | “Stable for real money” language never used without all agent axes green **and** human X residual named.                                                      | Doc wording.                               | N     |

### 4.10 Law / orientation

| REQ      | Requirement                                                 | Acceptance     | Class |
| -------- | ----------------------------------------------------------- | -------------- | ----- |
| **LW-1** | Denon DIRECTION (#272) on main (or tip equivalent).         | Merged PR.     | N     |
| **LW-2** | LIVE-LANES claims `order-route-harden` (+ subsystem lanes). | Board updated. | ops   |
| **LW-3** | Residual campaign R6 order pointer corrected to seed-first. | Doc patch.     | N     |

---

## 5 · Chaos fault catalog (CX-7)

Steady state **S**: after operations, ledger closed (conservation), no double hold/fill/release, open orders reconcilable.

| Fault ID | Injection                                    | Expected                                     |
| -------- | -------------------------------------------- | -------------------------------------------- |
| F1       | Concurrent place same clientOrderId          | One order, one hold                          |
| F2       | Fill event redelivered N times               | One tradeFill                                |
| F3       | Cancel after partial + redelivery            | One remainder release                        |
| F4       | Matching HTTP fail after hold                | Open+hold; cancel recovers                   |
| F5       | Trade dies after engine accept before settle | Recovery consumer settles once               |
| F6       | Matching restart mid-book                    | Replay consistent; no double economic settle |
| F7       | Kill-switch mid-day                          | Place refuse; cancel ok                      |
| F8       | Seed + real user tape                        | Seed flagged; public volume honest           |

Hypothesis: **S holds under F1–F8** in CI/dev. Disproof = failing test.

---

## 6 · Explicit out of scope (this Spec)

- Production go-live flip
- HFT latency rewrite / replace matching engine
- DEX cross-venue **execute** (svc-execution §28)
- Copy trading, icebergs, cross-margin
- Invent fee recipes, listing policy, sanctions content
- Claiming protocol.amm or smart-accounts `done` on anvil-only proof
- Stream A visual retheme (Wave B+) unless honesty collision
- Third-builder reassignment

---

## 7 · Priority order (Spec sequencing — not full Plan)

Must inform Plan; do not skip:

1. **LW-*** law on tip + lanes
2. **DB-*** dual-book enforce (silent money risk)
3. **CX-7/8/9** chaos + assemble + reconcile (prove path)
4. **DX-*** residual DEX honesty
5. **SD-*** seed honesty (Denon #1)
6. **MA-*** multi-asset resume
7. **PY-*** durable broadcast if still open
8. **RS-*** scoreboard + WAVE-AUDIT

Walking skeleton for Build: **CX assemble + F1–F4 minimum** early so later dual-book/seed hang on a proven path.

---

## 8 · Class M / Denon carve-out handling

| Change type                             | Agent may merge?                                                                                                              |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Tests only proving existing recipes     | Yes (after gates)                                                                                                             |
| New chaos harness without recipe change | Yes                                                                                                                           |
| Scan bans / controller door-kill        | **Carve-out risk** — prepare PR + adversarial; if classified posture/custody, **hold for Denon or explicit merge-when-green** |
| New ledger recipe                       | **No** without Denon                                                                                                          |
| External rail value out                 | **No** without Denon                                                                                                          |

When in doubt: treat as carve-out, draft ask, do not silent-merge.

---

## 9 · Verify matrix (two levels)

| Level     | What                                          |
| --------- | --------------------------------------------- |
| Piece     | Each PR’s unit/integration tests for its REQs |
| Assembled | CX-8 path green under F-subset                |
| Program   | RS-1 all agent axes green or residual named   |

No evidence = not done. Fresh Verify agent for money ships.

---

## 10 · Completeness checklist (Spec self-audit)

- [x] Dual-book
- [x] CEX happy + residual + chaos + assemble + reconcile
- [x] DEX quote + no execute
- [x] Seed honesty
- [x] Multi-asset
- [x] Pay adjacent
- [x] Futures/copy bounds
- [x] Security/ops human X
- [x] Scoreboard
- [x] Law/lanes
- [x] Out of scope
- [x] Fault catalog
- [x] Class M rules
- [x] Phase map Spec vs Plan

**Next after this Spec stands:** Architect notes (dual-book shape, chaos harness home, seed model) → **Plan** (task graph with files/tests) → Build lanes.

---

## 11 · Enhanced meta-prompt (agent)

```
You implement ORDER-ROUTE-SPEC-v1. Map every task to REQ-IDs. Do not invent
REQs. Frame method doc owns process. Domain inventory is evidence only.
Nitro is high-level only — no restatement homework, no git homework.
Go all out: complete boards, fresh verify, Class M gates, surprise by rigor.
Denon seed-first; no futures engine early; no go-live claim.
```

### Enhanced Nitro paste prompt

```
Program: docs/ORDER-ROUTE-FRAME-AND-PLANNING-METHODOLOGY-2026-07-31.md
Spec: docs/ORDER-ROUTE-SPEC-v1-2026-07-31.md
Domain: docs/ORDER-ROUTE-HARDEN-PROGRAM-2026-07-31.md

I am Nitro. High-level only. You own quality, completeness, git/PR/verify.
I do not restate specs. You run Frame→Spec→Arch→Plan→Build→fresh Verify→
Review→Ship. Dual-book + CEX chaos/assemble + DEX honesty + seed first.
No fake done. No go-live invent. Report phase + proof links only.
```

---

## 12 · Changelog

| When       | What                                   |
| ---------- | -------------------------------------- |
| 2026-07-31 | Spec v1 complete requirements contract |
