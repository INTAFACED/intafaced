# TRK-agents.merchant — research / spec pack

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Tracker id:** `agents.merchant`  
**Title:** Merchant agent — approval-rate watch  
**Module / phase:** `agents` · phase **5**  
**Status on tip:** `ready` · **owner:** none  
**Depends on:** `agents.gateway` (**done**) · `pay.routing` (**ready**, **owner shehzad002** M1 — babysit)  
**Tip freeze:** `origin/main` @ `083ef879` (re-derive before implement)  
**Pack type:** research only — no invent prices/pay rates; no ledger posts from agents; no `features.mjs` edit.
**Hard blocker:** pay routing product law is Shehzad M1 — agents babysit only for that lane.

---

## 1 · What “done” means (plain language)

1. Merchant agent runs with task `merchant.watch`.
2. Watches **approval-rate** (and related pay health) using real metrics — never invents approval rates.
3. Outputs are grounded, brand-safe, guardrailed; no money movement from agent.
4. Depends on honest `pay.routing` / pay surfaces for data — do not invent routing law under this id.
5. Escalation when rates breach thresholds (notify/ops) without auto-changing rails unless product law says so.

---

## 2 · Current code state (tip)

### Shared gateway spine (`agents.gateway` **done**)

| Area       | Path / fact                                                           |
| ---------- | --------------------------------------------------------------------- |
| Service    | `services/svc-agents`                                                 |
| Routing    | `src/gateway/routing.ts` — task → provider alias + price + capability |
| Guardrails | `src/fleet/guardrails.ts` (+ tests)                                   |
| Brand copy | `src/copy.ts` + `copy.test.ts` ban third-party names                  |
| Metering   | `src/metering/` — rates travel with route (decimal strings)           |
| Providers  | Model-agnostic; aliases never vendor names in user copy               |
| Readiness  | `readiness.ts` / `useful-path.ts` prove mock runnable paths           |

**Law:** Routing row ≠ full product. Agents name a **task**, never a model. Agents never `ledger.post`.

### Merchant-specific

| Area                       | Reality                                                          |
| -------------------------- | ---------------------------------------------------------------- |
| Task                       | `merchant.watch` in routing                                      |
| Full approval-rate product | **Residual**                                                     |
| `pay.routing`              | **ready** · **owner shehzad002** (M1 expand) — babysit implement |
| Invent risk                | Highest money-adjacent of agent fleet                            |

---

## 3 · Doctrine constraints

| Law                 | Implication                                                 |
| ------------------- | ----------------------------------------------------------- |
| Shehzad M1          | Do not invent pay routing / rail selection under this agent |
| No fabricated rates | Refuse when metrics unavailable                             |
| §0.6                | No ledger posts from agent                                  |
| §0.7 brand          | No acquirer partner names in user copy                      |
| Class M adjacent    | Any automation that changes money path needs audit          |
| No dual-edit        | Open pay PRs                                                |

---

## 4 · DoD sketch (checkable — staged)

### Stage 0 — dependency gate

- [ ] Re-derive pay.routing ownership and available metrics APIs.

### Stage 1 — watch on fixtures

- [ ] Task + fixture approval series.
- [ ] Threshold breach → structured alert (no rail change).

### Stage 2 — live metrics

- [ ] Read-only tools to pay metrics once APIs exist.
- [ ] Typed refusal when pay plane dark.

### Stage 3 — optional automation

- [ ] Only after product law: suggest vs act on routing — likely still human approve.

### Tracker `done` bar

Flip only when approval-rate watch is grounded on real pay metrics — not when routing task exists.

---

## 5 · Open questions

1. Which metrics define approval rate?
2. Thresholds product law?
3. Who receives alerts?
4. Ever auto-disable a rail?

---

## 6 · Gaps (named)

1. No live metrics tools.
2. Pay routing human-owned residual.
3. Alert sink residual.
4. Shell residual.
5. High invent temptation.

---

## 7 · Risks

| Risk                  | Why it hurts                         |
| --------------------- | ------------------------------------ |
| Invent approval rates | Wrong ops decisions                  |
| Agent changes rails   | Money incident / ownership violation |
| Partner names in copy | Brand gate                           |
| Dual-edit pay.routing | Ownership breach                     |

---

## 8 · Estimated size

| Slice                  | Size                       |
| ---------------------- | -------------------------- |
| Fixture watch          | **S–M**                    |
| Live after pay metrics | **M** (blocked on M1 data) |

**First implement PR (when free):** **S** — fixture path + hard refuse without metrics; no pay law invent.

---

## 9 · Related docs / code

- `gateway/routing.ts` `merchant.watch`
- Tracker `pay.routing` (shehzad002)
- `copy.ts`, `guardrails.ts`

---

## 10 · Explicit non-goals for this pack

- No inventing approval rates.
- No Shehzad pay.routing implement from this pack.
- No `features.mjs` edit.
