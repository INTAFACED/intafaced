# Frame research beat v2 — tools, repos, workflows (all-out)

**Status:** FRAME RESEARCH · supersedes v1 landscape for completeness  
**Date:** 2026-07-31  
**How researched:** GitHub star-ranked discovery (`gh search` + direct `repos/` API) · last30days multi-source (Reddit/X/HN/GitHub/TikTok, Jul 2026 window) · prior domain archaeology · industry SDD comparisons  
**Program:** Order-route / DEX–CEX money-path harden  
**Parents:** Frame methodology · Spec v1 · domain inventory

**v1 failure this fixes:** thin general lists without star-ranked repos, without last-30-days community signal, without financial-correctness (Jepsen/TigerBeetle-class) leverage, without clear “steal pattern vs install” decisions.

---

## 0 · Peace-of-mind verdict

| Question                                                | Answer                                                                                                                                                   |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Did we miss the dominant 2026 professional agent stack? | **No longer.** Spec Kit (~125k★) · OpenSpec (~63k★) · BMAD (~51k★) are the live SDD triad; community actively rejects pure vibe coding for serious work. |
| Do we need to install all three?                        | **No.** Steal **patterns**; our Spec+Frame+doctrine already maps. Optional thin install only if agents thrash.                                           |
| Highest _missed_ correctness leverage?                  | **Jepsen-class thinking** + TigerBeetle **DST** (deterministic simulation) + property+fault combos — not another matching engine.                        |
| Highest _missed_ network-fault leverage?                | **Toxiproxy** (12k★) for trade↔matching timeouts (Tier B).                                                                                               |
| Replace our ledger with TigerBeetle/Formance?           | **No** — doctrine owns ledger-client. **Study** their testing bar and transfer patterns.                                                                 |
| Still vibe-coder risk?                                  | Only if we ship without REQ→test→fresh verify and without assembled+chaos tiers.                                                                         |

---

## 1 · Last 30 days (community) — what professionals are doing

**Engine run (2026-07):** multi-source corpus on “spec driven development / Spec Kit / OpenSpec / BMAD” (Reddit ~19 threads, X ~28, HN ~16, TikTok viral SDD clips, GitHub activity). Themes:

1. **“Stop vibe coding” is mainstream messaging** for serious agent work (X threads citing SDD / Spec Kit as the alternative to prompt-and-pray).
2. **GitHub Spec Kit** framed as the default “constitution → specify → plan → tasks → implement” toolkit; star counts in community posts cited 90k+ (API now **~125k**).
3. **r/SpecDrivenDevelopment + coding-agent communities + r/AI_Agents** are active discussion homes — SDD is a _community_, not a blog fad.
4. **Brownfield preference:** independent comparisons (mid-2026) often rank **OpenSpec** high for delta/change management on existing codebases; **BMAD** for complex greenfield/enterprise with high ceremony cost; **Spec Kit** for team standardization + constitution.
5. Community consensus we adopt: **plan before code**; agents fail fastest on fuzzy briefs; combine light exploration with hard Spec once design is clear.

**Implication for us:** Our Spec v1 + Frame method is **aligned with 2026 professional consensus**. Missing piece was not “another idea” — it was **enforcing** Spec as executable contract + chaos/DST-grade proof.

---

## 2 · Star-ranked GitHub map (live API / search, 2026-07-31)

### 2.1 Spec / agent workflow (how we _build_)

| Repo                                                                      | ~★          | Role                                                       | Decision for this program                                                                       |
| ------------------------------------------------------------------------- | ----------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| [github/spec-kit](https://github.com/github/spec-kit)                     | **124,694** | SDD toolkit: constitution, specify, plan, tasks, implement | **Steal workflow.** Optional install later. Our constitution = doctrine + DIRECTION + Spec GC-* |
| [Fission-AI/OpenSpec](https://github.com/Fission-AI/OpenSpec)             | **63,245**  | Delta specs; proposal→apply→archive; brownfield            | **Steal delta model** for residual REQs. Best fit to _our_ brownfield money harden              |
| [bmad-code-org/BMAD-METHOD](https://github.com/bmad-code-org/BMAD-METHOD) | **51,317**  | 21+ role agents, enterprise ceremony                       | **Reject full install.** Steal **role separation** (BA/Arch/Dev/QA) as subagents                |
| [Priivacy-ai/spec-kitty](https://github.com/Priivacy-ai/spec-kitty)       | **1,454**   | Spec-kit fork + **git worktree** orchestration             | **Study** — we already have `pnpm wt`; align Plan to worktree-per-task                          |
| [cameronsjo/spec-compare](https://github.com/cameronsjo/spec-compare)     | research    | 6-tool SDD comparison                                      | **Read** for decision frameworks                                                                |
| [rihebty/flow-kit](https://github.com/rihebty/flow-kit)                   | fusion      | Combines BMAD/spec-kit/OpenSpec/superpowers                | **Optional skim** — don’t adopt mashup blindly                                                  |

### 2.2 Financial correctness & ledgers (how we _prove money_)

| Repo                                                                                            | ~★         | Role                                                               | Decision                                                                               |
| ----------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| [tigerbeetle/tigerbeetle](https://github.com/tigerbeetle/tigerbeetle)                           | **16,687** | Mission-critical financial transactions DB; **Jepsen-tested**      | **Do not replace ledger.** **Steal:** DST mindset, fault models, bank-test seriousness |
| [jepsen-io/jepsen](https://github.com/jepsen-io/jepsen)                                         | **7,453**  | Distributed systems verification + fault injection + **bank test** | **Steal methodology** for CX chaos catalog design (not full Jepsen cluster day-1)      |
| [jepsen-io/maelstrom](https://github.com/jepsen-io/maelstrom)                                   | **3,645**  | Workbench for distributed algorithm tests                          | **Study** for agent education / future                                                 |
| [asatarin/testing-distributed-systems](https://github.com/asatarin/testing-distributed-systems) | **2,630**  | Curated testing resources                                          | **Read list** when designing chaos harness                                             |
| [formancehq/ledger](https://github.com/formancehq/ledger)                                       | **1,325**  | Programmable open-source fintech ledger                            | **Study** recipes/programmability patterns — not a swap                                |
| [pgr0ss/pgledger](https://github.com/pgr0ss/pgledger)                                           | **480**    | Double-entry in Postgres                                           | Compare only                                                                           |
| **Our** `packages/ledger-client`                                                                | —          | Doctrine ledger                                                    | **SoT for money**                                                                      |

### 2.3 Matching / exchange / market sim (domain terrain)

| Repo                                                                                    | ~★         | Role                                        | Decision                                                                                       |
| --------------------------------------------------------------------------------------- | ---------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| [exchange-core/exchange-core](https://github.com/exchange-core/exchange-core)           | **2,585**  | LMAX-style Java matching + journal/snapshot | **Study** journal/snapshot — we already implement doctrine split                               |
| [enewhuis/liquibook](https://github.com/enewhuis/liquibook)                             | **1,489**  | C++ matching                                | Study only                                                                                     |
| [chronoxor/CppTrader](https://github.com/chronoxor/CppTrader)                           | **1,059**  | Trading platform components                 | Study only                                                                                     |
| [nkaz001/hftbacktest](https://github.com/nkaz001/hftbacktest)                           | **4,300+** | HFT/MM backtest with latency realism        | **Optional** seed/mm research — not CEX path core                                              |
| [ccxt/ccxt](https://github.com/ccxt/ccxt)                                               | **43,451** | Unified exchange API                        | **Hard ban on money path** (JS numbers / doctrine §27) — venue-adapter pattern already correct |
| [jammy928/CoinExchange_…](https://github.com/jammy928/CoinExchange_CryptoExchange_Java) | **1,717**  | Vendored Java exchange                      | **Dual-book target** — enforce Option B, don’t rebuild                                         |

### 2.4 Chaos / fault injection / network

| Repo                                                                                          | ~★         | Role                             | Decision                                            |
| --------------------------------------------------------------------------------------------- | ---------- | -------------------------------- | --------------------------------------------------- |
| [Shopify/toxiproxy](https://github.com/Shopify/toxiproxy)                                     | **12,205** | TCP proxy: latency, timeout, cut | **Tier B — adopt when mocks lie** on trade↔matching |
| [chaos-mesh/chaos-mesh](https://github.com/chaos-mesh/chaos-mesh)                             | **7,820**  | K8s chaos platform               | **Reject now** (no K8s prod story)                  |
| [chaosblade-io/chaosblade](https://github.com/chaosblade-io/chaosblade)                       | **6,454**  | Chaos experiment toolkit         | Defer                                               |
| [dastergon/awesome-chaos-engineering](https://github.com/dastergon/awesome-chaos-engineering) | **6,628**  | Curated chaos list               | **Bookmark**                                        |
| [litmuschaos/litmus](https://github.com/litmuschaos/litmus)                                   | **5,563**  | Cloud-native chaos               | Defer                                               |
| [chaostoolkit/chaostoolkit](https://github.com/chaostoolkit/chaostoolkit)                     | **2,015**  | Scriptable chaos experiments     | **Optional** experiment YAML later                  |
| [Polly-Contrib/Simmy](https://github.com/Polly-Contrib/Simmy)                                 | **589**    | App-level fault injection        | Pattern only (JS ecosystem different)               |

### 2.5 Property tests, containers, messaging, static analysis

| Repo                                                                                        | ~★              | Role                             | Decision                                         |
| ------------------------------------------------------------------------------------------- | --------------- | -------------------------------- | ------------------------------------------------ |
| [dubzzz/fast-check](https://github.com/dubzzz/fast-check)                                   | **5,082**       | Property-based testing for JS/TS | **Tier A — adopt** for conservation/concurrency  |
| [testcontainers/testcontainers-node](https://github.com/testcontainers/testcontainers-node) | **2,578**       | Ephemeral Docker deps in tests   | **Tier B** if compose flaky                      |
| [nats-io/nats-server](https://github.com/nats-io/nats-server)                               | **20,366**      | NATS (we already use JetStream)  | **Keep**; test redelivery with real bus          |
| [semgrep/semgrep](https://github.com/semgrep/semgrep)                                       | **16,061**      | Lightweight SAST / custom rules  | **Tier B** for dual-book if custom scans creak   |
| [resilience4j/resilience4j](https://github.com/resilience4j/resilience4j)                   | **10,722**      | Java fault tolerance             | Pattern for retries/circuit — TS ports carefully |
| Microsoft Playwright                                                                        | already in repo | UI proof                         | **Use for DX-9 / dual-book UI only**             |

### 2.6 Mutation testing (professional bar often skipped)

| Tool                         | Role                                  | Decision                                                               |
| ---------------------------- | ------------------------------------- | ---------------------------------------------------------------------- |
| **Stryker** (JS/TS mutation) | Kill surviving mutants in money tests | **Tier B after** chaos suite exists — proves tests actually catch bugs |

---

## 3 · What professionals do that vibe coders skip (workflows)

| #   | Workflow                                 | Source of practice                      | Our enforcement                             |
| --- | ---------------------------------------- | --------------------------------------- | ------------------------------------------- |
| W1  | **Spec/constitution before code**        | Spec Kit / OpenSpec / last30d community | Spec v1 REQ-IDs on every PR                 |
| W2  | **Delta specs for brownfield**           | OpenSpec                                | Spec changelog + residual REQs              |
| W3  | **Role-separated agents**                | BMAD roles / doubt-driven               | Builder ≠ Verifier ≠ Reviewer               |
| W4  | **Property tests for invariants**        | fast-check, TigerBeetle DST culture     | Conservation, idempotency, concurrent place |
| W5  | **Fault injection against steady state** | Chaos principles, Jepsen bank tests     | Spec F1–F8 as automated experiments         |
| W6  | **Assembled path, not unit-only**        | Walking skeleton, SRE PRR mindset       | `platform:up` / slim compose CX-8           |
| W7  | **Network realism when needed**          | Toxiproxy                               | Timeout between trade↔matching              |
| W8  | **Static bans on second book**           | Our scans + Semgrep pattern             | Java custody + DAO mutator bans             |
| W9  | **Worktree isolation**                   | Spec Kitty / our `pnpm wt`              | Mandatory Build lanes                       |
| W10 | **Evidence or not done**                 | verification-before-completion          | Fresh verify agent                          |

---

## 4 · Tier decisions (final for Plan)

### Tier A — start immediately (max delta / min ceremony)

1. **REQ-driven PR law** (Spec v1)
2. **Chaos harness** implementing Spec F1–F8 (in-process + matching client faults first)
3. **Assembled order-path script** on existing compose
4. **Extend `vendor-shell-scan` + `custody-scan` (Java)**
5. **fast-check** properties for hold/fill/idempotency/decimals
6. **Fresh verify/review agents** every Class M
7. **OpenSpec-style delta notes** when Spec amends
8. **LIVE-LANES + worktrees**

### Tier B — when Tier A hits a wall

| Tool                                 | Trigger                                        |
| ------------------------------------ | ---------------------------------------------- |
| **Toxiproxy**                        | Need real TCP timeout/partition trade↔matching |
| **testcontainers-node**              | CI cannot depend on shared docker compose      |
| **Spec Kit or OpenSpec CLI install** | Agents ignore Spec docs repeatedly             |
| **Semgrep money rules**              | Scan scripts unmaintainable                    |
| **Stryker mutation**                 | Want proof suite quality                       |
| **Chaos Toolkit YAML**               | Want reusable experiment defs                  |
| **hftbacktest**                      | Seed/mm research only                          |

### Tier C — reject for this program

| Item                                              | Why                                              |
| ------------------------------------------------- | ------------------------------------------------ |
| Replace matching with exchange-core / HFT engines | Doctrine split already correct; latency non-goal |
| Replace ledger with TigerBeetle/Formance          | Doctrine §0.6 ledger-client SoT                  |
| CCXT in money path                                | Floats + doctrine ban                            |
| Full BMAD install                                 | Ceremony tax; steal roles only                   |
| Chaos Mesh / Litmus / Gremlin prod                | No K8s go-live; blast radius wrong               |
| Full Jepsen multi-node day-1                      | Steal _tests design_; infra cost later           |
| Pact platform day-1                               | Monorepo + typed clients first                   |

---

## 5 · Steal-without-install playbook (highest leverage)

### From TigerBeetle / Jepsen

- Define **operations** (place, cancel, fill, redelivery) and **invariants** (conservation, no double spend).
- Inject **faults** (crash, partition, redelivery) and **disprove** safety.
- Prefer **deterministic simulation** of schedules over flaky sleep tests.

### From Spec Kit

- Project **constitution** (we have it as law docs).
- Force **specify → plan → tasks → implement** altitude.

### From OpenSpec

- **Delta-only** changes for brownfield dual-book / chaos / seed slices.
- Archive completed deltas into living Spec.

### From BMAD

- Named adversarial roles as **fresh subagents**, not a 21-agent framework.

### From Toxiproxy + our suite

- After unit chaos is green, inject **real** network failure between services.

### From exchange-core

- Journal-before-process + snapshot cadence — **audit ours against** their model, don’t port Java.

---

## 6 · Mapping tools → Spec REQs (nothing orphaned)

| Spec cluster                    | Primary leverage                                                 |
| ------------------------------- | ---------------------------------------------------------------- |
| DB-* dual-book                  | Scan extend, Semgrep later, inventory scripts                    |
| CX-1–6                          | Existing vitest (guard regressions)                              |
| CX-7–9 chaos/assemble/reconcile | Custom harness + Jepsen-inspired ops · platform:up · Toxiproxy B |
| DX-*                            | Vitest quote · Playwright only honesty                           |
| SD-*                            | Seeder resume · volume tests · optional hftbacktest study        |
| RS-* scoreboard                 | Doc + WAVE-AUDIT                                                 |
| Process                         | Spec Kit/OpenSpec _patterns_ · BMAD _roles_ · doubt-driven       |

---

## 7 · Explicit “we are not missing”

| Category                         | Covered? | Notes                       |
| -------------------------------- | -------- | --------------------------- |
| 2026 SDD mega-repos              | Yes      | Spec Kit / OpenSpec / BMAD  |
| last30days community             | Yes      | SDD vs vibe coding wave     |
| Financial DB correctness culture | Yes      | TigerBeetle + Jepsen        |
| Chaos tooling spectrum           | Yes      | App → TCP → K8s tiers       |
| Property testing                 | Yes      | fast-check                  |
| Integration containers           | Yes      | testcontainers-node         |
| Static money enforcement         | Yes      | scans + Semgrep path        |
| Matching engines                 | Yes      | study-not-replace           |
| Exchange connectivity            | Yes      | CCXT ban confirmed          |
| Mutation testing                 | Yes      | Tier B Stryker              |
| Agent worktrees                  | Yes      | Spec Kitty pattern + our wt |
| Distributed testing curriculum   | Yes      | asatarin + maelstrom        |

**Residual research debt (honest, small):**

- One dedicated last30days pass on “Jepsen bank test / distributed ledger testing” for more community war stories (optional).
- Deep read of Jepsen bank.clj patterns when implementing F5–F8 (Plan task, not Frame block).

---

## 8 · How this upgrades Plan (must include)

Plan **must** open with tooling spines:

1. **T0** — Chaos harness skeleton + F1–F4 green
2. **T1** — Scan Java + mutator bans (dual-book tooling)
3. **T2** — Assembled path runner doc+script
4. **T3** — fast-check properties package
5. Then product mountains (DB, seed, multi-asset…)
6. Tier B hooks named as optional exit ramps

---

## 9 · Research method log (audit trail)

| Method                                 | Result                                                                                  |
| -------------------------------------- | --------------------------------------------------------------------------------------- |
| last30days SDD/Spec Kit (multi-source) | Completed; save path /tmp; SDD vs vibe coding dominant                                  |
| `gh search repos` multi-query          | matching-engine, chaos, ledger, toxiproxy, fast-check, jepsen, etc.                     |
| `gh api repos/{name}` star counts      | Spec Kit 124694 · OpenSpec 63245 · BMAD 51317 · TigerBeetle 16687 · Toxiproxy 12205 · … |
| Web SDD comparisons 2026               | OpenSpec strong brownfield; BMAD heavy; Spec Kit standardizing                          |
| TigerBeetle Jepsen analysis            | Steal DST + fault model, not DB                                                         |
| In-repo inventory                      | verify, vitest, scans, platform:up, uiproof                                             |

---

## 10 · Changelog

| When       | What                                                                                      |
| ---------- | ----------------------------------------------------------------------------------------- |
| 2026-07-31 | v2 all-out landscape: last30days + star map + financial correctness tier + steal playbook |
| Earlier    | v1 thinner landscape — superseded for completeness                                        |

**v1 file remains historical:** `ORDER-ROUTE-TOOLS-WORKFLOWS-LANDSCAPE-2026-07-31.md` — prefer **this v2**.
