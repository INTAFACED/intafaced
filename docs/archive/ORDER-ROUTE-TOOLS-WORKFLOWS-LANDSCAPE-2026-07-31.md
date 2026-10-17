> **Supersession (2026-08-09):** Any line that treats **Actions thrift**, run-count caps, `THRIFT_ALLOW`, or holding PRs for CI spend as current law is **void**. The repo is public; thrift was deleted 2026-08-07. See [`GITHUB-CI-SPEND-CONTROL-2026-07-31.md`](GITHUB-CI-SPEND-CONTROL-2026-07-31.md). Historical text below may still _mention_ thrift as what was once believed.

# Frame · Research landscape — tools & workflows (professionals, not vibe coding)

**Status:** SUPERSEDED by **v2** — use [`ORDER-ROUTE-TOOLS-WORKFLOWS-LANDSCAPE-v2-2026-07-31.md`](ORDER-ROUTE-TOOLS-WORKFLOWS-LANDSCAPE-v2-2026-07-31.md)  
**Date:** 2026-07-31  
**Home:** Frame phase for order-route / DEX–CEX money-path program  
**Parents:** `ORDER-ROUTE-FRAME-AND-PLANNING-METHODOLOGY-2026-07-31.md` · Spec v1 · domain inventory

**Purpose:** Name the **professional stack and workflows** that change outcomes for this program — not a random tool dump. Every row ends with **adopt / adopt later / reject** for _this_ repo.

---

## 0 · Vibe coder vs professional (this program)

| Vibe coder                           | Professional (what we do)                                      |
| ------------------------------------ | -------------------------------------------------------------- |
| “Ship PRs until it feels stable”     | Spec REQs → Plan → TDD → **fresh** verify → money review       |
| Unit tests only on happy path        | Unit + **property** + **chaos catalog** + **assembled path**   |
| Mock the world forever               | In-process fakes for speed **and** real compose path for truth |
| Trust the builder chat’s “green”     | Builder never grades self                                      |
| Install every trendy agent framework | **Reuse monorepo law** + thin force-multipliers only           |
| Chaos as theater (break prod)        | Steady-state hypothesis + **dev/CI faults** from Spec §5       |
| Spec in chat memory                  | Spec as **contract** (REQ-IDs) in durable docs                 |
| Mark tracker done                    | Evidence links or residual named                               |

**Insane difference** comes less from one magic tool and more from **workflow law**: phase separation, REQ mapping, dual verify levels, dual-book scans, chaos catalog as tests.

---

## 1 · What we already have (use first — free leverage)

Do **not** replace these with fashionable alternatives.

| Asset                                        | Role for this program                              | Professional use                                            |
| -------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------- |
| **`pnpm verify`**                            | Build + typecheck + test + DoD gate                | Local merge seal                                            |
| **Vitest** (everywhere)                      | Unit + service tests                               | Primary runner; already huge trade/matching suites          |
| **Doctrine scans**                           | brand / custody / vendor-shell / secrets / test-db | Dual-book enforcement **extends** these — not a new product |
| **`dod-gate.mjs`**                           | Definition of Done CI                              | Keep; money PRs must pass                                   |
| **Worktrees (`pnpm wt`)**                    | Isolation                                          | Mandatory per Build lane                                    |
| **Tracker + LIVE-LANES**                     | Claim / collision                                  | Program lanes claimed before code                           |
| **`platform:up` / compose**                  | Assembled fleet                                    | Walking skeleton / CX-8 home                                |
| **`infra:up`**                               | Postgres, NATS, etc.                               | Integration truth                                           |
| **Ledger recipes + memory ledger**           | Money truth in tests                               | Prefer recipes over reinvent                                |
| **Matching FileJournal + determinism tests** | Engine recovery                                    | Extend, don’t rewrite                                       |
| **JetStream bus + memory bus**               | Event recovery                                     | Redelivery tests use real semantics                         |
| **Playwright uiproof**                       | Shell proof                                        | Only when Stream A honesty collides (DX-9)                  |
| **Class M matrix**                           | Money merge self-audit + green CI                  | Non-negotiable (thrift deleted 2026-08-07)                  |
| **Doubt-driven / review skills**             | Fresh adversarial                                  | Every Spec/Arch/money PR                                    |
| **Multi-session coding agents**              | Builder ≠ verifier                                 | Session topology from Frame                                 |

**Verdict:** We are not tool-poor. We are **workflow-incomplete** (chaos suite, dual-book scan depth, assembled path as first-class, Spec as gate).

---

## 2 · Landscape by job (what professionals use)

### 2.1 Spec / planning / agent orchestration

| Tool / workflow                    | What it is                                    | Delta for us                                | Decision                                                                                 |
| ---------------------------------- | --------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **Our Spec v1 + Frame docs**       | Durable REQ contract                          | Already started                             | **Adopt as SoT**                                                                         |
| **GitHub Spec Kit**                | specify→plan→tasks→implement + “constitution” | Good structure; risk of second process      | **Adopt pattern only** — map to our docs; optional later install if agents thrash        |
| **OpenSpec**                       | Delta specs, light brownfield                 | Fits iterative money residual               | **Adopt pattern** (delta REQs in Spec changelog) — full install optional                 |
| **BMAD-METHOD**                    | Heavy multi-agent roles (21+)                 | Strong adversarial roles; high ceremony tax | **Reject full install**; steal “party mode / adversarial roles” as **spawned subagents** |
| **Doubt-driven development**       | Fresh-context disproof                        | Already in Nitro system                     | **Adopt always** on non-trivial                                                          |
| **Superpowers writing-plans**      | Bite-size TDD task graphs                     | Plan rung                                   | **Adopt for Plan doc**                                                                   |
| **Subagent-driven-development**    | Fresh agent per task                          | Build                                       | **Adopt for Build lanes**                                                                |
| **Verification-before-completion** | Evidence gate                                 | Ship claims                                 | **Adopt always**                                                                         |

**Insane difference:** Spec Kit _ritual_ does not beat a **REQ-ID → test → PR** chain enforced by agents. Constitution ≈ our doctrine + DIRECTION + Spec GC-*.

### 2.2 Unit & property testing (correctness)

| Tool                                                            | Use                                                                                 | Decision                                                                   |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **Vitest**                                                      | Default                                                                             | **Keep**                                                                   |
| **fast-check** (+ `@fast-check/vitest`)                         | Property tests: conservation, idempotency, decimal invariants, concurrent schedules | **Adopt for CX/DB money invariants** — high leverage vs hand examples only |
| **Hand-crafted scenario suites** (existing trade-service tests) | Regression + doctrine stories                                                       | **Keep as gold** — property tests **add**, not replace                     |
| **Conformance suites** (ledger-client)                          | Recipe conservation                                                                 | **Extend** for any new recipes (Denon carve-out)                           |

**Insane difference:** Property tests find double-release / float / ordering bugs that example tests miss.

### 2.3 Integration / assembled path (the usual failure)

| Tool                                                                                 | Use                         | Decision                                                                |
| ------------------------------------------------------------------------------------ | --------------------------- | ----------------------------------------------------------------------- |
| **`platform:up` + scripted scenarios**                                               | Real services, real NATS/PG | **Adopt as CX-8 primary**                                               |
| **In-process multi-service harness** (trade + matching + memory ledger + memory bus) | Fast CI subset of chaos     | **Adopt** as first chaos layer                                          |
| **Testcontainers** (PG/NATS)                                                         | Ephemeral real deps in CI   | **Adopt later** if compose flakes; not blocking if platform:up reliable |
| **Docker compose profiles**                                                          | Minimal order-path stack    | **Adopt** if full platform too heavy for local/CI runtime               |

**Insane difference:** Unit-green + assemble-red is the #1 professional shame. Spec already requires both levels.

### 2.4 Fault injection / chaos (stability under real money)

| Tool                                            | Use                                                     | Decision                                                       |
| ----------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------- |
| **Spec fault catalog F1–F8 as automated tests** | Steady state S; hypothesis; disprove                    | **Adopt first** (no SaaS needed)                               |
| **Toxiproxy**                                   | Latency, timeout, connection cut between trade↔matching | **Adopt when** HTTP transport faults need realism beyond mocks |
| **Chaos Toolkit / Litmus / Gremlin**            | Infra/K8s chaos                                         | **Reject for now** — overkill pre-go-live; no K8s prod story   |
| **Process kill / abort mid-handler** in tests   | Crash windows                                           | **Adopt** in harness (Node kill, thrown errors at seams)       |
| **JetStream redelivery simulation**             | At-least-once                                           | **Adopt** using existing bus test patterns                     |

**Insane difference:** Catalog-as-code beats “we ran Gremlin once.” Principles of Chaos: steady state → inject → look for drift.

### 2.5 Contract testing (service seams)

| Tool                                   | Use                         | Decision                                                                                        |
| -------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------- |
| **Pact (CDC)**                         | Consumer/provider contracts | **Defer** — high setup; we control both sides; **typed clients + integration tests** cover most |
| **OpenAPI / tRPC procedure contracts** | Explicit wire shapes        | **Strengthen** existing types + tests for matching client                                       |
| **Event catalog** (`packages/events`)  | Fill/cancel subjects        | **Treat as contract** — break CI if fill payload drifts                                         |

**Insane difference:** Event + client contracts matter more than full Pact in a single monorepo.

### 2.6 Dual-book / static money enforcement

| Tool                                            | Use                           | Decision                                    |
| ----------------------------------------------- | ----------------------------- | ------------------------------------------- |
| **Extend `vendor-shell-scan` + `custody-scan`** | Ban DAO mutators; walk Java   | **Adopt — top priority tool work**          |
| **Semgrep / CodeQL custom rules**               | Cross-language money patterns | **Adopt later** if scan scripts get fragile |
| **ripgrep inventory scripts**                   | One-time controller census    | **Adopt** for DB-2 inventory                |

**Insane difference:** Scans that fail CI beat another ADR paragraph. Denon already named this gap.

### 2.7 Performance / load (secondary for this program)

| Tool                                         | Use                             | Decision                                                               |
| -------------------------------------------- | ------------------------------- | ---------------------------------------------------------------------- |
| **k6 / Artillery**                           | Load on place/cancel            | **Defer** — stability & conservation first; latency vanity is non-goal |
| **Matching engine’s own determinism/replay** | Correctness under volume of ops | **Keep**                                                               |

### 2.8 Observability (operate rung)

| Tool                                   | Use                | Decision                                             |
| -------------------------------------- | ------------------ | ---------------------------------------------------- |
| Existing **tracing** hooks in services | Spans on money ops | **Use** in assembled proofs when present             |
| Full APM stack                         | Prod ops           | **Human §8 / later** — scoreboard before APM theater |

### 2.9 UI honesty (edge of program)

| Tool                    | Use                                               | Decision                                       |
| ----------------------- | ------------------------------------------------- | ---------------------------------------------- |
| **Playwright uiproof**  | Shell dual-book labels, routePreview not as price | **Adopt only for DX-9 / dual-book UI honesty** |
| Manual Orca screenshots | Nitro-facing                                      | When needed                                    |

---

## 3 · Workflows that change how we work (more than tools)

### W1 — REQ-driven ship loop (mandatory)

```
REQ-ID → failing test (or scan red) → minimal code → verify piece →
fresh adversarial (Class M) → PR → assembled re-check if path touched →
scoreboard update
```

No PR without REQ-IDs in body.

### W2 — Builder / Verifier / Reviewer separation (mandatory)

| Role     | Session       | Allowed                                        |
| -------- | ------------- | ---------------------------------------------- |
| Builder  | Worktree chat | Implement claimed tasks                        |
| Verifier | Fresh         | Run tests, platform path, report evidence only |
| Reviewer | Fresh         | Money/security/bloat — not “does test pass”    |

Same human chat only if **subagent** enforces role split.

### W3 — Walking skeleton first (mandatory sequencing)

Before large dual-book refactors _or_ in parallel with scan work:

1. Assembled place→hold→match→fill under F1–F4
2. Then hang dual-book / seed / multi-asset on a path we already walk

### W4 — Chaos as experiments, not vibes

For each fault F*:

1. Define steady state S (Spec)
2. Hypothesis: S holds
3. Inject F* in harness
4. Measure conservation / open-order consistency
5. Disproof = bugfix PR

### W5 — Dual-book enforcement workflow

1. Inventory Java money doors (script)
2. Disable at door
3. Scan-ban mutators
4. custody-scan Java
5. Fresh money review
6. ADR Accepted on main (#272)

### W6 — Professional CI (post-thrift)

- Heavy assemble/chaos: targeted jobs or local `platform:up` proof in PR body
- Path filters may skip full matrix on pure docs — but **merge of path-touching money PRs requires evidence**
- Docs-only paths stay paths-ignore friendly

### W7 — Scoreboard as operate artifact

Axes green/red/residual with proof links. Language “ready for real money” never without human X axes named.

---

## 4 · Recommended toolchain for THIS program (decision table)

### Tier A — start immediately (high delta, low ceremony)

| Item                                                           | Why               |
| -------------------------------------------------------------- | ----------------- |
| Spec REQ-IDs in every PR                                       | Contract          |
| Vitest chaos suite F1–F8 (in-process + matching client faults) | Stability proof   |
| Assembled script on `platform:up` or slim compose              | CX-8              |
| Extend vendor-shell-scan + custody-scan (Java)                 | Dual-book         |
| Fresh verify/review agents                                     | Blind-spot law    |
| fast-check on conservation / concurrent place                  | Property leverage |
| LIVE-LANES + worktrees                                         | Collision         |

### Tier B — when Tier A hits a wall

| Item                             | Trigger                        |
| -------------------------------- | ------------------------------ |
| Toxiproxy between trade↔matching | Mocks lie about timeouts       |
| Testcontainers PG/NATS           | CI can’t rely on shared docker |
| OpenSpec/Spec Kit install        | Agents ignore Spec docs        |
| Semgrep money rules              | Custom scans hard to maintain  |
| k6 smoke                         | After conservation green       |

### Tier C — reject for this program

| Item                       | Why                                  |
| -------------------------- | ------------------------------------ |
| Full BMAD install          | Ceremony > value; we can spawn roles |
| Gremlin/Litmus/prod chaos  | Wrong altitude pre-go-live           |
| Pact platform              | Monorepo overkill now                |
| HFT benchmark kits         | Non-goal                             |
| New matching engine        | Doctrine split already correct       |
| Card/PCI or invent execute | Out of Spec                          |

---

## 5 · How this changes the Plan (preview)

Plan tasks must include explicit **tooling tasks**, not only product:

1. T-TOOLS-1: chaos harness package/location + F1–F4 green
2. T-TOOLS-2: scan extensions for dual-book
3. T-TOOLS-3: assembled path script + CI/local how-to
4. T-TOOLS-4: fast-check properties for hold/fill idempotency
5. Then product REQs (DB-_, SD-_, …)

Professionals schedule **harness before mountain**.

---

## 6 · Mapping to Spec REQs (tools as first-class)

| Spec area | Primary tools/workflows                       |
| --------- | --------------------------------------------- |
| DB-*      | Scan extend, inventory script, Class M review |
| CX-1–6    | Existing vitest (guard)                       |
| CX-7–9    | Chaos harness, platform:up, reconcile tests   |
| DX-*      | Vitest quote suite, optional Playwright DX-9  |
| SD-*      | Seeder resume + volume tests                  |
| RS-*      | Scoreboard doc + WAVE-AUDIT                   |
| GC / LW   | Docs, #272, LIVE-LANES                        |

---

## 7 · Sources (landscape research)

- Principles of Chaos Engineering (steady state experiments)
- Spec-driven development tools 2026 (Spec Kit, OpenSpec, BMAD comparisons)
- fast-check / property-based testing for invariants
- Toxiproxy / Chaos Toolkit / Litmus / Gremlin (infra chaos spectrum)
- Pact consumer-driven contracts (monorepo trade-offs)
- Walking skeleton / assembled path practice
- Google design docs + SRE PRR mindset (readiness, not feature count)
- In-repo: vitest fleet, scans, platform:up, uiproof, doctrine gates

---

## 8 · Changelog

| When       | What                                        |
| ---------- | ------------------------------------------- |
| 2026-07-31 | Initial tools/workflows landscape for Frame |
