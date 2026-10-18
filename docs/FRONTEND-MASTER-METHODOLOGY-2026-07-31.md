# Frontend master methodology — pro workbench program

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**[HISTORY 2026-09-01]** Dimensions/gates still useful. “Code none until go implement” and P21/LWC-forever lines are **superseded**. Live: [`FRONTEND-REMAINING-SOT-2026-08-25.md`](FRONTEND-REMAINING-SOT-2026-08-25.md).

**Status:** **LOCKED v3.1** · Nitro approved decisions 1–7 (2026-07-31) · agent may open Wave A on **go implement**  
**Code:** none until **go implement** (still)  
**Tip base at merge:** `origin/main` @ `94c0a3f` — re-derive at implement time  
**Sources:** enhance return + Grok audit + **Nitro free-hands override (prior UI is not a cage)**

### Nitro free-hands override (binding — 2026-07-31)

Prior Stream A / tip UI work (honesty patches, orange shell, `ix-empty`, ticket controls, etc.) is **inventory and optional leverage only**. It is **not** a ceiling, a sacred dialect, or a reason to under-build.

| Rule                                   | Meaning                                                                                                                                                                                                                               |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Not limited by what shipped**        | Agents must not shrink ambition because “#231 already did X.” agent’s “do not rebuild” is a **cost hint**, not a ban.                                                                                                                 |
| **Clean zero allowed**                 | Full rebuild of desk, money screens, tokens, honesty presentation is allowed if that is the path to world-class.                                                                                                                      |
| **Reuse only if it does not misguide** | Keep a piece only when it clearly raises quality (e.g. real endpoint wiring, IxState REASON taxonomy, LWC chart host, DepthGraph thrash fix) **and** does not lock the product into half-measures or a third honesty dialect forever. |
| **Quality > sunk cost**                | Prefer delete/replace over preserving mediocre “already honest” chrome.                                                                                                                                                               |
| **Doctrine still locked**              | No fake money, dual-book truth, brand-scan, Stream A/B territory, ledger law — free hands is **visual/UX craft**, not fake data.                                                                                                      |

Gap-audit at slice start still runs — so we know what exists — but the decision after the audit is **best path for the pro workbench**, not “minimum delta to tip.”

**Spine companions:** plan v3 · Design Bar free-hands · state of truth · intent lock · blueprint inventory · L1 AUDIT-PASS

**Every plan/wave doc carries a tip SHA.** Before any wave starts: re-derive against current `origin/main` (mandatory gap-audit). Stale inventory already burned us once.

---

## 0 · Purpose

World-class UI for **profitable / professional traders** without AI slop, CEX neon clones, fake money UI, context rot, **or silent self-limits** (orange law, skill shrink, rebuilding shipped work, parking cheap pro features in “later”).

Pipeline:

```
Research (direction closed; delta only when needed)
  → Real refs (L1 PASS + catalog)
    → Intent
      → Moment map + scorecard baseline
        → Style system (N1–N4 full systems)
          → Wave A honesty (gap-fill; withdraw first)
            → Wave B craft + cheap pro power from page data
              → Wave C backend-heavy power
```

---

## 1 · Goals / free hands / non-negotiable

### Goals

Pro workbench · higher scorecard (falsifiable via baseline) · honesty moat · ownable craft · **desk excellence before CMS** · full surface in excellence order · max leverage · operator peace

### Free hands

**Not sacred:** #86 orange, marketing lime as product law, glass-as-default, locked accent.  
**Allowed:** full visual rebuild after styleboard.  
**Residue:** tip CSS may still be orange/glass until Wave B — not law.

### Non-negotiable product law

No fake balances/books/candles/fills · failed fetch ≠ `$0.00` · dual-book labeled · brand-scan · money via ledger recipes (Stream B) · Stream A territory · green/red market only · implementer ≠ money certifier · tip worktree · one agent per tree

### Auth fixture law (must)

The auth fixture authenticates a **real** session against a **real** dev backend. It **never** seeds balances, orders, or fills. A screenshot of fabricated money data is **not** proof — it is a doctrine violation; reject the PR. If a screen cannot be proven without invented data, the honest artifact is empty or refused state.

---

## 2 · Pro Workbench Scorecard (v3)

**Better = higher score vs a recorded baseline.** No baseline → no “improved” claims.

### 2.1 · Baseline (mandatory at first Orca proof P0.3)

Score `/exchange`, one `uc` money screen, `/dex` — by an agent who will **not** implement the fix. That row is the denominator for every later claim.

### 2.2 · Gates (any fail = slice reject, regardless of total)

| Gate dim | Name                                                      |
| -------- | --------------------------------------------------------- |
| **4**    | Honesty                                                   |
| **11**   | Feed truth                                                |
| **12**   | Irreversible friction                                     |
| **18**   | Recovery & continuity (submit-lock, session, idempotency) |
| **19**   | Numeric integrity                                         |

### 2.3 · Dimensions

| #   | Dimension                        | Better                                                            | Fail                         |
| --- | -------------------------------- | ----------------------------------------------------------------- | ---------------------------- |
| 1   | Time-to-read                     | Core facts &lt;2s                                                 | Hunting                      |
| 2   | Book truth                       | Depth, grouping, click-to-price; thrash-free                      | Decorative book              |
| 3   | Ticket control                   | Precision, fee/est, confirm, rejects                              | Fake success                 |
| 4   | **Honesty (GATE)**               | loading/empty/error/unknown/named refusal                         | Zero wealth when down        |
| 5   | Risk in place                    | Available/locked, uPnL, fee near action                           | Buried risk                  |
| 6   | Density with hierarchy           | Packed + ordered                                                  | Lounge or noise              |
| 7   | Chart as tool                    | TF, overlays, pane track                                          | Wallpaper                    |
| 8   | Craft premium                    | Alignment, mono, restrained motion                                | Glass SaaS, confetti         |
| 9   | Ownable, not clone               | **Crop-logo test:** stranger cannot name competitor               | Pixel clone                  |
| 10  | OS consistency                   | Same craft on money as terminal                                   | Pretty trade, broken account |
| 11  | **Feed truth (GATE)**            | Live/stale/down labeled                                           | Silent live                  |
| 12  | **Irreversible friction (GATE)** | Withdraw review + real confirm control                            | One-tap / bare span          |
| 13  | Plane honesty                    | CEX vs Protocol; DEX not downgrade                                | Fake unity                   |
| 14  | **Input velocity**               | Keyboard **and** pointer economy (clicks-to-order, click-to-fill) | Six-click orders             |
| 15  | Post-trade clarity               | Fills, rejects, open orders                                       | Mystery after toast          |
| 16  | **Latency & responsiveness**     | Input→ack, book cadence, no burst jank                            | Feels slow on busy candle    |
| 17  | **Order lifecycle**              | Cancel-replace, amend, partial fills, drag-reprice track          | Read-only after place        |
| 18  | **Recovery (GATE)**              | Mid-ticket refresh, reconnect, session expiry, double-submit lock | Double withdraw              |
| 19  | **Numeric integrity (GATE)**     | Market-true precision, pinned fraction digits, no float drift     | Silent wrong decimals        |
| 20  | Cost transparency                | Fee schedule / maker-taker / estimate vs charged                  | Hidden cost                  |
| 21  | Cross-surface number agreement   | Same balance agrees or books labeled                              | Terminal ≠ uc money          |
| 22  | Layout ownership & persistence   | Last pair/TF/book mode/panels survive reload                      | Demo amnesia                 |
| 23  | Accessibility floor              | Focus, contrast, reduced motion, keyboard reach                   | Unreachable confirm          |
| 24  | Discoverability without dilution | One hop to fee schedule, history, markets                         | 78 routes, no search         |

### Trade-off order

1. **Gates** 4, 11, 12, 18, 19
2. Ticket/book/risk 2,3,5 · cross-surface 21
3. Latency 16 · time-to-read 1 · density 6
4. Order lifecycle 17 · chart 7 · plane 13
5. Input velocity 14 · layout 22 · post-trade 15 · cost 20
6. Craft 8 · ownable 9 · OS 10 · a11y 23 · discoverability 24
7. Brand accent (never its own line)

**Never sacrifice tier 1–2 for 6–7.**

### Scoring

Non-gate dims score **0–3**. Gates pass/fail. PR must cite baseline delta when claiming improvement.

### False betters

More neon · wallpaper indicators · more tabs · AI agent homepage · retail progressive disclosure as terminal default

---

## 3 · Moment map

| ID  | Moment        | Pass                                             |
| --- | ------------- | ------------------------------------------------ |
| M1  | Open terminal | Pair, last, change, feed, chart, book, ticket    |
| M2  | Read market   | Spread/depth scannable                           |
| M3  | Place order   | Precision; fee or `—`; confirm; reject honest    |
| M4  | Manage        | Open orders / cancel                             |
| M5  | Money out     | Withdraw **review receipt** + real button + lock |
| M6  | Failure       | Backend down never looks rich                    |

---

## 4 · Style systems (N1–N4) — free hands

**Not three accents.** Four complete systems. Universal: green/red market only · accent ≠ PnL · no glass default · no pure `#000` if avoidable · tabular mono · multi-state honesty · reduced-motion

| Code                          | Name              | Thesis                                        | Ownable                   | Risk                                |
| ----------------------------- | ----------------- | --------------------------------------------- | ------------------------- | ----------------------------------- |
| **N1 Instrument**             | Metrological desk | Hairlines, numeric spine, zero blur           | Via spine + honesty pills | Anonymous if weak hierarchy         |
| **N2 Signal** _(recommended)_ | Ink + one voice   | OKLCH ink, one accent in 4 places only        | Discipline as identity    | Adjacent to AI-SaaS if glass creeps |
| **N3 Ledger**                 | Dual-tone         | Dark tape / warm books — doctrine visible     | **Highest**               | 2× craft; can read as two products  |
| **N4 Terminal Zero**          | Density pole      | Chrome-minimal, watchlist rail, dockable grid | Pole for free hands       | a11y / TWS lineage                  |

**Lime:** accent **candidate inside N2**, not a separate “retheme the company” project.  
**Orange #86:** not a direction — legacy residue.

### Styleboard deliverable (Nitro picks in ~60s)

See enhance pack §C — 10 artifacts: direction board, component matrix, **honesty vocabulary matrix (canonical dialect)**, terminal 1440/1920/390, numeric spine, motion card, type specimen, anti-slop self-score, ours-vs-L1 crop, token plan documenting existing `ix-*` classes before inventing tokens.

Form: `docs/styleboard/` static HTML → Orca shots → later `/styleboard` route as proof row 1.

---

## 5 · Honesty vocabulary law (three dialects → one voice)

| Dialect                                 | Where at tip                                      | Rule                                                                |
| --------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------- |
| IxState + module-mixin + REASON         | intafaced modules                                 | **Keep** — do not unwind                                            |
| `ix-empty*` + local loading/error flags | uc money (many), Exchange, OTC, CMS               | Extract to **shared component**, same **REASON words/order/visual** |
| Nothing / raw `$Message`                | Account, Safe, myorder (and listed zero-coverage) | **Fill** with shared vocabulary                                     |

**Do not** “port IxState” by rewriting dialect-2 shipped honesty for zero user gain.

---

## 6 · Anti-slop + anti-under-building

### Banned

Glass as default · multi-hue gradients on data · vibecode purple · hero-metric SaaS · card grids on trade · confetti · fake numbers · accent as PnL · casino yellow identity · Dribbble crypto vocabulary · pure `#000`+`#fff` as default pair

### Required positive recipe

Scan-first hierarchy · mono tabular · market precision · fixed book rows · fee or `—` · four+ honesty states · feed status · steal = **jobs** · solid/hairline surfaces after styleboard

### Anti-under-building PR gates

| Gate                   | Rule                                                                    |
| ---------------------- | ----------------------------------------------------------------------- |
| Gap-audit              | Name what already existed at tip before coding                          |
| Free-hands line        | “Not constrained by legacy #86 orange”                                  |
| Skill disclosure       | If skill shrunk scope, name it + override/accept                        |
| Baseline delta         | Numbers vs P0.3 row when claiming better                                |
| Ambition (Wave B)      | Before/after identical crop; no visible change → fail polish theatre    |
| Reviewer question      | “Would a profitable trader switch venue for this?” one sentence         |
| Under-build stop       | 3 consecutive Wave B PRs with no visible 1440 change → escalate Nitro   |
| Proof coverage honesty | State fraction of routes in proof matrix (today thin — do not oversell) |

### Retail literature

Anti-ref for **terminal default** density. Steal empty/error calm only.

---

## 7 · Leverage

**Reuse → fix → study → vendor-after-vet → never invent.**

### In-repo first (never reinvent) **[tip]**

IxState · module-mixin · REASON · DepthGraph · kline.js LWC 3.8 · ix-_ classes · focus-visible · shipped ix-empty_ · Exchange useBookPrice, symbolFee, confirm modal, submitting, dualbook, favourites · uiproof + **auth-fixture** · brand-scan · stompjs

### Package rule (resolves contradiction)

**No new entries in vendor `package.json` without Denon + NOTICE** — **except** standalone **UMD/IIFE files** under `assets/js/` (same pattern as lightweight-charts).

**bignumber (Wave A withdraw):** ship as **standalone UMD in `assets/js/`** after `vet-repo`. Do not add npm dep to vendor package.json. Golden tests required for money math.

### Delta research (before Wave B, not before plan lock)

Q1 LWC v5 + attributionLogo docs · Q2 iView Drawer/Modal focus as installed · Q3 order-modify API exists? · Q4 indicator golden tests · Q5 fresh L1 for remaining MANUAL (Kraken, IBKR, Kite, Ninja) — OKX already PASS

Not needed: full catalog restart · last30days re-run until Wave B start

---

## 8 · Error kills

Wrong screenshot as ref · stale main · dual agents one tree · Stream B drive-by · fake numbers · **fixture-seeded money as proof** · self-certify money · invent repo · rebuild without gap-audit · #86 as law · retail IA as terminal default · Charting Library restore · CI-from-memory · foreground npm run dev

---

## 9 · Definition of done

### Plan

- [x] Methodology v3 merged
- [x] Plan v3 merged
- [x] agent + Grok tip re-verify
- [ ] Nitro §K yes
- [ ] go implement

### Slice

Gap-audit · Stream A · tip worktree · LIVE-LANES · scorecard/gates · steal jobs if craft · verify real · Orca · money second review · no fake fixture data · lane release

### Program

Outcome demo (desk, fail, uc, withdraw receipt, ticket, open orders, L1 side-by-side, Nitro taste) + style pick applied to desk+money

---

## 10 · Out of scope / sequenced later

| Item                                                             | Status                                                                                                        |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Staff admin console**                                          | **In program as Wave Admin** — after trader Wave A foundation; inventory `04_Web_Admin` vs `apps/admin` first |
| Native iOS/Android                                               | Out                                                                                                           |
| `apps/web` as user product                                       | Named spike only                                                                                              |
| Invent money models / commercial TV Advanced / free-cook futures | Out / Denon                                                                                                   |

---

## 11 · Architecture

| Decision          | Choice                                      |
| ----------------- | ------------------------------------------- |
| Primary UI        | Vue shell :8090                             |
| Money paths       | `components/uc/*` + MemberCenter            |
| Chart             | LWC only; v5 for panes                      |
| Honesty           | One vocabulary; two plumbings OK short-term |
| Proof             | Orca primary                                |
| apps/web          | Named spike, never linked                   |
| Logged-in default | **Desk** (if Nitro yes — default yes)       |

### Shell IA grammar

- **Desk mode** — terminal, watchlist rail, blotter, account rail (auth default)
- **OS mode** — modules, money, identity, help
- **Plane** (CEX ↔ Protocol) orthogonal, always visible

---

## 12 · Orchestra + skills

| Stage      | Model                         | May                                 | Must not                                             |
| ---------- | ----------------------------- | ----------------------------------- | ---------------------------------------------------- |
| Plan       | agent+Grok                    | doc hygiene                         | ponytail shrink; dual taste                          |
| Styleboard | agent                         | one taste as **post** critique      | both taste leading; redesign-existing anchors to old |
| Wave A     | Grok impl; agent certify      | ponytail on **impl diff**; vet-repo | design fashion skills                                |
| Wave B     | Grok; impeccable certify only | one taste certify                   | ponytail on craft scope (override named)             |
| Wave C     | Strong                        | LWC docs                            | second chart vendor                                  |
| Proof      | Orca                          | orca-cli                            | Nitro as runner                                      |

Free hands + scorecard beat skill defaults; name conflicts in PR.

---

## 13 · Parallelization

LIVE-LANES · one worktree · exclusive App.vue/Exchange.vue · append-only en.js/intafaced.css · feat/app-\* · styleboard docs parallel Wave A (not same CSS war)

---

## 14 · One-line lock

```
Pro workbench: dense desk + honesty moat + free hands (N1–N4 systems). Orange not sacred.
Gap-audit every slice — do not rebuild #231–#243. Withdraw math+receipt first.
One honesty vocabulary. bignumber as assets/js UMD. Orca eyes. Tip worktree. Stream A only.
Gates: honesty, feed, irreversible, recovery, numeric. No fake fixture money. No invent. No self-certify.
```

---

_v3 supersedes v2 same day. enhance pack + Grok audit are evidence; this file is law after Nitro yes._
