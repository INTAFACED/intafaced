# Plan — order-route / DEX–CEX money-path harden

**Status:** PLAN READY · execute Build from this graph  
**Date:** 2026-07-31  
**For agents:** One worktree per task group; REQ-IDs in every PR; TDD money paths; fresh Verify after each Class M ship.  
**Parents:** Spec v1 · Architect · Landscape v2 · Frame

**Do not skip Phase 0.** Tooling spines first, then dual-book, then product mountains.

---

## 0 · Phase overview (Nitro glance)

| Phase          | Status            | Artifact                   |
| -------------- | ----------------- | -------------------------- |
| 1 Frame        | Done              | methodology + landscape v2 |
| 2 Spec         | Done              | `ORDER-ROUTE-SPEC-v1-…`    |
| 3 Architect    | Done              | `ORDER-ROUTE-ARCHITECT-…`  |
| 4 Plan         | **This file**     | task graph                 |
| 5–8 Build→Ship | Next              | PRs                        |
| 9 Operate      | After first ships | scoreboard                 |

---

## 1 · Global execution rules

1. Worktree from tip (`pnpm wt`); never main checkout.
2. Claim `order-route-harden` (+ sub-lane) in LIVE-LANES before code.
3. PR body: **REQ-IDs** · Class · self-audit · proof command.
4. Class M: adversarial second pass before merge; carve-outs → Denon comment.
5. Builder never grades self — spawn Verify agent.
6. `pnpm verify` (or scoped equivalent + document why) before push.
7. Local green before push (fast feedback). One concern per PR. No Actions spend hold.
8. Re-fetch tip every fire — tip moves (#278 futures etc.).

---

## 2 · REQ coverage matrix (completeness gate)

Every Spec REQ → ≥1 task. Plan fails if any REQ unmapped.

| REQ             | Task IDs                     |
| --------------- | ---------------------------- |
| LW-1            | P0-1                         |
| LW-2            | P0-2                         |
| LW-3            | P0-3                         |
| CX-1…CX-6       | P1-0 (guard), existing suite |
| CX-7            | P1-1, P1-2, P1-4             |
| CX-8            | P1-3                         |
| CX-9            | P1-5                         |
| CX-10           | P1-0                         |
| CX-11           | P1-6                         |
| CX-12           | P1-0                         |
| DB-1…DB-5       | P2-1…P2-5                    |
| DX-1…DX-5, DX-8 | P3-0                         |
| DX-6, DX-7      | P3-1                         |
| DX-9            | P3-2                         |
| SD-1…SD-6       | P4-1…P4-4                    |
| MA-1…MA-4       | P5-1, P5-2                   |
| PY-1, PY-2      | P6-1                         |
| FT-1…FT-4       | P7-1 (bounds check)          |
| SC-1…SC-5       | P2 scans, P8-2               |
| RS-1, RS-2      | P8-1                         |
| GC-*            | all tasks                    |

---

## 3 · Task graph

### Phase 0 — Law, lanes, orientation

#### P0-1 · Land Denon direction on main (LW-1)

- **Files:** babysit/merge `#272` if still open; else confirm tip has `DIRECTION-2026-07-31` + ADR Accepted
- **Check:** `git show origin/main:docs/DIRECTION-2026-07-31.md` exists; ADR Status Accepted
- **Class:** N

#### P0-2 · LIVE-LANES claim (LW-2)

- **Files:** `docs/LIVE-LANES.md`
- **Claim:** `order-route-harden` coordinator; free sub-lanes for dual-book / chaos / seed
- **Check:** board lists this program; no collision with Stream A shell
- **Class:** N

#### P0-3 · Residual campaign engine-order pointer (LW-3)

- **Files:** residual campaign or START-HERE one-line pointer → seed-first (Denon §1)
- **Check:** no “futures first” as active residual order
- **Class:** N

---

### Phase 1 — Walking skeleton + chaos (CEX proof)

#### P1-0 · Guard: existing trade suite still green (CX-1–6, CX-10, CX-12)

- **Cmd:** `pnpm --filter @intafaced/svc-trade test` (and matching engine tests)
- **Check:** no regression before new harness
- **Class:** M tests

#### P1-1 · Chaos harness skeleton + F1–F4 (CX-7 partial) ★ SPINE

- **Architect:** Seam B1
- **Files:** prefer `services/svc-trade/src/spot/order-route-chaos*.test.ts` (or `tooling/order-route-chaos/`)
- **Implement:**
  - F1 concurrent same clientOrderId
  - F2 fill redelivery
  - F3 partial cancel remainder once
  - F4 matching transport fail after hold → open+hold
- **TDD:** write failing tests first where gaps exist; extend existing where already covered with explicit `describe('chaos F*')` labels
- **Check:** named F1–F4 green
- **Class:** M

#### P1-2 · fast-check properties (CX-2, CX-3, conservation) ★ SPINE

- **Deps:** add `fast-check` / `@fast-check/vitest` to trade or ledger-client tests
- **Properties:** retry same clientOrderId never double-holds; redelivered fill never double-settles; amounts stay decimal-string safe
- **Check:** property suite green
- **Class:** M

#### P1-3 · Assembled path smoke (CX-8) ★ SPINE

- **Files:** `tooling/scripts/order-path-smoke.mjs` + short `docs/` how-to OR README section
- **Behavior:** with infra/platform up (document exact compose), place two-sided or seed+taker path; assert fill + ledger closed OR honest skip if fleet down
- **Check:** script exits 0 with proof log; CI optional / PR-required evidence
- **Class:** M / ops

#### P1-4 · Chaos F5–F8 (CX-7 complete)

- **After:** P1-1 green
- **F5** trade die after engine accept (consumer settles once)
- **F6** matching restart / journal replay no double settle
- **F7** kill-switch place refuse + cancel ok
- **F8** seed+user volume honesty (may wait P4 flag)
- **Check:** all F* green or F8 blocked-on SD
- **Class:** M

#### P1-5 · Reconcile open/hold/engine (CX-9)

- **Design:** states orphan pending · open+hold no engine · open+engine (document job or service method + tests)
- **Files:** `svc-trade` reconcile helper + tests
- **Check:** three cases tested fail-closed
- **Class:** M

#### P1-6 · clientOrderId policy note (CX-11)

- **Files:** svc-trade README or Spec delta — uniqueness recommendation
- **Optional:** DB unique where missing
- **Check:** documented
- **Class:** P/N

---

### Phase 2 — Dual-book Option B

#### P2-1 · Inventory Java money doors (DB-2 prep)

- **Files:** `tooling/scripts/vendor-money-inventory.mjs` → markdown report under docs/ or tooling/
- **Check:** count controllers + list four DAO mutators with paths
- **Class:** N/P

#### P2-2 · Scan-ban mutators (DB-3)

- **Files:** `tooling/ci/vendor-shell-scan.mjs`
- **Add:** increaseBalance / decreaseBalance / freezeBalance / thawBalance (Java method patterns)
- **Check:** scan fails if present as live write; allowlist empty
- **Class:** P (custody adjacent — adversarial)

#### P2-3 · Java money scan (DB-4)

- **Files:** extend custody-scan or new `tooling/ci/vendor-java-money-scan.mjs` wired into `pnpm verify` / dod-gate
- **Check:** `.java` files scanned; CI red on forbidden balance writes
- **Class:** P/M posture

#### P2-4 · Disable controllers at door (DB-1, DB-2)

- **Architect:** Seam A1
- **Files:** vendor Spring security/filter under the vendored exchange tree
- **Check:** sample money controller call refused; inventory list covered
- **Class:** M posture — **carve-out risk**; adversarial + Denon note if needed
- **Depends:** P2-1

#### P2-5 · Projection / ADR close (DB-1, DB-5)

- **Depends:** P0-1 ADR Accepted
- **Files:** docs + any read-only projection stub if required; tracker honesty
- **Check:** dual-book residual closed or residual named
- **Class:** N/M

---

### Phase 3 — DEX residual

#### P3-0 · Guard existing DEX quote suite (DX-1–5, DX-8)

- **Cmd:** svc-dex tests green
- **Class:** P

#### P3-1 · Audit fields + 429 degrade (DX-6, DX-7)

- **Files:** `services/svc-dex/src/quote/*`
- **Check:** tests for audit fields + 429 → unavailable not invent
- **Class:** P

#### P3-2 · routePreview not price (DX-9)

- **Coord Stream A** if shell issue; issue or small honesty PR
- **Check:** no shell renders routePreview as live price
- **Class:** N

---

### Phase 4 — Seed / mm honesty (Denon #1)

#### P4-1 · Resume seeder + Mongo pin (SD-1, SD-6)

- **Branch:** `feat/spine-market-seeder` per Denon
- **Check:** seeder boots or residual named with evidence
- **Class:** eng

#### P4-2 · Seeded flag model + API (SD-2)

- **Architect:** Seam C1
- **Migration:** trade orders flag; API exposes
- **Check:** test
- **Class:** M

#### P4-3 · Volume exclude + kill-switch (SD-3, SD-4)

- **Check:** seeded volume not in public 24h; kill-switch stops bot
- **Class:** M

#### P4-4 · Unfair cross ban (SD-5)

- **Check:** written rule + test or tape assertion
- **Class:** M
- **Note:** enables F8

---

### Phase 5 — Multi-asset (Denon #2)

#### P5-1 · Rebase multi-asset branch (MA-1)

- **Branch:** `feat/multi-asset-instruments`
- **Check:** rebased on tip; PR open
- **Class:** eng

#### P5-2 · Additive spot + schedule refuse (MA-2, MA-3, MA-4)

- **Check:** spot suite unchanged; missing schedule refuses; forex prod list guard
- **Class:** M/P

---

### Phase 6 — Adjacent pay

#### P6-1 · Durable broadcast residual (PY-1, PY-2)

- **Orient:** open PRs (#266 era / tip successors); extend not rebuild
- **Check:** durable claim→put; no scope invent
- **Class:** M

---

### Phase 7 — Bounds

#### P7-1 · Futures/copy bounds audit (FT-1…FT-4)

- **Check:** tracker honesty; no copy scaffold; no futures engine “done” claim for this program
- **Note:** tip may have futures REST — document residual honestly, don’t invent MVP done
- **Class:** N

---

### Phase 8 — Scoreboard + WAVE-AUDIT

#### P8-1 · Readiness scoreboard (RS-1, RS-2)

- **Files:** `docs/ORDER-ROUTE-READINESS-SCOREBOARD.md`
- **Axes:** Dual-book · CEX chaos · CEX assemble · DEX · Seed · Multi-asset · Pay · Human X
- **Check:** each axis green/red/residual + proof link
- **Class:** N

#### P8-2 · WAVE-AUDIT after 3–4 product ships (SC-5)

- **Check:** archive linked
- **Class:** N

---

## 4 · Parallelism (≤3 code lanes)

| Lane           | Tasks                                                             | Avoid                   |
| -------------- | ----------------------------------------------------------------- | ----------------------- |
| **L-chaos**    | P1-*                                                              | dual-book Java          |
| **L-dualbook** | P2-*                                                              | trade money path invent |
| **L-seed**     | P4-* after P1-1 optional                                          | futures engine          |
| Serial         | P0 → start P1 → then parallel P2∥P1 rest → P3 → P4 → P5 → P6 → P8 |                         |

---

## 5 · Definition of “Plan complete → Build”

- [x] Every REQ mapped
- [x] Architect seams decided
- [x] Tooling spines P1-1…P1-3 before product mountains
- [x] Class M carve-outs flagged on P2-4
- [x] Parallel lanes named

**Next Build start order:** P0-1 → P0-2 → P0-3 → **P1-0 → P1-1** (first code).

---

## 6 · Enhanced agent prompt (Build)

```
Execute docs/ORDER-ROUTE-PLAN-2026-07-31.md from tip worktree.
Start P0 then P1-1 chaos spine. Map REQs in PR body.
Spec: ORDER-ROUTE-SPEC-v1. Architect: ORDER-ROUTE-ARCHITECT.
Landscape v2 Tier A only unless blocked. Fresh verify Class M.
No go-live. Seed before futures program invent. Nitro high-level only.
```

---

## 7 · Changelog

| When       | What                  |
| ---------- | --------------------- |
| 2026-07-31 | Initial complete Plan |
