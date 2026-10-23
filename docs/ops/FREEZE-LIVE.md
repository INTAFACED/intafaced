# FREEZE-LIVE (generated)

> **STALE SNAPSHOT — not cold-start law.** Generated content below is frozen at the tip SHA named in the first bullet. Re-derive before acting: `git fetch && git log -1 --oneline origin/main` then `pnpm swarm:freeze`. Numbers (free claims, Actions 24h, worktrees) go bad in hours. Thrift / “billing ceiling” lines are historical if present — thrift was deleted 2026-08-07; public Actions are free. Prefer live `pnpm wt:gc` over any apply line printed here.

**Do not hand-edit.** Regenerate: `pnpm swarm:freeze`

- **Tip:** `049a10d` — feat(agents): support Stage-1 money-tool refuse guardrail (#758)
- **Generated:** 2026-08-04T12:42:02.464Z
- **Open PRs:** 8
- **Free claims:** 39 (product 9 · implementable 9) · **Blocked:** 1
- **Spawn accounting:** available=9 · active_spawned_locks=10 · gap=9 · width_target=3-6 (implementable TRK)
- **Anti-under-spawn:** anti-under-spawn FAIL: available=9 (implementable=9) active_spawned_locks=10 gap=9 — spawn path-disjoint Class N (width 3–6 TRK / 6–8 shell).
- **Mandate:** freeProduct = REGROUP/AFK/LANDER/INTEGRITY + implementable TRK (non-money, deps done, spec≥100). residual-own does not hide TRK implementable. Money-class closed. Wave1 exclude ops.admin/ops.compliance.
- **AFK ladder:** P0 SPAWN_NOW free product path-disjoint (width 6–8). Stamp mill still banned.
- **Stamp-mill ban:** Do not open docs(ops) R07/R01/P-WS “cycle N” PRs solely because freeProduct=0. Ship only on board delta or P1–P3 deliverable. Law: docs/ops/SWARM-MANDATE.md
- **Ops churn:** 0 consecutive docs-only tip merges
- **Stranded branches (P1):** 46
- **Worktrees:** 169 ⚠ OVER CAP 20 — remove only your own worktree with `git worktree remove <path>`, never `--force`
- **Actions runs (24h):** 729 (Docs format=602, CI=113, Order-path CX-8=14) — billing ceiling risk if Docs-format dominates; Denon owns Actions budget
- **Proof mode:** NO-FLEET until Docker present — static build + scans; never fake UI done. UI proof tooling exists (`pnpm ui:proof` + `docs/styleboard/`) — NO-FLEET is Docker, not "never seen UI".
- **Claims:** docs/ops/claims/<id>.md (do not hand-edit LIVE-LANES mid-wave)
- **Cold resume:** this file + `docs/COORDINATION-TRUTH-LAYERS.md` § Agent cold-start · human blockers: `docs/BOARD-CLEAR-HUMAN-BLOCKERS.md` · value gate: `tooling/ci/value-gate.mjs`
- **Residual:** updated=2026-08-03 tip_note=claim-lock authority · WHITEPAPER retired · AFK shell wave closed

## Free (spawn one worker each)

| rank | id                             | track         | title                                                     | paths (sample)                                   | note                                                             |
| ---: | ------------------------------ | ------------- | --------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------- |
|   50 | **TRK-academy.ambassadors**    | IMPLEMENTABLE | Residencies, IFC pay, revenue share                       | docs/ops/trk/academy.ambassadors.md              | implementable TRK (spec 140 lines · deps done) — Stage-1 Class N |
|   50 | **TRK-academy.curriculum**     | IMPLEMENTABLE | DERIV//DESK library import — 20 playbooks + 3 workbooks   | docs/ops/trk/academy.curriculum.md               | implementable TRK (spec 147 lines · deps done) — Stage-1 Class N |
|   50 | **TRK-academy.spatial**        | IMPLEMENTABLE | 2D navigable room canvas, VR-ready scene state            | docs/ops/trk/academy.spatial.md                  | implementable TRK (spec 143 lines · deps done) — Stage-1 Class N |
|   50 | **TRK-academy.tournaments**    | IMPLEMENTABLE | Seasonal ladders, IFC prize pools                         | docs/ops/trk/academy.tournaments.md              | implementable TRK (spec 139 lines · deps done) — Stage-1 Class N |
|   50 | **TRK-agents.navigator**       | IMPLEMENTABLE | Navigator — tool-calling inside user guardrails           | docs/ops/trk/agents.navigator.md                 | implementable TRK (spec 141 lines · deps done) — Stage-1 Class N |
|   50 | **TRK-agents.support**         | IMPLEMENTABLE | Support agent — KB + account-state grounded               | docs/ops/trk/agents.support.md                   | implementable TRK (spec 144 lines · deps done) — Stage-1 Class N |
|   50 | **TRK-ops.affiliates**         | IMPLEMENTABLE | Multi-tier affiliate / IB trees, payout automation        | docs/ops/trk/ops.affiliates.md                   | implementable TRK (spec 132 lines · deps done) — Stage-1 Class N |
|   50 | **TRK-ops.analytics**          | IMPLEMENTABLE | Warehouse — read replica + cube layer                     | docs/ops/trk/ops.analytics.md                    | implementable TRK (spec 123 lines · deps done) — Stage-1 Class N |
|   50 | **TRK-ops.notifications**      | IMPLEMENTABLE | Event-driven fan-out: in-app, push, email, SMS            | services/svc-notify                              | implementable TRK (spec 183 lines · deps done) — Stage-1 Class N |
|  200 | **BABYSIT-MATRIX**             | OPS           | Babysit open partner PRs (comment/CI only)                | —                                                | Shehzad #346 + Denon open — no implement                         |
|  210 | **REPORTS**                    | OPS           | Refresh R00–R02 via pnpm swarm:report                     | docs/ops                                         | Coord-OPS                                                        |
|  300 | **TRK-academy.certs**          | TRACKER       | Certifications → XP → real perks                          | docs/ops/trk/academy.certs.md                    | dep-blocked                                                      |
|  300 | **TRK-agents.copy-intel**      | TRACKER       | Copy-Intel — writes audited leader stats                  | docs/ops/trk/agents.copy-intel.md                | dep-blocked                                                      |
|  300 | **TRK-agents.merchant**        | TRACKER       | Merchant agent — approval-rate watch                      | docs/ops/trk/agents.merchant.md                  | dep-blocked                                                      |
|  300 | **TRK-bank.cards**             | TRACKER       | CardIssuerAdapter + card-sim, <2s auth decision           | docs/ops/trk/bank.cards.md                       | money-gated · thin/missing spec (0 lines)                        |
|  300 | **TRK-bank.ramps**             | TRACKER       | Fiat on/off ramp reusing svc-pay adapters                 | docs/ops/trk/bank.ramps.md                       | money-gated · thin/missing spec (0 lines)                        |
|  300 | **TRK-bank.sovereign-card**    | TRACKER       | Self-custody funded card, JIT conversion (§18)            | docs/ops/trk/bank.sovereign-card.md              | dep-blocked · money-gated · thin/missing spec (0 lines)          |
|  300 | **TRK-blueprint.attestations** | TRACKER       | On-chain rank attestations, zero PII (§19)                | docs/ops/trk/blueprint.attestations.md           | dep-blocked                                                      |
|  300 | **TRK-indexer.readmodels**     | TRACKER       | Chain → Postgres read models                              | services/svc-indexer                             | dep-blocked                                                      |
|  300 | **TRK-market.commerce**        | TRACKER       | Listings, subscriptions, purchases, house commission      | docs/ops/trk/market.commerce.md                  | dep-blocked · money-gated                                        |
|  300 | **TRK-market.vendors**         | TRACKER       | Vendor lifecycle — apply, vet, list, stake-gated slots    | docs/ops/trk/market.vendors.md                   | money-gated                                                      |
|  300 | **TRK-ops.compliance**         | TRACKER       | Screening queues, geo-block, VPN/Tor detection            | docs/ops/trk/ops.compliance.md                   | wave1-exclude                                                    |
|  300 | **TRK-p2p.merchants**          | TRACKER       | P2P merchant programme — badges, limits, API              | docs/ops/trk/p2p.merchants.md                    | money-gated                                                      |
|  300 | **TRK-pay.fraud**              | TRACKER       | Risk scoring, chargebacks, decline recovery               | docs/ops/trk/pay.fraud.md                        | dep-blocked · money-gated · thin/missing spec (0 lines)          |
|  300 | **TRK-pay.payfac**             | TRACKER       | PayFac mode — sub-merchant trees, 14 permission areas     | docs/ops/trk/pay.payfac.md                       | dep-blocked · money-gated · thin/missing spec (0 lines)          |
|  300 | **TRK-pay.plugins**            | TRACKER       | Woo / Magento / OpenCart plugins                          | docs/ops/trk/pay.plugins.md                      | dep-blocked · money-gated · thin/missing spec (0 lines)          |
|  300 | **TRK-pay.psp**                | TRACKER       | PSP mode — own the merchant, digital KYB, custom pricing  | docs/ops/trk/pay.psp.md                          | dep-blocked · money-gated · thin/missing spec (0 lines)          |
|  300 | **TRK-pay.public-api**         | TRACKER       | Public REST + webhooks + sandbox (§9)                     | docs/ops/trk/pay.public-api.md                   | dep-blocked · money-gated · thin/missing spec (0 lines)          |
|  300 | **TRK-pay.routing**            | TRACKER       | Smart routing — geo, method, risk, approval rate          | docs/ops/trk/pay.routing.md                      | money-gated · thin/missing spec (0 lines)                        |
|  300 | **TRK-pay.settlement**         | TRACKER       | Dual settlement — bank or crypto                          | docs/ops/trk/pay.settlement.md                   | money-gated · thin/missing spec (0 lines)                        |
|  300 | **TRK-pay.subscriptions**      | TRACKER       | Recurring — card and crypto                               | docs/ops/trk/pay.subscriptions.md                | dep-blocked · money-gated · thin/missing spec (0 lines)          |
|  300 | **TRK-trade.algo**             | TRACKER       | TWAP / VWAP / POV execution                               | docs/ops/trk/trade.algo.md                       | money-gated · thin/missing spec (0 lines)                        |
|  300 | **TRK-trade.ccxt-api**         | TRACKER       | CCXT-compatible public API (bots + terminals connect)     | docs/ops/trk/trade.ccxt-api.md                   | money-gated                                                      |
|  300 | **TRK-trade.copy**             | TRACKER       | Copy trading, audited leaders, profit share               | docs/ops/trk/trade.copy.md                       | money-gated · thin/missing spec (0 lines)                        |
|  300 | **TRK-trade.forex**            | TRACKER       | Fiat pairs on the same engine                             | docs/ops/trk/trade.forex.md                      | money-gated                                                      |
|  300 | **TRK-trade.futures**          | TRACKER       | Perps: cross/isolated margin, funding, liquidation ladder | docs/ops/trk/trade.futures.md                    | money-gated · thin/missing spec (0 lines)                        |
|  300 | **TRK-trade.options**          | TRACKER       | European options, cash-settled, full collateral in v1     | docs/ops/trk/trade.options.md                    | dep-blocked · money-gated                                        |
|  300 | **TRK-trade.otc**              | TRACKER       | OTC RFQ desk, staked-tier gate                            | docs/ops/trk/trade.otc.md                        | money-gated · thin/missing spec (0 lines)                        |
|  300 | **TRK-venue.aggregation**      | TRACKER       | External venue adapters via CCXT (cross-venue)            | packages/venue-adapter; packages/venue-contracts | money-gated                                                      |

## Blocked (do not implement)

| id              | track     | title                                                     | collisions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------- | --------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **P-WS-REPORT** | INTEGRITY | WS market-ID + /ws→/stream integrity report (no depth UI) | #433@Phantom-X-007 services/svc-matching/README.md<br>#433@Phantom-X-007 services/svc-matching/src/engine/engine.ts<br>#433@Phantom-X-007 services/svc-matching/src/engine/types.ts<br>#433@Phantom-X-007 services/svc-matching/src/index.ts<br>#433@Phantom-X-007 services/svc-matching/src/reconcile.test.ts<br>#433@Phantom-X-007 services/svc-matching/src/reconcile.ts<br>#433@Phantom-X-007 services/svc-matching/src/router.test.ts<br>#433@Phantom-X-007 services/svc-matching/src/router.ts<br>#432@Phantom-X-007 services/svc-edge/src/env.ts<br>#432@Phantom-X-007 services/svc-edge/src/index.ts |

## Open PR snapshot

- #762 @ZenYoda3 · 7 files · MERGEABLE · feat(academy): spatial Stage-1 scene v1 schema + size gate
- #746 @Phantom-X-007 · 1 files · MERGEABLE · docs(adr): which service decides what a market is
- #433 @Phantom-X-007 · 9 files · MERGEABLE · fix(matching): reconciliation is reachable — and the money-stranding case refuses rather than guesses
- #432 @Phantom-X-007 · 7 files · CONFLICTING · fix(config): a commercial region block could satisfy the sanctions boot guard
- #430 @Phantom-X-007 · 1 files · MERGEABLE · docs(audit): 40 law-specified capabilities have no tracker row — and the gate that was meant to catch that was never built
- #428 @Phantom-X-007 · 18 files · CONFLICTING · feat(p2p): payment instruments — a buyer finally has somewhere to send money
- #420 @Phantom-X-007 · 1 files · MERGEABLE · docs+fix(tracker): correct the margin-call remedy, and lock the one bank row that was not
- #346 @shehzad002 · 12 files · CONFLICTING · feat(pay): M1 pay.gateway Done bar — card sandbox + KYB stub + durable list

## NEVER-TOUCH mid-wave (open multi-PR clusters)

- `docs/LIVE-LANES.md` — inside Denon open PRs (#436/#428); use `docs/ops/claims/<id>.md` instead
- `tooling/tracker/features.mjs` / `docs/TRACKER.md` — batch at wave end
- `package.json` / `tooling/ci/brand-scan.mjs` / `gates.mjs` / `.github/workflows/ci.yml` — multi-PR pile; use `node tooling/scripts/swarm.mjs` if aliases conflict
- Visual proof on :8090 if `lsof` path is not your worktree (stale squatter risk)
- Full fleet proof if Docker missing — stamp `proof_missing: fleet-blocked` (NO-FLEET mode)

## Claim files

Atomic claim: `pnpm swarm:claim <id>` → `docs/ops/claims/<id>.md` (first writer wins).

## Law

- `docs/ops/SWARM-MANDATE.md` (AFK priority ladder + stamp-mill ban) · `docs/SWARM-ALL-OUT-ORIENT-2026-08-03.md` · `docs/REGROUP-2026-08-03.md`
- Before edit: `pnpm claim:check <paths>` · worktree only · no invent money/depth
- Shehzad protocol/INTACHAIN babysit only · no dual-edit Denon open PR files
