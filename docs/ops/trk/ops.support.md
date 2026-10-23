# TRK-ops.support — research / spec pack

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Tracker id:** `ops.support`  
**Title:** Support desk, tickets, KB  
**Module / phase:** `core-ops` · phase **5** · plane F  
**Status on tip:** `ready` · **owner:** none  
**Depends on:** `identity.accounts` (**done**)  
**Tip freeze:** `origin/main` @ `083ef879` (re-derive before implement)  
**Pack type:** research only — no inventing refund ledger recipes; no `features.mjs` edit.

---

## 1 · What “done” means (plain language)

1. A user can **open a support ticket** (authenticated) with category + body.
2. An operator can **list, assign, comment, resolve** without holding or moving balances.
3. Both can search a **KB of our articles** (i18n-keyed; no third-party product names in user copy).
4. Account-state for support is **read-only** identity/ledger projections — never a second balance store.
5. Refunds/chargebacks are **requests** only; money only via existing pay/ledger recipes elsewhere.
6. Human desk works **without** `agents.support` (agent optional later).

---

## 2 · Current code state (tip)

### 2.1 Service / UI absence

| Area                   | Reality                                                                 |
| ---------------------- | ----------------------------------------------------------------------- |
| `services/svc-support` | **Exists** — Stage-1 in-memory ticket spine + Stage-2 KB/operator queue |
| UI desk routes         | No support-ticket product in `apps/web` / `apps/admin`                  |
| KB catalog             | Platform i18n-keyed spine in `svc-support` (`kb-catalog.ts`)            |
| Doctrine home          | core-ops phase 5 / plane F (§8.8 support desk)                          |

### 2.2 Agents naming collision (not a desk)

| Area                  | Reality                                                          |
| --------------------- | ---------------------------------------------------------------- |
| `services/svc-agents` | Tasks `support.reply` / `support.classify` are **routing names** |
| Tests                 | readiness / useful-path may default to `support.classify`        |
| Meaning               | Gateway runtime capability — **not** ticket storage or KB        |

### 2.3 Incidental “ticket” strings

Trading UI “ticket” means **order ticket**, not support ticket — do not grep-merge them.

### 2.4 Related surfaces

| Surface                 | Relation                                                                |
| ----------------------- | ----------------------------------------------------------------------- |
| `ops.admin`             | Operator console SoT for staff tools; support queue may live here later |
| `ops.notifications`     | User notify on ticket updates (optional later)                          |
| `identity.accounts`     | Auth dependency **done**                                                |
| Pay chargeback / refund | Money recipes stay in pay/ledger — support files requests only          |

---

## 3 · Doctrine constraints

| Law                 | Implication                                                        |
| ------------------- | ------------------------------------------------------------------ |
| §0.6                | Support never posts ledger entries; no balances on ticket rows     |
| Fabricated money    | Never invent refund amounts into ledger                            |
| Brand / vendor scan | KB + agent copy: no partner/model vendor names in user-facing text |
| PII / Class X       | What support may see needs ops law; retention                      |
| One service per PR  | Contracts/events first if cross-service                            |
| Agent optional      | Desk must work offline of agents                                   |
| No dual-edit        | Open admin / identity PRs as needed                                |

---

## 4 · DoD sketch (checkable — staged)

### Stage 1 — ticket spine (no money)

- [x] `packages/contracts` (+ events if needed): ticket create/list/comment/status + empty KB list.
- [x] Thin `svc-support` (or documented home service) + schema + auth tests.
- [x] No UI required for Stage 1 merge.

### Stage 2 — operator queue

- [x] Operator queue staff API on `svc-support` (`listQueue` / `next` / `claim`) — exclusive claim, no money.
- [ ] Operator list/detail in `apps/admin` (or staff surface after Admin-0 SoT) — residual UI.
- [ ] Read-only account panel via identity/ledger **read** contracts only.
- [x] KB storage decision recorded; first N articles i18n-keyed.

### Stage 3 — optional agent

- [ ] Wire `agents.support` only after KB + account read models exist.
- [ ] Agent cannot invent refund money; tools are read + draft reply.

### Tracker `done` bar

Flip only when users and operators can run a real ticket+KB loop in a real env — agent routing names alone are **not** done.

---

## 5 · Open questions

1. Ticket model + SLA (Denon/Nitro product law).
2. KB storage: repo markdown vs CMS vs blueprint-adjacent.
3. PII redaction rules for support views.
4. Refund **request** workflow owner: pay vs support vs admin.
5. Categories taxonomy and severity.

---

## 6 · Gaps (named)

1. No operator queue UI (`apps/admin` / staff surface).
2. No read-only identity/ledger account panel on ticket detail.
3. Full i18n string pack for KB keys (keys exist; copy residual).
4. Agent assist still optional (`agents.support`) — desk works offline of agents.
5. Agent tasks exist without desk UI (naming trap for “done”).

---

## 7 · Risks

| Risk                            | Why it hurts     |
| ------------------------------- | ---------------- |
| Refund buttons that post ledger | Fabricated money |
| Agent as “desk done”            | No human queue   |
| Vendor names in KB              | Brand gate fail  |
| Support-held balances           | Dual book        |
| Order-ticket confusion          | Wrong implement  |

---

## 8 · Estimated size

| Slice                           | Size    | Notes              |
| ------------------------------- | ------- | ------------------ |
| Contracts + svc-support + tests | **M**   | First implement PR |
| Admin operator queue            | **M**   |                    |
| User ticket UI                  | **S–M** |                    |
| Agent assist                    | **M**   | After KB           |

**First implement PR (when free):** **M** — contracts + thin service + tests; zero money recipes.

---

## 9 · Related docs / code

- `services/svc-agents/src/gateway/routing.ts` (`support.*` tasks)
- `packages/auth` scopes pattern for future `support:*`
- `docs/ops/trk/ops.admin.md` (operator surface SoT)
- `docs/ops/trk/agents.support.md` (optional later)
- Doctrine §8.8

---

## 10 · Explicit non-goals for this pack

- No inventing refund ledger recipes under this id.
- No Shehzad money-lane implement.
- No tracker ownership flip from research.
- No dual-edit of open Denon PRs.
- No treating agents.support routing as desk product complete.
