# Frontend Operating Plan — executor audit + world-class layer

**Status:** addendum to planner's `FRONTEND-OPERATING-PLAN-2026-07-30.md` · 2026-07-30  
**Author role:** executor = adversarial auditor + senior frontend product craft (planning only; no implementation this turn)  
**Planner plan home (branch not yet on main):** `sovereign-worktrees/docs-frontend-operating-plan/docs/FRONTEND-OPERATING-PLAN-2026-07-30.md`  
**Verdict for Nitro:** planner's plan is **the right spine for proof**. Adopt GO packet PR-1/PR-2 **as written**. Add the layers below **after** PR-2 so “world-class UI” is a system, not random component shopping.

---

## 0 · One-sentence audit

Planner fixed **how we know the UI works**. This addendum fixes **how we get it to feel like a serious exchange** without abandoning #86 or inventing a second design system mid-flight.

---

## 1 · Scorecard of planner's plan

| Area                                            | Score  | Notes                                                                                            |
| ----------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------ |
| Role inversion / no Nitro-as-tester             | **A**  | Root cause is correct and binding                                                                |
| Boot as first-class artefact                    | **A**  | Two-stage readiness (`/` + `/app.js`) is the key subtlety — keep it                              |
| Playwright outside vendor tree                  | **A**  | Best cost/isolation trade for this webpack 3 shell                                               |
| Reject Cypress / Storybook / shadcn now         | **A**  | Correct collision analysis with #86 and Vue 2                                                    |
| Backends-down as Phase 1 fixture                | **A**  | Matches honesty bar already shipped                                                              |
| Auth fixture deferred, marked unproven          | **A**  | Honest; do not paper over                                                                        |
| Pass order 1→2 before 3                         | **A**  | Non-negotiable                                                                                   |
| RACI planner plans / Executor executes          | **A**  | Keep “writer ≠ certifier”                                                                        |
| World-class **product UI craft**                | **C+** | Under-specified — pattern/density/tokens/performance almost absent                               |
| Component strategy beyond “keep iView”          | **B−** | Right reject list; missing **what to build on top of iView**                                     |
| Performance / bundle reality (12.5 MB `app.js`) | **D**  | Not addressed; world-class terminals care                                                        |
| Deterministic fixtures beyond “fleet down”      | **B−** | Allowlist network errors is good; route-level fixtures come next                                 |
| Design references operationalised               | **B**  | Good names (Coinbase / Hyperliquid / Binance); no **pattern checklist** agents can score against |
| CI flake strategy for screenshots               | **B**  | Correct delay of pixel baselines; should pre-state Docker/font rule for Pass 4                   |

**Bottom line:** **Do not rewrite the GO packet.** Ship PR-1/PR-2. Open a **Pass 2.5 design bar** track so “make it world-class” has a definition before anyone installs a library.

---

## 2 · What “world-class exchange UI” actually means (plain)

It is **not** “use the hottest component library.” Serious terminals win on:

| Layer             | Meaning                                                    | Phase                                 |
| ----------------- | ---------------------------------------------------------- | ------------------------------------- |
| **Trust**         | Numbers never lie; empty ≠ zero; failures named            | Phase 1 (mostly done) + harness proof |
| **Clarity**       | What to do next is obvious in 2 seconds                    | Phase 1–2                             |
| **Density**       | Pros see book + chart + order + balances without hunting   | Phase 2                               |
| **Calm**          | No confetti, no thrash, stable layout when data ticks      | Phase 2                               |
| **Speed of feel** | First paint usable; no multi-second white flash            | Phase 2 (bundle)                      |
| **Consistency**   | Same spacing, type, orange accent, empty states everywhere | Phase 2 tokens                        |
| **Accessibility** | Keyboard order form, focus, contrast for long sessions     | Phase 1.5 axe + Phase 2 deep          |
| **Plane unity**   | CEX and DEX feel like one product, two risk modes          | Phase 2 (Hyperliquid-class pattern)   |

Component libraries only help **consistency and speed of build**. They do not create taste, density, or trust. On this shell, **iView is the kit**; world-class is **skin + patterns + proof**.

---

## 3 · Component strategy (master rule)

### 3.1 · The rule

> **One kit (iView 3), one brand (#86 black/orange), one token layer (CSS variables), zero second frameworks until a product decision to de-vendor the shell.**

| Approach                                                                                                     | Verdict                                                     |
| ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| Keep iView for Dialog, Drawer, Table, Input, Button, Message, Modal                                          | **Required** — already in the tree                          |
| Add Element UI / Ant Design Vue 1 / Quasar alongside iView                                                   | **Forbidden** — dual kit = dual look                        |
| Tailwind / shadcn / Radix                                                                                    | **Forbidden** — React + new system + brand collision        |
| Naive UI / Vuetify 3 / Arco                                                                                  | **Forbidden now** — Vue 3; would force shell rewrite        |
| **INTAFACED pattern recipes** (terminal layout, empty state, money row, confirm modal) documented and reused | **The real upgrade path**                                   |
| Lightweight Charts (Apache-2.0, already vendored path)                                                       | **Only after licence/NOTICE + #109** — never invent candles |
| Icon set: pick **one** open set as SVG assets if Phase 2 needs consistency                                   | **Optional Phase 2** — not a framework                      |

### 3.2 · What “best components” means here

| Need                       | Use                                                                                     |
| -------------------------- | --------------------------------------------------------------------------------------- |
| Layout chrome, nav, drawer | Existing `App.vue` + iView Drawer/Menu                                                  |
| Order confirm, cancels     | iView Modal (already used)                                                              |
| Tables (account, markets)  | iView Table + honesty empty strings                                                     |
| Chart                      | Lightweight Charts **only** if licence path closed — no proprietary TV Charting Library |
| Depth                      | Existing DepthGraph (fix thrash, not replace)                                           |
| Empty / error / loading    | **Shared pattern** (copy + layout recipe), not a new library                            |
| Proof                      | Playwright (+ axe later)                                                                |

### 3.3 · Token layer (Phase 2, after PR-2) — the missing “design system”

Not a new npm kit. A **small token file** (append-only region in `intafaced.css` or a Stream A–owned sheet):

- Color: bg / panel / border / text / up / down / accent (orange) — map to #86
- Space: 4/8/12/16/24
- Type: 11 / 12 / 13 / 14 / 16 with tabular nums for prices
- Radius / control height for order form
- Z-index for drawer / modal

Agents then **restyle iView via variables and local SCSS**, not by swapping libraries. That is how professional products upgrade a legacy shell without a rewrite.

---

## 4 · Pattern references — operational checklist (not moodboards)

Use public products as **pattern references only** (no markup/assets). Score any polish PR against this checklist:

### 4.1 · Coinbase Advanced Trade → honesty & empty states

- [ ] Failed fetch never looks like “you have $0”
- [ ] Loading, empty, error are three distinct states
- [ ] Primary action still visible when secondary data is down

### 4.2 · Binance / Bybit / OKX spot → density

- [ ] Book + last trade + form share one visual language
- [ ] Depth shading readable at a glance
- [ ] Order type switch is one control group, not scattered

### 4.3 · Hyperliquid → plane unity (CEX vs DEX)

- [ ] Switching plane changes **risk mode**, not “whole other app”
- [ ] Protocol path never looks cheaper/uglier than CEX
- [ ] Labels say custodial vs non-custodial in human words

### 4.4 · Generic finance calm

- [ ] No success confetti; success is a quiet notice
- [ ] Numbers use tabular figures; no layout jump on tick
- [ ] Focus rings visible for keyboard trading

These checkboxes belong in **Pass 6 (S8 pack)** and Phase 2 polish PRs — not in PR-1.

---

## 5 · Gaps to add to planner's pass ladder

| Pass    | Name                                               | Why                                                                                                          |
| ------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **2.5** | **Design bar doc** (`docs/STREAM-A-DESIGN-BAR.md`) | Density, tokens, pattern checklist, motion ban — so polish PRs have a law                                    |
| **3**   | Auth fixture                                       | Unchanged — required for real S5/S7                                                                          |
| **3.5** | **Route fixtures** (Playwright `page.route`)       | Deterministic wallet-down / orders-down / markets-down without depending on global fleet state               |
| **4**   | Pixel baselines                                    | planner's rules + **run in official Playwright Docker image** when CI flake appears (industry standard 2026) |
| **4.5** | **Performance budget**                             | First contentful usable terminal; flag 12 MB `app.js` as known debt; no new heavy deps without budget        |
| **5**   | Prices after #109                                  | Unchanged                                                                                                    |
| **6**   | S8 human taste                                     | Elective                                                                                                     |

**Do not insert 2.5 before PR-2.** Proof first; design bar second; polish third.

---

## 6 · Harness refinements (keep GO packet; tighten later)

planner's PR-1/PR-2 stay. Add these as **PR-2 follow-ups or PR-2.1**, not as blockers:

1. **Screenshot contract:** always hide volatile regions (clocks, websocket flicker) via `data-uiproof-ignore` once stable.
2. **Matrix grows by concern:** not only routes — include “order form invalid”, “plane toggle active state”, “drawer open” as named cases.
3. **Console allowlist versioned** in one file so it cannot silently widen.
4. **Canary (B4) is sacred** — keep forever.
5. **When pixel baselines land:** prefer **element-scoped** shots (header, order form, empty banner) over full-page (2026 visual-testing consensus: full-page flake is the enemy).
6. **Lightweight Charts files** must be either committed under licence process or ignored intentionally — “untracked but used” is a ship hazard.

---

## 7 · Research notes (libraries & tools, 2026 posture)

| Tool / lib                          | Role for us                                                               |
| ----------------------------------- | ------------------------------------------------------------------------- |
| **Playwright + `toHaveScreenshot`** | Gate + later baselines — free, in-repo, no third party sees the UI        |
| **@axe-core/playwright**            | Phase 1.5 a11y floor — after harness green                                |
| **Percy / Chromatic / Applitools**  | Not needed until screenshot review fatigue; avoid SaaS until pain is real |
| **Playwright Docker image**         | Pass 4 flake control (font/OS parity)                                     |
| **iView 3**                         | Runtime kit — stay                                                        |
| **Lightweight Charts**              | Chart path if licence/NOTICE clean — not Phase 1 gate                     |
| **shadcn / Tailwind / Radix**       | Wrong stack + brand rewrite — out                                         |
| **Storybook**                       | No webpack 3 path — out until de-vendor                                   |
| **Internal pattern recipes**        | Highest ROI “component” work after proof                                  |

World-class teams on legacy shells almost always win by **tokens + patterns + ruthless proof**, not by mid-flight framework swaps.

---

## 8 · Planner vs executor vs Nitro (refined)

|                             | planner                              | executor                        | Nitro                            |
| --------------------------- | ------------------------------------ | ------------------------------- | -------------------------------- |
| Operating plan / design bar | **Plans & audits**                   | Contributes adversarial addenda | Approves product taste           |
| PR-1 boot / PR-2 harness    | Audits after                         | **Builds**                      | Does not run commands            |
| Shell UI polish             | Specs against design bar             | **Implements**                  | S8 keep/change                   |
| Component kit adoption      | Recommends only with licence + phase | Never installs without go       | **A** on new systems             |
| “Does it work?”             | Reads PROOF.md                       | Produces PROOF.md               | Never required to open localhost |

---

## 9 · What we should do next (ordered)

1. **Land the plan pair as a docs PR** (planner plan + this audit) on main.
2. **Executor executes GO packet PR-1 then PR-2** exactly.
3. **Planner audits** both with the six acceptance rows.
4. **Pass 2.5 design bar** doc (short, scoreable).
5. **Only then** Phase 2 polish: tokens, density, plane unity, optional icon set, chart polish after #109.
6. **S8** when Nitro wants taste — with screenshot pack, not a raw “open the link” homework.

---

## 10 · Enhanced prompt for Nitro (unspoken needs made explicit)

Paste this when starting the next dual-agent session:

```text
I'm Nitro. Non-technical. Product owner of Stream A (exchange shell at :8090, not apps/web).

Unspoken needs (treat as standing orders):
1) I must never be the test runner. Agents boot, screenshot, score, and fix until PROOF.md is green.
2) I want a world-class trading UI feel — density, trust, calm, plane unity — without looking like generic AI chrome or an "ice club" template.
3) Denon already set English + black/orange (#86). Do not propose Tailwind/shadcn/Element as a rewrite. One kit: iView. Upgrade via tokens + patterns.
4) Planner agent = planner/auditor. Executor agent = executor. Writer of code never certifies alone.
5) Prefer leverage: Playwright harness, design bar, pattern checklists, route fixtures. No long-lived foreground servers.
6) Fake prices forbidden. S2 waits on seed #109. Mark unproven what needs auth.
7) When you say "done", attach PROOF.md or say unverified.

Laws: FRONTEND-OPERATING-PLAN-2026-07-30.md + FRONTEND-OPERATING-PLAN-GROK-AUDIT-2026-07-30.md.
Now: [Planner audit | executor execute PR-1 | executor execute PR-2 | write design bar].
```

---

## 11 · Explicit disagreement / risk (one line each)

- **Disagree with expanding GO packet before proof:** world-class craft without a harness becomes taste theatre.
- **Risk if we shop component libs now:** second visual language + Vue 2 traps + brand undo of #86.
- **Risk if we only ship harness and never design bar:** UI stays “honest but amateur.”
- **Concession:** account empty-vs-error remains **unproven** until auth fixture — planner is right; do not claim otherwise.

---

## 12 · Decision for Nitro

| Decision                                               | Recommendation                                                       |
| ------------------------------------------------------ | -------------------------------------------------------------------- |
| Adopt planner's PR-1 / PR-2 GO packet?                 | **Yes**                                                              |
| Adopt this audit’s design-bar / tokens / pattern path? | **Yes, after PR-2**                                                  |
| Install a new UI component framework now?              | **No**                                                               |
| Send exchange screenshots as references?               | **Optional**, only for Pass 6 / Phase 2 scoring against §4 checklist |
| Your next click                                        | Tell executor: **docs PR then execute GO packet PR-1**               |
