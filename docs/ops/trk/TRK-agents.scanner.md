# TRK-agents.scanner — research / spec pack

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Tracker id:** `agents.scanner`  
**Title:** Market Scanner — ranked signals by tier  
**Module / phase:** `agents` · phase 5 · plane F  
**Status on tip:** ready · **owner:** none  
**Depends on:** `agents.gateway` (done), `trade.spot` (done)  
**Requires:** `services/svc-agents` (runtime only today)  
**Tip freeze:** `origin/main` @ `04f9b1f2` (re-derive before implement)  
**Pack type:** research only — no implement swarm; no money invention; **no** `features.mjs` edit from this pack.

---

## 1 · What “done” means (plain language)

1. Users can open a Market Scanner surface (API + later UI) and see **ranked market signals** whose order depends on **published tier rules** (free / staked / invite — same honesty class as academy seats), not invent rank.
2. Every signal is derived from **live market data** the platform can prove (ticker / book / trades / funding as product names) or the item is **omitted / typed-refused** — never a green arrow, fake volume, or synthetic “hot” list when feeds are empty.
3. Scanner work runs as a **product agent skill** on the existing gateway runtime (`openSession → think → act → settle → closeSession`) with a registered guardrail, not a free-form model chat that can invent prices.
4. No depth or last-price fabrication while public WS / book honesty residuals are open; empty book → honest empty or refuse.
5. User-facing copy never names model/partner vendors (brand scan).

---

## 2 · Current code state (tip)

### 2.1 Gateway exists; product agent does not

| Fact            | Tip                                                                                                                                            |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime         | `services/svc-agents` gateway metering + session lifecycle **shipped** (`agents.gateway` done)                                                 |
| Product agents  | README + `runtime.ts` / `index.ts` explicitly: Navigator, Support, **Market Scanner**, Merchant are **separate work** that register guardrails |
| Routing stub    | `gateway/routing.ts` already knows task id `scanner.rank` (routing table entry only — not a full skill implementation)                         |
| Guardrail tests | Fleet guardrails test mentions `scanner.rank` as a completion-scoped task label                                                                |
| Scanner surface | **No** dedicated scanner API, UI, or signal DTO package                                                                                        |
| Market data     | `packages/market-data` public print keys exist for scanners/tests; trade REST + WS public streams are separate honesty tracks                  |

### 2.2 Invent risk surface

Scanner is a **high invent surface**. Any implementation that “fills” empty markets with demo signals fails doctrine. Prefer pure ranker over fixture books first.

---

## 3 · Doctrine constraints

| Law            | Implication                                                                           |
| -------------- | ------------------------------------------------------------------------------------- |
| Agents gateway | Metered sessions; product skills register guardrails — do not bypass gateway          |
| Brand §0.7     | No model/partner names in user copy                                                   |
| Market honesty | No fabricated depth/volume/last; align with P-WS / trade public data law              |
| Tier honesty   | Staked/invite tiers must read real stake/rank truth or refuse — same as academy seats |
| Shehzad lanes  | Not M1–M7; free residual once product law names signal inputs                         |

---

## 4 · DoD sketch (checkable — staged)

### Stage 1 — pure ranker (no UI)

- [x] Product law names signal inputs — **D26-P0-11 sealed** [`docs/adr/2026-08-12-scanner-signal-inputs-law.md`](../../adr/2026-08-12-scanner-signal-inputs-law.md) (`last` / `volume24h` / `change24hBps` · recipe `abs_change_x_log_volume`; refuse when missing)
- [ ] Signal DTO in contracts + pure `rankSignals(inputs, tier)` with fixture tests
- [ ] Empty / stale feed → omit or typed refuse codes, never invent

### Stage 2 — agent skill

- [ ] Guardrail registration + `scanner.rank` skill drives pure ranker only
- [ ] Metering settles; brand scan green
- [ ] Mount read-only list behind edge when free

### Stage 3 — surface

- [ ] Shell/UI route; tier gates visible; no WS invent while integrity residual open

**Tracker `done`:** Stage 2 minimum with live data path or honest refuse; not pure fixtures alone.

---

## 5 · Open questions

1. What is a “signal” for v1 (momentum, spread, funding, new listing) — product law?
2. Tier matrix: free sees N rows; staked unlocks which fields?
3. May scanner call external venue quotes (dex.quote-router) or only internal book?
4. WS depth dependency — block book signals until P-WS integrity residual closed?

---

## 6 · Estimated size

| Slice                          | Size              | Notes                     |
| ------------------------------ | ----------------- | ------------------------- |
| Signal DTO + pure ranker tests | **S–M** Class N/P | No money                  |
| Guardrail + skill on gateway   | **M**             | One service: svc-agents   |
| UI surface                     | **M**             | After API honesty         |
| External venue signals         | **L**             | Depends venue/dex honesty |

**First implement PR (when free):** **S–M** — contracts + pure ranker + refuse tests. No UI. No depth invent.

**Human blockers:** Product law; Tier rules; WS / book honesty.

---

## 7 · Related docs / code

- `services/svc-agents/README.md`
- `services/svc-agents/src/gateway/routing.ts` (`scanner.rank`)
- `packages/market-data`
- P-WS integrity residual docs under `docs/ops/`

---

## 8 · Explicit non-goals for this pack

- No invent green lists or demo volume.
- No Shehzad futures/OTC product law under scanner.
- No `features.mjs` flip from research.
- No dual-edit of open money/WS PRs “to feed scanner.”
