# MEGA AUDIT — 2026-08-07 · Plan and scope

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Status:** COMPLETE — findings delivered, and the remediation ledger in §0a of the findings
document records which fixes have since landed on `main` and which are still open.
**Findings land in:** [`MEGA-AUDIT-2026-08-07-FINDINGS.md`](MEGA-AUDIT-2026-08-07-FINDINGS.md)

> **SCOPE CORRECTED MID-RUN — read this before the numbers below.**
> This plan was written against `0e46b7a3` (`docs/phase-b-v2-leverage-audit`), the branch in the
> main checkout. That branch turned out to be **203 commits behind `origin/main`** and to
> contribute **zero** commits to it. The run was stopped and restarted against the true tip
> `6a4a360a` (#971) in a clean worktree.
> **Every size, count and target in §2 below is therefore the OLD measurement** — kept as the
> record of what was planned. The corrected figures (742 source files, 270 test files, 27 gates,
> `vendor/upstream-exchange`, `+2` packages) are in **§0 of the findings document**, which is the
> live one.

This is a **code and systems** audit. It is deliberately not another methodology audit —
`BOARD-CLEAR-MEGA-AUDIT-2026-08-01.md` and `MULTI-AGENT-METHOD-AUDIT-2026-08-07.md` already
own process. This one goes at the software.

---

## 1 · The thesis

This repo has an unusually strong gate apparatus: **23 doctrine gates**, a mutation-tested
secret scanner, a skip-honesty scan, an event-wiring scan, a law-to-board coverage matrix.
Twenty-two of them are green.

That is exactly why re-running the gates is **not** where the value is. Every gate defines
its own blind spot by its scope. The value of a mega audit on a repo like this is finding
**what passes all 23 gates and is still wrong**.

So the audit has two halves:

- **Half A — the code**: money invariants, security, concurrency, failure modes, contracts.
- **Half B — the machine that judges the code**: do the gates catch what they claim, do the
  193 test files actually assert anything, does local `verify` match CI, do the docs match
  reality.

Half B is what a normal review never does, and it is where a false green light lives.

**Already proven by first contact:** the `brand` gate walks `.pnpm-store/`, `.tools/pnpm/store/`
and `.worktrees/` and reports **1215 false positives**, so `pnpm verify` is red locally for a
reason that does not exist in CI. That is the exact CI-vs-local drift `tooling/ci/gates.mjs`
was written to prevent, living inside the file that prevents it. It also means an agent who
runs the canonical command sees red and learns to route around it.

---

## 2 · The real surface (measured, not assumed)

| Layer                                                            | Size                          | Note                                           |
| ---------------------------------------------------------------- | ----------------------------- | ---------------------------------------------- |
| TypeScript source (`apps` + `packages` + `services` + `tooling`) | **600 files, ~146k LOC**      | the audited product                            |
| Real test files                                                  | **193**                       | `.test.ts`, vendor and `node_modules` excluded |
| Vendored exchange (`vendor/coinexchange`)                        | **895 Java + 162 Vue, 36 MB** | the sole product shell, third-party money code |
| Doctrine gates                                                   | **23**                        | `node tooling/ci/gates.mjs --list`             |
| Docs                                                             | **170 `.md`**                 | claim surface                                  |
| Live worktrees / local branches                                  | **14 / 373**                  | stranded-work surface                          |

**Per-workspace sizing (LOC · source files · test files)** — this is what drives target ranking:

| Workspace                    |   LOC | files | tests | Rank                                      |
| ---------------------------- | ----: | ----: | ----: | ----------------------------------------- |
| `services/svc-trade`         | 18211 |    78 |    34 | A                                         |
| `services/svc-pay`           | 15164 |    36 |    13 | A                                         |
| `services/svc-bank`          |  9707 |    22 | **3** | A — worst money-to-test ratio in the repo |
| `services/svc-protocol`      |  9698 |    45 |    19 | A (audit-only, Shehzad owns)              |
| `services/svc-agents`        |  6937 |    34 |    10 | C                                         |
| `services/svc-identity`      |  6326 |    22 |     7 | B                                         |
| `services/svc-indexer`       |  6204 |    27 |     9 | C                                         |
| `services/svc-p2p`           |  5603 |    17 |     6 | A                                         |
| `services/svc-ws`            |  5557 |    26 |    12 | B                                         |
| `services/svc-blueprint`     |  5671 |    24 |     8 | C                                         |
| `services/svc-notify`        |  5282 |    23 |     6 | C                                         |
| `services/svc-token`         |  5178 |    14 | **3** | A                                         |
| `packages/ledger-client`     |  5099 |    15 |     4 | A — the only value mover (§0.6)           |
| `packages/venue-adapter`     |  4570 |    18 |     6 | C                                         |
| `services/svc-edge`          |  4372 |    16 |     7 | B — the gateway                           |
| `apps/admin`                 |  4043 |    15 | **2** | B                                         |
| `services/svc-ledger`        |  3759 |    18 |     6 | A                                         |
| `services/svc-dex`           |  3473 |    17 |     5 | A (audit-only)                            |
| `services/svc-matching`      |  3367 |    11 | **3** | A — the matching engine                   |
| `packages/contracts`         |  3546 |    16 |     6 | C                                         |
| `services/svc-academy`       |  2858 |    22 |     7 | C                                         |
| `packages/config`            |  2648 |    13 |     6 | B — env + secrets                         |
| `packages/events`            |  2039 |     8 | **1** | C                                         |
| `packages/i18n`              |  1829 |     7 |     1 | C                                         |
| `packages/venue-contracts`   |  1382 |     9 |     1 | C                                         |
| `packages/db`                |  1179 |     7 | **1** | C                                         |
| `packages/exchange-contract` |   893 |     5 |     1 | C                                         |
| `packages/auth`              |   853 |     5 | **1** | B — authn primitives, one test file       |
| `packages/market-data`       |   802 |     5 |     2 | C                                         |
| `services/svc-support`       |   482 |     7 |     2 | C                                         |
| `packages/ui`                |   471 |     3 |     1 | C                                         |

Bolded test counts are the ones that make a service dangerous regardless of what the code says.

---

## 3 · Twelve lenses

Each lens is a distinct way to be wrong. They are assigned to targets deliberately — not as a
cross-product, because a uniform sweep over 600 files is the "wasted work" the brief forbids.

| #   | Lens                             | What it hunts                                                                                                                                                                                                                         |
| --- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1  | **Money invariants**             | conservation / double-entry, `number` used for money, decimal→bigint scaling, rounding direction and who eats the dust, negative balance, fee math, atomic settlement, replay and idempotency, §0.6 "no module holds its own balance" |
| L2  | **Security**                     | authn bypass, missing authz per route, IDOR, injection, SSRF, secret handling and logging, JWT/session, rate limits, admin surface, killswitch reachability                                                                           |
| L3  | **Concurrency & failure**        | races on shared state, transaction boundaries, partial writes, outbox/event dedupe, retry storms, unhandled rejections, swallowed `catch`, crash-consistency                                                                          |
| L4  | **Test efficacy**                | assertion-free tests, tautological asserts, mocks so deep the test passes with the implementation deleted, happy-path-only suites, disabled/conditionally-skipped coverage                                                            |
| L5  | **Gate efficacy (meta)**         | for each of the 23 gates: what it truly catches, what it provably cannot, whether it can be trivially bypassed, whether it runs the same locally and in CI                                                                            |
| L6  | **Contract drift**               | `packages/contracts` vs service implementations vs the vendored shell's expectations; the 32-event catalog vs actual emitters/consumers, including the 18 declared-but-unwired "recorded sockets"                                     |
| L7  | **Error handling / data loss**   | anywhere a failure silently loses a write, an event, or money                                                                                                                                                                         |
| L8  | **Dependencies & supply chain**  | known-vulnerable packages, unpinned or phantom deps, the Java dependency set in the vendored exchange                                                                                                                                 |
| L9  | **Docs truth**                   | 170 docs vs code reality — every load-bearing claim re-derived or marked stale                                                                                                                                                        |
| L10 | **Dead code & over-engineering** | unreachable code, abstractions with one implementation, deletion candidates                                                                                                                                                           |
| L11 | **Performance**                  | N+1 queries, O(n²) in hot paths, unbounded memory or result sets, missing indexes                                                                                                                                                     |
| L12 | **Vendored exchange (Java/Vue)** | the 895 Java files that move real money, the dual-book door, hardcoded credentials and defaults typical of this fork lineage                                                                                                          |

---

## 4 · Execution shape

**Phase 0 — baseline, run by the lead (done / in flight).** Every machine-state claim in this
audit is RAN-IT, not quoted from a doc.

- `node tooling/ci/gates.mjs` → 22/23 green, `brand` red (see §1)
- full `turbo run typecheck --continue`
- full `turbo run test --continue`
- toolchain: node v26.3.1, repo-local pnpm 10.25.0 at `.tools/bin/pnpm`, **Docker not running**
  → integration suites that need Postgres are out of reach this session and are reported as
  _not run_, never as passing.

**Phase 1 — FIND.** Parallel deep readers, one per (target × lens) pair, each returning
structured findings with file, line, mechanism, and a concrete failure scenario. No agent is
allowed to report a finding it cannot anchor to a line.

**Phase 2 — REFUTE.** Every finding goes to independent adversarial verifiers whose brief is
to **kill it**, defaulting to "refuted" under uncertainty. Critical and high findings get three
verifiers with different lenses (correctness / does-it-actually-reproduce / is-it-already-guarded).
This is the step that keeps hallucinated findings away from Nitro.

**Phase 3 — LEAD REVIEW.** Money and security findings that survive are re-read personally by
the lead agent against the source, not delegated. Safety-critical diff review is never a
subagent's call.

**Phase 4 — SYNTHESIS.** One ranked remediation ledger: severity, blast radius, the fix, and
the cheapest check that would have caught it.

## 5 · Model routing (stated before the spend)

| Stage                                                                        | Model               | Effort | Why                                                            |
| ---------------------------------------------------------------------------- | ------------------- | ------ | -------------------------------------------------------------- |
| Scoping and decomposition                                                    | Opus (lead, inline) | high   | shapes the whole run                                           |
| L1/L2/L3/L5/L12 finders — money, security, concurrency, gates, vendored Java | Opus                | high   | judgment work; a missed money bug is the whole point           |
| L4/L6/L7/L11 finders — tests, contracts, error paths, perf                   | Opus                | medium | still judgment, narrower blast radius                          |
| L8/L9/L10 finders — deps, docs truth, dead code                              | Sonnet              | medium | mechanical, verifiable by grep                                 |
| Adversarial refuters                                                         | Opus                | high   | where false findings die; downgrading here defeats the purpose |
| Synthesis and ranking                                                        | Opus (lead, inline) | high   | Nitro reads this one                                           |

## 6 · Guardrails held throughout

- **Read-only.** No source file is edited, nothing is committed, nothing is pushed. The output
  is findings plus prescriptions. Fixes are a separate green light.
- **No work on Shehzad chain mountains** — `svc-protocol`, `svc-dex`, INTACHAIN are audited and
  reported, never implemented.
- The working tree is dirty and shared; the audit does not touch it.
- Anything not actually executed is labelled **not run**, never inferred green.
