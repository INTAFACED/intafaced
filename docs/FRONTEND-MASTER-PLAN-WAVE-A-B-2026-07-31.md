# Frontend master plan — Waves A / B / C + styleboard

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**[HISTORY 2026-09-01]** Wave A/B executed; Wave C chart host is Advanced Charts pending, not “LWC v5 forever.” Live execution: [`FRONTEND-REMAINING-SOT-2026-08-25.md`](FRONTEND-REMAINING-SOT-2026-08-25.md). Do not start from this file.

**Status:** **LOCKED v3.1** · Nitro approved N1–N7 (2026-07-31) · free-hands override active  
**Tip base at lock:** `94c0a3f` — re-derive at implement  
**Spine:** methodology **v3.1**  
**Code:** none until **go implement**

**Nitro free-hands (binding):** Prior frontend work is **not a constraint**. Inventory tip so we don’t _accidentally_ ignore useful machinery; then choose rebuild, replace, or keep **only** if it serves world-class quality. agent’s “already shipped → gap-fill only” is **advice on cost**, not a ban on redesign.

**Still true:** withdraw “you will receive” math + bare Confirm span are **live defects** worth fixing early either way.

---

## 0 · North star

| Item       | Choice                                       |
| ---------- | -------------------------------------------- |
| Product UI | Vue shell :8090                              |
| Money UI   | `components/uc/*`                            |
| apps/web   | Named spike, never linked                    |
| Free hands | N1–N4 full design systems                    |
| Wave A     | Honesty gap-fill; **withdraw first**         |
| Wave B     | Craft + **cheap pro power** (page-data only) |
| Wave C     | Needs new backend / heavy power              |
| Eyes       | Orca primary                                 |

---

## 1 · Excellence order

1. Exchange desk (gap-fill only where missing)
2. uc money — **true zero-coverage + live incorrectness first**
3. App chrome / plane
4. OS modules (maintain IxState)
5. OTC
6. Marketing
7. CMS long tail

---

## 2 · P0 — Unblock

| ID   | Work                                                                                      |
| ---- | ----------------------------------------------------------------------------------------- |
| P0.1 | Tip worktree (`rev-list` = 0)                                                             |
| P0.2 | Boot :8090                                                                                |
| P0.3 | **Orca screenshots** + **baseline scorecard row** (non-implementer)                       |
| P0.4 | ui:proof if available                                                                     |
| P0.5 | Canary break→red                                                                          |
| P0.6 | Prod bundle measure **and** note interaction latency path (dim 16)                        |
| P0.7 | LIVE-LANES claim                                                                          |
| P0.8 | Re-probe packages endpoints when fleet up                                                 |
| P0.9 | **Verify** existing `tooling/uiproof/auth-fixture.mjs` still works — **never seed money** |

---

## 3 · Wave A — Honesty (v3.1 order)

**Every slice starts with inventory:** read tip file → list what exists → then choose **rebuild / replace / keep** for world-class quality. Inventory prevents blind ignore of useful machinery; it does **not** force “delta only.”

### Already shipped at tip — do **not** rebuild **[VERIFIED 94c0a3f]**

| Area              | Present                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------- |
| Ticket            | Confirm modal, Fee (est.), rejects, validation, **submitting** lock, precision from market scales |
| Book              | **click-to-price** `useBookPrice`, DepthGraph, honest depth empty                                 |
| Feed              | Live / No feed pill + ticket warning                                                              |
| Dual-book         | `ix-dualbook` banners on exchange                                                                 |
| Favourites        | toggle + filter                                                                                   |
| Focus             | `:focus-visible` block                                                                            |
| Honesty dialect 2 | `ix-empty*` on MoneyIndex, Record, Withdraw, Recharge, Entrust\*, Exchange, OTC, CMS…             |
| Auth fixture      | `auth-fixture.mjs`, `run-pass3.sh`                                                                |

### A0 — Boot + Orca + baseline scorecard

Proof pack. **A0.5** fold: chart **tradingview.com** attribution link (one-hour compliance; kline has none).

### A2′ — Withdraw first (only confirmed live incorrectness)

| Field         | Content                                                                                                                                                                                                                                                     |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Why first** | Float math on “you will receive”; Confirm is bare `<span @click="ok">` — no lock, not keyboard, no review receipt                                                                                                                                           |
| **Territory** | `components/uc/Withdraw.vue` (+ Address as needed)                                                                                                                                                                                                          |
| **Ship**      | (1) Decimal math via **bignumber UMD in `assets/js/`** (not package.json) (2) **Golden tests** for arithmetic (3) **Review receipt**: amount, full address, fee source, net, estimate label (4) Real **Button** + `submitting` lock (copy Exchange pattern) |
| **Scorecard** | Gates 4, 12, 18, 19                                                                                                                                                                                                                                         |
| **Leverage**  | dYdX DiffOutput **job** only (AGPL study)                                                                                                                                                                                                                   |

### A1′ — One honesty vocabulary + true zero-coverage

1. Canonical vocabulary on styleboard artifact 3 (can draft words in Wave A docs if board not built).
2. Keep IxState on intafaced.
3. Shared uc component for `ix-empty*` speaking REASON words.
4. **Zero-coverage first:** Account.vue, Safe.vue, myorder.vue, then WithdrawAddress, EntrustHistory, growth screens as listed in agent §D.3.
5. **Do not** rewrite MoneyIndex/Record that already have dialect 2 for “IxState purity.”

### A-x1 — Cross-surface number agreement

Terminal rail balance vs `uc/money` — identical or labeled different books. Dim 21.

### A-x2 / A-x3 — Submit locks + session expiry

Every irreversible action: lock. Ticket + withdraw + address-add + cancel + OTC release. Session death mid-flow = honest state. Gates 18.

### A3′ — Ticket **gap-fill only**

After gap-audit: only missing pieces (e.g. richer fee source honesty). Do not re-implement confirm/fee/click.

### A4′ — Book **gap-fill**

Grouping **genuinely missing** (`bookMode` all/bids/asks only). Click-to-price **exists**. DepthGraph first. Pattern: mihailgaberov study.

### A7′ — Plane/feed **gap-fill**

Much shipped #240. Delta only.

### A-x4 / A-x5 — Precision sweep + fee source honesty on withdraw-class surfaces

### A6 — LWC v5 written plan

**Background / non-blocking.** Not a peer of A2′.

### Wave A DoD

Gap-audit on every PR · gates pass on touched money · Orca · non-implementer on A2′/A1′/A-x\* · no fixture-seeded balances · no rebuild of shipped ticket/book controls

---

## 4 · Styleboard

| Direction           | Include                        |
| ------------------- | ------------------------------ |
| N1 Instrument       | Yes                            |
| N2 Signal           | Yes (recommended)              |
| N3 Ledger dual-tone | **Nitro K3** — default include |
| N4 Terminal Zero    | Yes (pole)                     |

Deliverable: agent §C ten artifacts. Pick instrument: trust · cool · would use daily + graft slot.

**Wave A** without pick OK. **Wave B retheme** after pick or written waiver.

---

## 5 · Wave B — Craft + cheap pro power

**Rule:** _computable from data already on the page → B; new backend contract → C._

| ID  | Work                                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------- |
| B1  | Tokens per Nitro pick; kill default glass if board says                                                                   |
| B2  | Terminal density hierarchy + book **grouping**                                                                            |
| B3  | uc craft = terminal (shared components)                                                                                   |
| B4  | Mobile = **monitor + panic** (positions, kill order, fill confirm) + **build** focus trap/Esc (iView Drawer insufficient) |
| B5  | **Persist** pair/TF/book mode/panel sizes (localStorage) — cheap desk                                                     |
| B6  | Watchlist **rail** (promote favourites)                                                                                   |
| B7  | Keyboard **floor**: focus order, Esc/Enter ticket, `/` market search                                                      |
| B8  | Slippage/impact estimate from book on market orders                                                                       |
| B9  | Partial-fill display; fee schedule surface; CSV export; copy ids                                                          |
| B10 | a11y: GOV.UK error-summary focus + LiveAnnouncer-style pattern (catalog)                                                  |
| B11 | Entry line on chart if position already rendered                                                                          |
| B12 | Marketing/OS/OTC/CMS craft in excellence order **last**                                                                   |
| B13 | Anti-slop certify non-implementer                                                                                         |
| B14 | Blotter virt — measure first; prefer CSS `content-visibility` spike **[unverified]** before deps                          |
| B15 | Multi-monitor pop-out if cheap                                                                                            |

### Wave B DoD

Nitro visual yes on desk+money · before/after crops · gates still green · baseline improved on targeted dims

---

## 6 · Wave C — Backend / heavy power

Full keyboard map · LWC v5 + RSI/MACD panes · indicator suite after golden tests · saved layout/widget canvas · multi-market · drag-reprice if API · DOM ladder · tape advanced · price alerts · API trust page

**Never:** social feed, leaderboards, confetti, AI-trades homepage

---

## 6b · Wave Admin — staff console (after Wave A foundation)

| Phase       | Work                                                                                                                    |
| ----------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Admin-0** | Inventory: which is live — `04_Web_Admin` vs `apps/admin` vs both · ports · who logs in · Orca proof if up              |
| **Admin-1** | Honesty on money-ops screens: approve withdraw, freezes, kill-switch — no silent success, review receipts, submit locks |
| **Admin-2** | Apply **same styleboard tokens** as trader (one company face)                                                           |
| **Admin-3** | Density/craft for daily ops lists (users, orders, finance queues)                                                       |

**Do not start Admin-1 code until:** trader Wave A has landed withdraw+money honesty proof **or** Nitro explicitly says run admin in parallel.

---

## 7 · IA (plan section)

| Decision           | Default                                                     |
| ------------------ | ----------------------------------------------------------- |
| Logged-in land     | **Desk** `/exchange` not marketing Index                    |
| Modes              | Desk vs OS; plane orthogonal                                |
| Money nav          | Collapse mental model under MemberCenter (nav, not rewrite) |
| Global search / ⌘K | Wave B                                                      |
| `/dex`             | Prefer plane-in-desk over separate app feel                 |

---

## 8 · Risk register (merged)

| Risk                               | Sev          | Mitigation                      |
| ---------------------------------- | ------------ | ------------------------------- |
| Rebuild shipped work               | **Critical** | Gap-audit mandatory             |
| Fixture fakes money                | **Critical** | Methodology auth law            |
| Three honesty dialects diverge     | High         | A1′ + styleboard artifact 3     |
| Withdraw double-submit / bad math  | High         | A2′ first                       |
| Stale plan SHA                     | Critical     | Tip SHA on every wave start     |
| Free hands → under-build           | High         | §G.2 gates                      |
| Dual frontend                      | High         | Spike + no-link; CI guard later |
| Package vs bignumber contradiction | Fixed        | UMD assets/js                   |
| No baseline → unfalsifiable better | High         | P0.3 row                        |
| Vue2 EOL                           | Med-High     | Operate-now                     |
| LWC attribution                    | High         | A0.5                            |
| History proprietary residual       | High         | Denon purge                     |
| Skill shrink                       | Med-High     | PR disclosure                   |

---

## 9 · Denon

Fleet · multi-asset · history purge · proxy/edge/main.js · live rails · order-modify **API existence answer** · commercial TV Advanced · admin

Auth fixture: **verify first**; only cross-stream if broken.

---

## 10 · apps/web

Named spike · never linked · optional CI path guard when coding

---

## 11 · Nitro decisions — **LOCKED 2026-07-31**

| #     | Question                            | Nitro                                                                                                |
| ----- | ----------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **1** | Approve methodology + plan?         | **Yes** (agent judged; he does not re-read docs)                                                     |
| **2** | Wave A honesty before look pick?    | **Yes**                                                                                              |
| **3** | Include N3 Ledger on styleboard?    | **Yes**                                                                                              |
| **4** | Logged-in → trading desk?           | **Yes**                                                                                              |
| **5** | apps/web named spike, never linked? | **Yes**                                                                                              |
| **6** | RSI/MACD panes later (Wave C)?      | **Yes later**                                                                                        |
| **7** | Admin product in this program?      | **In as Wave Admin** (Nitro + Grok 2026-07-31) — sequenced after trader Wave A foundation; not vibed |

### Admin — Wave Admin (planned track, not vibe)

**What it is:** staff back-office (approve withdrawals, users, fees, kill-switches) — **not** the trader desk.  
**Two surfaces on disk:** legacy `vendor/…/04_Web_Admin` · modern `apps/admin` (kill-switch, ledger freeze, jurisdiction). **First Admin step = pick which is live SoT** (inventory + Denon if unclear) — do not double-build.

| Rule                  | Meaning                                                                                                                                |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Same program**      | Same methodology, styleboard tokens, honesty gates, Orca proof                                                                         |
| **Sequence**          | After trader **Wave A foundation** (withdraw + money honesty + desk gates green enough to not thrash focus). Styleboard may be shared. |
| **Parallel OK later** | Separate worktree + LIVE-LANES claim; never same agent as `Exchange.vue`                                                               |
| **Territory**         | Not classic Stream A paths — open as `feat/admin-*` or agreed prefix; spine/money still Denon                                          |
| **Bar**               | Higher blast radius: irreversible staff actions need review receipt + real buttons + locks (same as withdraw bar)                      |

### Free-hands override (plain)

Agents **may rebuild** the trader UI from a clean visual/honesty system. Old orange patches and “already honest” screens do **not** force minimum-diff polish. Reuse only when it clearly helps quality.

---

## 12 · First implement paste (after go implement)

```
Wave A only. Tip worktree origin/main. LIVE-LANES.
Law: methodology v3.1 + plan v3.1 + Design Bar free-hands.
Prior UI is inventory only — not a ceiling. Rebuild allowed; reuse only if quality-true.
Inventory tip each slice, then best path (not minimum delta theater).
Prefer early: withdraw math+receipt+real Confirm; money honesty; desk honesty gates.
Auth fixture: real session only; NEVER seed balances.
Mass retheme waits for styleboard pick unless waiver. No Stream B. No fake numbers.
```

---

## 13 · Outcome demo

1 Desk visible · 2 failure named · 3 uc honest · 4 withdraw **receipt** · 5 ticket · 6 open orders · 7 L1 side-by-side jobs · 8 Nitro “ours”

---

## 14 · Merge status

| Source                  | Status                                                      |
| ----------------------- | ----------------------------------------------------------- |
| agent return pack       | **Merged** into v3                                          |
| Grok rigorous audit     | **Merged** (design bar free hands, paths, excellence order) |
| Tip re-verify `94c0a3f` | **Done**                                                    |

---

_Execute only after Nitro N1 yes + go implement. Re-gap-audit if tip moves past `94c0a3f` before start._
