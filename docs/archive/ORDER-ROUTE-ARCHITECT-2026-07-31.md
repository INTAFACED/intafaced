> **Supersession (2026-08-09):** Any line that treats **Actions thrift**, run-count caps, `THRIFT_ALLOW`, or holding PRs for CI spend as current law is **void**. The repo is public; thrift was deleted 2026-08-07. See [`GITHUB-CI-SPEND-CONTROL-2026-07-31.md`](GITHUB-CI-SPEND-CONTROL-2026-07-31.md). Historical text below may still _mention_ thrift as what was once believed.

# Architect notes — order-route harden (hard seams only)

**Status:** DECIDED · agent-owned picks · Class M carve-outs flagged  
**Date:** 2026-07-31  
**Parents:** Spec v1 · Landscape v2 · Frame methodology  
**Tip note:** re-derive — tip was past #278 futures REST when written; does **not** change seed-first Spec GC-5 for program order

Ambiguous seams only. Everything else is mechanical implementation of Spec.

---

## Seam A — Dual-book Option B enforcement

### Options

|        | Approach                                                                                                                                         | Pros                                                                    | Cons                                                           |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- | -------------------------------------------------------------- |
| **A1** | Disable money controllers **at Spring door** (filter/interceptor/security config returns 410/403) + scan-ban DAO mutators + Java in custody-scan | Matches Denon wording exactly; reversible; no rewrite of 25 controllers | Needs Java inventory; posture/custody → Class M carve-out risk |
| **A2** | Rewrite each controller to call ledger                                                                                                           | “Clean” long-term                                                       | Huge; invents product paths; wrong for residual program        |
| **A3** | Scan-only (no runtime disable)                                                                                                                   | Cheap                                                                   | **Second book still callable** — fails Denon “at the door”     |

### Decision: **A1**

**Shape:**

1. **Inventory PR (docs/tooling):** script lists controllers + `MemberWalletDao` mutators under the vendored exchange tree (`vendor/<exchange>/…` — paths already include `MemberWalletController`, finance controllers, etc.).
2. **Scan PR:** extend `tooling/ci/vendor-shell-scan.mjs` with four mutator patterns; extend `custody-scan` or sibling `vendor-java-money-scan.mjs` to walk `.java`.
3. **Runtime PR:** Spring-level block on money mutator endpoints / DAO write methods (prefer filter on URL patterns + fail-closed default).
4. **ADR:** ensure dual-book Accepted lands via #272 merge (LW-1).

**Failure modes:** incomplete inventory · allowlist creep · filter bypass on alternate ports · scan misses Kotlin/XML SQL.

**Class M:** scan + door-kill may touch **custody/posture** → self-audit + adversarial; if Denon carve-out applies, PR comment + hold merge until green-when-allowed.

---

## Seam B — Chaos / assembled proof harness

### Options

|        | Approach                                                                                                                 | Pros                                | Cons                              |
| ------ | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------- | --------------------------------- |
| **B1** | In-process harness: real `TradeService` + memory ledger + fake/real matching client + memory bus; inject faults at seams | Fast CI; deterministic; fits thrift | Misses real TCP                   |
| **B2** | Full `platform:up` only                                                                                                  | Highest fidelity                    | Slow CI; flake; thrift cost       |
| **B3** | Toxiproxy between services day-1                                                                                         | Real network faults                 | Setup tax before unit chaos green |

### Decision: **B1 then B2 subset; B3 Tier B**

**Shape:**

1. **Package:** `services/svc-trade` test module or `tooling/order-route-chaos/` with vitest.
2. **F1–F4 first** (concurrent clientOrderId, fill redelivery, cancel partial, matching HTTP fail after hold) using existing patterns in `trade-service.test.ts` + explicit fault injection hooks.
3. **CX-8:** `tooling/scripts/order-path-smoke.mjs` (or similar) documenting `platform:up` + minimal two-user fill scenario; evidence in PR body (not necessarily every CI push).
4. **F5–F8** after F1–F4 green.
5. **Toxiproxy** only if transport mocks fail to catch a real bug class.

**Failure modes:** harness diverges from prod wiring · tests that only pass with mocks · thrift blow-up from platform:up on every PR.

**Jepsen steal:** ops set = place/cancel/fill/redeliver; invariant = conservation + single settle.

---

## Seam C — Seed / mm honesty model

### Options

|        | Approach                                                                                         | Pros                    | Cons                                           |
| ------ | ------------------------------------------------------------------------------------------------ | ----------------------- | ---------------------------------------------- |
| **C1** | Flag on order row + API (`seeded: true` / `liquiditySource: seed`) + volume queries exclude flag | Clear; Denon-compatible | Schema migration in trade                      |
| **C2** | Separate seed account only                                                                       | Simple                  | Can still pollute volume stats if not filtered |
| **C3** | Off-book fake depth in UI                                                                        | Easy                    | **Lie** — ban                                  |

### Decision: **C1 + C2 together**

Seed bot uses dedicated account **and** every seed order is flagged; public 24h volume SQL/API **excludes** flagged. Kill-switch kills bot place path. Resume seeder spine with Mongo pin fix as eng dependency (SD-6).

**Failure modes:** unflagged seed · volume endpoint bypass · bot crosses unfairly.

---

## Seam D — Multi-asset resume (brief)

**Decision:** Rebase `origin/feat/multi-asset-instruments` onto tip; additive spot suite must stay green (MA-2). No greenfield. After dual-book tooling + chaos skeleton, not before walking skeleton F1–F4.

---

## Seam E — DEX residual (brief)

**Decision:** Stay quote-only. Extend tests for 429→unavailable and audit fields (DX-6/7). No execute. Stream A coord for routePreview (DX-9) only if shell still misrenders.

---

## Cross-cutting architecture laws

1. **No new ledger recipes** without Denon carve-out process.
2. **Matching stays pure** — no balances.
3. **Trade owns funding order** — hold before submit.
4. **Events are recovery**, not sole path — already designed.
5. **Futures REST on tip (#278 era)** does not reorder Spec GC-5 for _this_ program’s residual board (seed honesty + dual-book + CEX chaos remain first).

---

## Open questions (agent-default if unresolved)

| Q                           | Default                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------ |
| Exact Spring door mechanism | URL security filter fail-closed; inventory-driven allowlist of _non_-money routes only if needed |
| Chaos package home          | Prefer `services/svc-trade` tests first; extract `tooling/order-route-chaos` if shared           |
| Scoreboard file             | `docs/ORDER-ROUTE-READINESS-SCOREBOARD.md`                                                       |
