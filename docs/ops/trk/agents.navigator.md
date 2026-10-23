# TRK-agents.navigator — research / spec pack

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Tracker id:** `agents.navigator`  
**Title:** Navigator — tool-calling inside user guardrails  
**Module / phase:** `agents` · phase **5**  
**Status on tip:** `ready` · **owner:** none  
**Depends on:** `agents.gateway` (**done**)  
**Tip freeze:** `origin/main` @ `083ef879` (re-derive before implement)  
**Pack type:** research only — no invent prices/pay rates; no ledger posts from agents; no `features.mjs` edit.

---

## 1 · What “done” means (plain language)

1. Navigator agent product runs on the gateway with tasks `navigator.plan` and `navigator.tool_select`.
2. Outputs are **grounded** (tools + allowlisted data), brand-safe, **guardrailed**.
3. Tool allowlist is product law; out-of-policy tool use is refused.
4. No balances; no ledger posts; side effects only via existing APIs with user scopes.
5. Users can escalate to human support when navigator cannot act safely.

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

### Navigator-specific

| Area                      | Reality                                                   |
| ------------------------- | --------------------------------------------------------- |
| Tasks in default table    | `navigator.plan`, `navigator.tool_select` **present**     |
| useful-path default       | Often starts at `navigator.plan` when capability complete |
| Full tool-calling product | **Residual** — routing ≠ grounded planner product         |
| User-facing shell surface | Residual                                                  |
| Tool allowlist v1         | Open question / product law                               |

---

## 3 · Doctrine constraints

| Law              | Implication                                     |
| ---------------- | ----------------------------------------------- |
| §0.7 brand       | No vendor model names in user-facing agent copy |
| §0.6             | Agents never `ledger.post`                      |
| Guardrails       | Refuse out-of-policy tool use                   |
| Metering honesty | Bill reconstructable from route price           |
| No dual-edit     | Open svc-agents gateway PRs                     |

---

## 4 · DoD sketch (checkable — staged)

### Stage 1 — task + guardrails

- [ ] Named tasks in routing + readiness (largely true).
- [ ] Guardrail tests for navigator tool set.
- [ ] Copy keys only from catalogue.

### Stage 2 — grounded tools

- [ ] Real data tools with typed refusals.
- [ ] Audit log of user-affecting actions.
- [ ] Tier/gating per product law.

### Stage 3 — product surface

- [ ] Shell entry; human escalation path.

### Tracker `done` bar

Flip only when tool-calling navigator is grounded in real env — mock route alone is not done.

---

## 5 · Open questions

1. v1 tool allowlist.
2. Human escalation path.
3. Metering / cost attribution UX.
4. Blueprint guardrail integration depth.

---

## 6 · Gaps (named)

1. Product tool implementations residual.
2. Shell UX residual.
3. Escalation residual.
4. Audit product residual.
5. Allowlist unsigned.

---

## 7 · Risks

| Risk                       | Why it hurts            |
| -------------------------- | ----------------------- |
| Unbounded tools            | Unexpected side effects |
| Vendor names in copy       | Brand gate              |
| Silent fallback task       | Wrong billing           |
| Claiming routing = product | Tracker lie             |

---

## 8 · Estimated size

| Slice                 | Size                     |
| --------------------- | ------------------------ |
| Task + tests on mock  | **S–M** (mostly shipped) |
| Full grounded product | **M–L**                  |

**First implement PR (when free):** **S–M** — first real read-only tool + guardrail tests.

---

## 9 · Related docs / code

- `services/svc-agents/src/gateway/routing.ts`
- `fleet/guardrails.ts`, `copy.ts`, `metering/`
- `agents.gateway` tracker note

---

## 10 · Explicit non-goals for this pack

- No inventing prices.
- No money movement from navigator.
- No `features.mjs` edit.
