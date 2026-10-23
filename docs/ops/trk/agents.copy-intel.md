# TRK-agents.copy-intel — research / spec pack

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Tracker id:** `agents.copy-intel`  
**Title:** Copy-Intel — writes audited leader stats  
**Module / phase:** `agents` · phase **5**  
**Status on tip:** `ready` · **owner:** none  
**Depends on:** `agents.gateway` (**done**) · `trade.copy` (**ready**, **owner shehzad002** M4 — babysit)  
**Tip freeze:** `origin/main` @ `083ef879` (re-derive before implement)  
**Pack type:** research only — no invent prices/pay rates; no ledger posts from agents; no `features.mjs` edit.
**Hard blocker:** copy trading product is Shehzad M4 — agents must not invent copy product.

---

## 1 · What “done” means (plain language)

1. Copy-Intel agent produces **audited leader stats** for copy-trading surfaces.
2. Stats are grounded on real leader performance data — never invented PnL or fake win rates.
3. Writes go to audited stores with provenance; brand-safe presentation.
4. Depends on `trade.copy` product existence — babysit only while M4 human-owned.
5. No agent money movement; profit share remains trade/ledger recipes.

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

### Copy-intel-specific

| Area                 | Reality                                                |
| -------------------- | ------------------------------------------------------ |
| Dedicated task id    | Re-grep routing — may need new task when product lands |
| `trade.copy`         | **ready** · **owner shehzad002** (M4) — agents babysit |
| Leader stats product | **Residual** / blocked on copy product law             |
| Audited write path   | Residual                                               |

Note: default routing table emphasizes navigator/support/scanner/merchant/index.embed — copy-intel may need an explicit task row when implement starts.

---

## 3 · Doctrine constraints

| Law                 | Implication                                                    |
| ------------------- | -------------------------------------------------------------- |
| Shehzad M4          | Do not invent copy trading product under this id               |
| No fabricated stats | Refuse when leader data missing                                |
| §0.6                | Profit share via ledger recipes elsewhere — not agent balances |
| §0.7 brand          | No vendor names in intel copy                                  |
| Audit               | Stats writes must be reconstructable                           |
| No dual-edit        | Open trade.copy PRs                                            |

---

## 4 · DoD sketch (checkable — staged)

### Stage 0 — dependency gate

- [ ] Re-derive trade.copy ownership and available leader data APIs.

### Stage 1 — task + fixtures

- [ ] Add task route when product law ready.
- [ ] Fixture leader stats + audit log shape.
- [ ] Refuse invent path tests.

### Stage 2 — live intel

- [ ] Read leader performance from trade.copy surfaces.
- [ ] Write audited stats with provenance.
- [ ] Guardrails: no trade placement from intel agent.

### Stage 3 — product surface

- [ ] Consumer UI for leader cards uses audited stats only.

### Tracker `done` bar

Flip only when audited leader stats land from real copy data — not when gateway exists.

---

## 5 · Open questions

1. Which stats are mandatory (PnL, drawdown, tenure)?
2. Refresh cadence?
3. Who can be a leader (eligibility)?
4. Public vs follower-only visibility?

---

## 6 · Gaps (named)

1. trade.copy human-owned residual.
2. No copy-intel task productized.
3. No audited stats store.
4. No shell consumer.
5. High invent temptation on leaderboards.

---

## 7 · Risks

| Risk                       | Why it hurts                 |
| -------------------------- | ---------------------------- |
| Fake leader stats          | Users copy ghosts            |
| Agent invents copy product | Ownership + money law breach |
| Un-audited writes          | Dispute impossible           |
| Dual-edit M4 files         | Ownership violation          |

---

## 8 · Estimated size

| Slice              | Size                    |
| ------------------ | ----------------------- |
| Fixture + task     | **S–M** after M4 allows |
| Live audited intel | **M–L**                 |

**First implement PR (when free):** **S** — only after copy data API exists; fixture refuse-invent tests first.

---

## 9 · Related docs / code

- `services/svc-agents` gateway/fleet/copy
- Tracker `trade.copy` (shehzad002 M4)
- Ledger profit-share recipes (when exist)

---

## 10 · Explicit non-goals for this pack

- No inventing leader PnL.
- No Shehzad copy-trading implement from this pack.
- No `features.mjs` edit.
