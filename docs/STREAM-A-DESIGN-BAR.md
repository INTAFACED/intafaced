# Stream A Design Bar — scoreable law for polish

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**[HISTORY 2026-09-01]** Honesty / no-fake-prices / one-kit still bind. P21 teal and “LWC only” do **not**. Live paint N4. Chart: Advanced Charts pending (`LICENCE-POSITION.md` §1.1a). Execution map: [`FRONTEND-REMAINING-SOT-2026-08-25.md`](FRONTEND-REMAINING-SOT-2026-08-25.md).

**Status:** Pass 2.5 · 2026-07-30  
**Scope:** vendored exchange shell on `:8090` (not `apps/web`).  
**Companions:** `FRONTEND-OPERATING-PLAN-2026-07-30.md`, `FRONTEND-OPERATING-PLAN-GROK-AUDIT-2026-07-30.md`, `RUNNING-STREAM-A.md`.

> World-class here means **trust, density, calm, plane unity** — not a new component library.  
> **One kit: iView 3. Colors modular via CSS tokens.** Provisional lock: **P21** deep neutral + teal (`docs/COLOR-LOCK-P21-PROVISIONAL-2026-07-31.md`). Orange is not sacred.

Agents score polish PRs against this checklist. A PR that fails the bar is not “done,” even if `ui:proof` is green.

---

## 0 · Non-negotiables (instant reject)

| Rule                        | Fail looks like                                                                                      |
| --------------------------- | ---------------------------------------------------------------------------------------------------- |
| **No second design system** | Tailwind, shadcn, Radix, Element UI, Ant Design Vue, Naive, Quasar, or any Vue 3 kit alongside iView |
| **No fake prices**          | Any number invented for S2 / charts before market seed #109                                          |
| **No confetti / thrash**    | Success fireworks, layout jump on every tick, spinner party                                          |
| **Empty ≠ zero**            | Failed balance fetch rendered as `$0.00`                                                             |
| **Brand scrub**             | Forbidden vendor strings in runtime DOM (`ui:proof` + brand-scan)                                    |
| **Nitro is not the runner** | “Open localhost and tell us” as the only gate                                                        |

---

## 1 · Product layers (what “world-class” means)

| Layer             | Meaning                                                     | When                    |
| ----------------- | ----------------------------------------------------------- | ----------------------- |
| **Trust**         | Numbers never lie; empty / loading / error are three states | Phase 1 + harness       |
| **Clarity**       | Next action obvious in ~2 seconds                           | Phase 1–2               |
| **Density**       | Book + chart + form + balances without hunting              | Phase 2                 |
| **Calm**          | Stable layout when data ticks; quiet success                | Phase 2                 |
| **Speed of feel** | Usable first paint; no multi-second white flash             | Phase 2 (budget)        |
| **Consistency**   | Same space/type/accent/empty recipe everywhere              | Phase 2 tokens          |
| **Accessibility** | Keyboard order form, focus rings, contrast                  | Phase 1.5 axe → Phase 2 |
| **Plane unity**   | CEX and DEX = one product, two risk modes                   | Phase 2                 |

---

## 2 · Token layer (append-only; no new npm kit)

Implement as CSS variables in `intafaced.css` `:root` (the modular swap point). Current values = **P21** (provisional); change the block to retheme.

| Token group | Minimum set                                                                                          |
| ----------- | ---------------------------------------------------------------------------------------------------- |
| **Color**   | `--bg`, `--panel`, `--border`, `--text`, `--text-muted`, `--up`, `--down`, `--accent` (P21 teal now) |
| **Space**   | 4 / 8 / 12 / 16 / 24                                                                                 |
| **Type**    | 11 / 12 / 13 / 14 / 16; **tabular nums** for prices and sizes                                        |
| **Control** | order-form control height; radius small/medium                                                       |
| **Z**       | drawer / modal / toast scale                                                                         |

**How agents restyle:** iView via variables + local SCSS overrides — never fork the kit.

---

## 3 · Pattern checklists (score every polish PR)

Use public products as **pattern references only** (no markup or assets).

### 3.1 · Honesty & empty (Coinbase Advanced Trade)

- [ ] Failed fetch never looks like “you have $0”
- [ ] Loading, empty, error are three distinct states
- [ ] Primary action still visible when secondary data is down
- [ ] Copy names the failure in human words (not raw HTTP codes alone)

### 3.2 · Density (Binance / Bybit / OKX spot)

- [ ] Book + last trade + form share one visual language
- [ ] Depth shading readable at a glance
- [ ] Order type switch is one control group, not scattered
- [ ] Balance strip is one line, not a scavenger hunt

### 3.3 · Plane unity (Hyperliquid-class)

- [ ] Switching CEX ↔ DEX changes **risk mode**, not “whole other app”
- [ ] Protocol path never looks cheaper/uglier than CEX
- [ ] Labels say custodial vs non-custodial in plain language

### 3.4 · Calm finance

- [ ] Success is a quiet notice (iView Message/Notice), not confetti
- [ ] Tabular figures; no layout jump on tick
- [ ] Focus rings visible for keyboard trading
- [ ] Mobile drawer (S6) does not trap focus forever

### 3.5 · iView usage (kit discipline)

- [ ] Dialogs / drawers / tables / inputs / buttons stay on iView
- [ ] New chrome is a **pattern recipe** (layout + copy), not a new package
- [ ] Icons: at most **one** open SVG set if Phase 2 needs them — optional

---

## 4 · Surfaces Phase 2 may touch (in order)

1. **Terminal density** — exchange pair view: book / trades / form alignment
2. **Token file** — §2 variables wired into brand + iView overrides
3. **Empty/error recipes** — shared component or mixin used on index + account + terminal
4. **Plane toggle** — CEX/DEX feels like one product
5. **Performance budget** — flag 12 MB `app.js`; no new heavy deps without budget
6. **Charts** — Lightweight Charts **only** after licence/NOTICE + #109 (never proprietary Charting Library)

---

## 5 · How a polish PR proves the bar

| Required         | Artefact                                                             |
| ---------------- | -------------------------------------------------------------------- |
| Functional       | `pnpm ui:proof` → `PROOF.md` all PASS (or **unverified** if blocked) |
| Design           | This checklist filled in the PR body (checkboxes, not vibes)         |
| Doctrine         | `pnpm verify` green; brand/custody clean                             |
| Taste (elective) | S8 screenshot pack only when Nitro asks — never the only gate        |

**Writer ≠ certifier:** executor implements; planner/auditor scores the checklist.

---

## 6 · Explicitly out of scope for this doc

- Auth fixture (Pass 3) and account empty-vs-error proof
- Pixel baselines (Pass 4)
- Real prices (Pass 5 / #109)
- Rewriting the shell off Vue 2 / iView

---

## 7 · One-line law

> **Honest numbers, dense terminal, calm chrome, one kit, one brand — prove it with PROOF.md, score it with this bar.**
