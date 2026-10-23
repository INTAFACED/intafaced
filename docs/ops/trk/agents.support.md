# TRK-agents.support — research / spec pack

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Tracker id:** `agents.support`  
**Title:** Support agent — KB + account-state grounded  
**Module / phase:** `agents` · phase **5**  
**Status on tip:** `ready` · **owner:** none  
**Depends on:** `agents.gateway` (**done**)  
**Tip freeze:** `origin/main` @ `083ef879` (re-derive before implement)  
**Pack type:** research only — no invent prices/pay rates; no ledger posts from agents; no `features.mjs` edit.
**Soft dep:** `ops.support` KB + read-only account projections before production grounding.

---

## 1 · What “done” means (plain language)

1. Support agent runs on gateway with tasks `support.reply` and `support.classify`.
2. Answers are grounded in **KB + read-only account state** — not invented balances or policy.
3. Brand-safe copy; guardrails refuse unsafe tools (no refund money posts).
4. Human desk (`ops.support`) works **without** this agent; agent is assist layer.
5. Escalation to human ticket is first-class.

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

### Support-specific

| Area                    | Reality                                                        |
| ----------------------- | -------------------------------------------------------------- |
| Tasks                   | `support.reply`, `support.classify` in routing table           |
| Readiness / useful-path | May use `support.classify` as useful-path task when configured |
| KB product              | **`ops.support` residual** — no desk/KB yet                    |
| Account-state tools     | Residual (read contracts only when built)                      |
| Desk independence       | Human desk must not require agent                              |

---

## 3 · Doctrine constraints

| Law                       | Implication                                 |
| ------------------------- | ------------------------------------------- |
| §0.7 brand                | No vendor/model names in replies            |
| §0.6                      | Never post ledger; no invent refund amounts |
| Guardrails                | No money tools without product law          |
| PII                       | Minimize account fields exposed to model    |
| Order vs support “ticket” | Do not confuse trading order tickets        |
| No dual-edit              | Open agents / support PRs                   |

---

## 4 · DoD sketch (checkable — staged)

### Stage 1 — classify/reply on mock

- [ ] Tasks routed + tested (partially true).
- [ ] Copy catalogue for support refusals.
- [ ] Guardrail: refuse money tools.

### Stage 2 — grounding

- [ ] KB tool after `ops.support` Stage 1+.
- [ ] Read-only account projection tool.
- [ ] Typed “I don’t know / escalate” path.

### Stage 3 — production assist

- [ ] Operator review of agent drafts optional.
- [ ] Metering + quality metrics.

### Tracker `done` bar

Flip only when grounded on KB + account reads in real env — routing names alone are not the desk product (see `ops.support`).

---

## 5 · Open questions

1. When can agent draft without human approve?
2. Which account fields are allowed?
3. Multi-language KB?
4. Metering who pays (user tier vs house)?

---

## 6 · Gaps (named)

1. No ops.support KB yet.
2. No account-state tools.
3. No escalation product wire.
4. Full grounded reply residual.
5. Confusion with ops.support mountain.

---

## 7 · Risks

| Risk                    | Why it hurts     |
| ----------------------- | ---------------- |
| Invent refund amounts   | Fabricated money |
| Claim agent = desk done | No human queue   |
| PII over-exposure       | Privacy incident |
| Vendor names in replies | Brand gate       |

---

## 8 · Estimated size

| Slice                      | Size    |
| -------------------------- | ------- |
| Mock task polish           | **S**   |
| Grounded after ops.support | **M–L** |

**First implement PR (when free):** **S** — refuse-money guardrail tests; wait on KB for grounding.

---

## 9 · Related docs / code

- `gateway/routing.ts` support tasks
- `docs/ops/trk/ops.support.md`
- `copy.ts`, `guardrails.ts`

---

## 10 · Explicit non-goals for this pack

- No inventing refund ledger recipes.
- No replacing human desk.
- No `features.mjs` edit.
