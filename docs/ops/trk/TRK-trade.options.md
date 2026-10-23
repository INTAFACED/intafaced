# TRK-trade.options — research / spec pack

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Tracker id:** `trade.options`  
**Title:** European options, cash-settled, full collateral in v1  
**Module / phase:** `trade` · phase 2 · plane F  
**Status on tip:** ready (blocked by futures) · **owner:** none (depends Shehzad futures)  
**Depends on:** `trade.futures` (**wip**, owner **shehzad002** M3)  
**Requires:** `services/svc-trade` options module — not started  
**Tip freeze:** `origin/main` @ `04f9b1f2` (re-derive before implement)  
**Pack type:** research only — no implement swarm; no money invention; **no** `features.mjs` edit from this pack.

---

## 1 · What “done” means (plain language)

1. Users can trade **European** options that are **cash-settled** with **full collateral in v1** (no naked under-collateralized writer risk in v1).
2. Expiry settlement is deterministic from published mark/oracle rules — no discretionary “close at nice number.”
3. Collateral and premium move only via **ledger recipes**; positions are event-sourced honestly.
4. UI never shows tradable options while futures risk engine residual is unusable — fail closed.
5. Agents do **not** invent options product law under Shehzad futures ownership.

---

## 2 · Current code state (tip)

### 2.1 Hard dependency red

| Fact             | Tip                                                                                    |
| ---------------- | -------------------------------------------------------------------------------------- |
| trade.futures    | **wip**, owner shehzad002 — residual risk/margin/liq/mark **his**; agents babysit only |
| Options code     | **No** European options engine in svc-trade product path                               |
| Collateral model | Spec’d full collateral v1 — simplifies risk vs futures but still money-heavy           |
| Instrument model | Multi-asset exists; options kind product not listed as done                            |

### 2.2 Babysit posture

Any “options MVP” that forks futures risk tables while M3 open is dual-build. Wait futures truth.

---

## 3 · Doctrine constraints

| Law                | Implication                                           |
| ------------------ | ----------------------------------------------------- |
| Depends futures    | Risk/mark infrastructure ownership Shehzad            |
| Full collateral v1 | Explicit product constraint — do not “relax” silently |
| §0.6               | Ledger recipes only                                   |
| Class M            | Money self-audit                                      |
| Agent protocol     | No invent options under human futures lane            |

---

## 4 · DoD sketch (checkable — staged)

### Stage 0 — wait / babysit

- [ ] Futures risk/mark jobs honest on tip
- [ ] Product options contract specs (underlyings, expiries)

### Stage 1 — instrument + full collateral hold

- [ ] Options instrument rows + premium hold recipes
- [ ] Refuse under-collateralized writes

### Stage 2 — European expiry cash settle

- [ ] Settlement job idempotent per contract
- [ ] Mark source published

### Stage 3 — UI + kill switches

- [ ] Surface + admin halt

**Tracker `done`:** full collateral path + expiry settle + no invent mark.

---

## 5 · Open questions

1. Underlyings and expiry calendar — product?
2. Oracle/mark source shared with futures?
3. American options ever, or European forever?

---

## 6 · Estimated size

| Slice                  | Size          | Notes |
| ---------------------- | ------------- | ----- |
| Spec after futures     | **S**         |       |
| Full collateral engine | **L** Class M |       |
| Full product           | **XL**        |       |

**First implement PR:** **blocked** on trade.futures Shehzad residual. Research only.

**Human blockers:** trade.futures; Product law; Class M.

---

## 7 · Related docs / code

- trade.futures tracker + Shehzad M3
- svc-trade futures residual docs
- ledger recipes pattern

---

## 8 · Explicit non-goals for this pack

- No implement while futures human-owned residual open.
- No naked margin invent in v1.
- No features.mjs done.
- No dual-edit futures risk files.
