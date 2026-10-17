# Exchange desk layout — source of truth

**[HISTORY 2026-09-01]** `#3313` landed. Not the live bar. Live: [`FRONTEND-REMAINING-SOT-2026-08-25.md`](FRONTEND-REMAINING-SOT-2026-08-25.md). Do not paste this pack. Do not treat “no TradingView product / LWC 3.8 forever” as current — Advanced Charts is intended (`LICENCE-POSITION.md` §1.1a).

**Status:** BAR for the next craft · **final audit 2026-08-25** (this file §16) · Nitro (“#3301 is garbage / old frontend, now buggy”)  
**Paint:** N4 Terminal Zero stays (near-black, 1px, no glass, no orange). **This file is arrangement, not palette.**  
**Companion:** [`FRONTEND-EXCHANGE-DESK-SOT-2026-08-25.md`](FRONTEND-EXCHANGE-DESK-SOT-2026-08-25.md) (kit, honesty facts, leverage).  
**Wireframe:** [`styleboard/SHOW-LAYOUT.html`](styleboard/SHOW-LAYOUT.html)  
**Codex paste:** [`PROMPT-CODEX-EXCHANGE-DESK-LAYOUT-2026-08-25.md`](PROMPT-CODEX-EXCHANGE-DESK-LAYOUT-2026-08-25.md)  
**Tip at audit:** `origin/main` `f7fbf77bb` `feat(execution): pass/accept/reject a live parent execution owner (#3306)` **[RAN-IT 2026-08-25]** — includes `#3301` N4 paint, `#3280` FOK (merged), `#3281` 390 order. Grok door is **diverged**; Codex uses a **new** `pnpm wt` off this tip, never the door.  
**Product UI:** `vendor/upstream-exchange/05_Web_Front` on `:8090`. No second SPA. Chart host = lightweight-charts **v3.8**. Money = `ledger-client` + `svc-ledger`.  
**SoT pack is untracked on the door** (not on `origin/main` yet). Codex copies these four files into the worktree `docs/` **before** the first edit.

Design read: professional crypto **workbench** for a trader who judges by glance in ~2s. Density cockpit. Motion almost none. N4 paint already on disk. Redesign = **overhaul of IA/layout** on the existing Vue2 Bazaar desk, not a new website.

**Vibe (already set — do not reopen):** N4 Terminal Zero + methodology pro-workbench (2026-07-31). **Composition:** best **jobs** from several venues on **one** INTAFACED desk — not a Hyperliquid clone, not a Binance mall, not an average of five skins.

---

## 0 · Why the last pass failed

We asked Nitro to pick N1–N4 off four **identical mini-desks**. He picked **N4** meaning “dense pro terminal.” We wrote **a skin**. Codex `#3301` remapped orange to gray, squared radii, added a chart-empty banner. The skeleton is still the vendored upstream exchange desk:

Proof (Codex’s own shots, **[RAN-IT]**):

- `.artifacts/uiproof/n4-1440.png` — marketing nav overlapping the chart; white broken tab chips; empty grid; ticket is a policy essay; book pane is an error dump with a raw path `/api/v1/orderbook/...`
- `.artifacts/uiproof/n4-390.png` — same corpse, stacked; Chart tab is a white rectangle; Buy/Sell buried under Spot/Perps/Convert/Follow/Options

That is not a venue. Recolor is not the product.

**Do not revert `#3301` wholesale** unless Nitro says so. Keep N4 paint. The next work is **layout**.

---

## 1 · Unspoken needs (locked; overrule in this file)

1. **Glance test.** A stranger at 1440 must read “pro desk” in ~2 seconds. Feature lists and PR bodies do not count. Pictures count.
2. **Feel, not modules.** 2026 traders evaluate terminals by _feel_ (HyperX, Feb 2026). If it still looks like a CMS with a chart hole, we failed.
3. **Best-of, one desk.** Pick the strongest _job_ from each venue (HL restraint, OKX/Binance grid+tools, Coinbase calm honesty, dYdX chart-as-object, Bybit 390). Never steal their logo, yellow, teal, or layout pixel-for-pixel. Crop-logo test still binds.
4. **Desk mode vs OS mode.** On `/exchange`, marketing chrome dies. Lab / Partner / Announcement / C2C / Language / Platform-as-a-megamenu are OS. They do not sit on the trade surface. (Already locked in methodology 2026-07-31. Never executed.)
5. **Chart owns the screen.** The largest rectangle is the market. Intervals live in that pane. Empty/failed fill the pane as a designed state, not a lost sentence on a void.
6. **Honesty is quiet.** One line. Not a ticket blog (“Matching refuses if this would increase the position. No invented mark.” × 8). Facts stay; essays move behind a `?` or vanish from the default ticket.
7. **Feed down still looks like a desk.** Hyperliquid with a dead book still looks like Hyperliquid. Ours must still look like a terminal when last is `—` and the chart says unavailable.
8. **Bugs are not shipped.** White tab chips, overlapping Log In / Language, page-width overflow = not done. `#3301` claimed 390 with no overflow; the shot shows broken chrome.
9. **He will not pick palettes again.** N4 paint is closed. The next artifact is a **layout picture**, then Codex paints that.
10. **He cannot read code.** “Tokens remapped, 0 orange matches” is not a result. The page is the result.
11. **No fake life.** No invented candles, mids, depth, or balances to make the screenshot pretty.
12. **Ambition survives contact.** If Vue2/iView cannot deliver the 1440 grid, **stop and name the hole**. Do not silently ship “a bit less ugly upstream desk.” Do not start a new SPA unless that hole is written and the leverage law exception is proven.
13. **One writer on `Exchange.vue` / `src/App.vue` chrome.** `#3280` is merged. Do not dual-edit money engines or open Shehzad protocol (`#2473`).
14. **Token spend.** Plan when a hole is real. Do not re-audit leverage. Do not download Node. Do not invent a second `:8090` server. Use existing `pnpm ui:boot` / vendor shell from the **worktree**.
15. **Crop-logo test.** A crop of the desk must not name Binance / OKX / HL. Steal jobs, not skins.
16. **Dense and complete.** A pro must _see and reach_ the full toolset (spot/perps, limit/market/stop/TP/TWAP/scale, book, tape, positions, orders) without hunting. Hierarchy = **size and order**, not hiding. Retail “simple mode” as the terminal default is a methodology false better. What dies is **mall chrome and essays**, not tools.
17. **Pack what tip already wires. Do not invent matching.** On `origin/main` the ticket already has Spot / Perps / Convert / Copy / Options, types Limit · Market · Stop · Stop-limit · Trailing · TP · TWAP · Scale · attached TP/SL, and TIF GTC/IOC/FOK (`#3280` **merged**). L3 = strip + quiet copy. Not new order engines. Options stay **paper-labeled**. `advancedPlanLocked` is a **batch/bracket lock**, not a Simple/Advanced product — do not invent one.
18. **Desk mode is route-scoped.** Kill Lab/Announce/Language/Platform mega on `/exchange` only. The rest of the OS keeps them. Language stays reachable from the account chip or footer.
19. **Proof is the worktree page.** Door `:8090` is the Grok checkout, 168 commits behind tip. Boot with `pnpm ui:boot` from the worktree (`PORT=8091` if 8090 is taken). Shots of the door are not proof.
20. **These SoT files are not on `origin/main`.** Copy the pack from the door into the worktree before coding, or Codex will craft from memory.
21. **Persistence B5 survives L2.** Pair / timeframe / book mode in localStorage must still restore. Layout rewrite is not demo amnesia (scorecard dim 22).
22. **1920 keeps the same ratios.** Not a third grid. Do not fill extra width with mall chrome.
23. **Methodology free-hands ≠ second website.** “Full rebuild of desk allowed” means IA/CSS on Bazaar. [`INTERNET-LEVERAGE-LAW.md`](INTERNET-LEVERAGE-LAW.md) wins: no new SPA, no TradingView product, no Tailwind/shadcn kit.
24. **Graphify does not map vendor Vue.** Open `Exchange.vue` / `src/App.vue` directly. After vendor edits still run `GRAPHIFY_MAX_WORKERS=1 graphify update .` (may no-op Vue; do not treat a miss as “file does not exist”).
25. **One kit: iView 3 + tokens.** If radius-0 breaks tabs, replace **tab chrome on this page**, do not add a second component library.
26. **No “improved” score without a new LIVE row.** Glance test is the ship gate. Scorecard law still binds — attach 1440/390 shots; do not claim dims went up from a PR body.
27. **Fees / decimals / dual-book / owner blanks stay honest.** Fee `?` already exists. Do not invent a rate. Numeric gate 19. Dual-book labels stay. Auth fixture never seeds money.
28. **Keyboard + skip-link stay.** B7 is inventory. Place a limit in ≤2 clicks **and** keep `/` `B` `S` `T` Enter `⌘K`.
29. **Motion almost none.** Respect reduced-motion. No confetti, no chart thrash.
30. **This program is `/exchange` only.** Do not restyle login, CMS, academy, admin, or money screens in the same PR. OS consistency is later, not L0–L7.

---

## 2 · Landscape 2026 — jobs we steal (not stacks)

Sources this session + **re-fetched 2026-08-25 [WEB]:** OneKey HL-vs-CEX (2026-05-12, still live) — four cores, no ads, CEX default often 10+ modules. Coin Bureau HL review (2026-03) — “dense at first; built for people who already trade.” Quicknode HL terminals (2026) — ~40% of HL flow uses a third-party terminal **because native is chrome-minimal; serious terminals add TWAP / scale / hotkeys** (this is the job we already have on tip, not a reason to clone HL poverty). Aggregator roundups (Bookmap / Exocharts / TradingView) are **analysis overlays**, not our product shell — Wave C. **Do not adopt TradingView** because HL/Binance embed it; our host is LWC 3.8 (leverage law). Not a shopping list.

| Venue                                                               | Job to steal                                                                                                                                                                            | Job we refuse                                                                                                          |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Hyperliquid**                                                     | No ads / no campaign banners on the trade route. Four **cores** always on screen. Chrome restraint — not tool poverty.                                                                  | Their stack, perps-only IA, “connect wallet” as the product, hiding CEX-class order types                              |
| **OKX / Binance / Bybit**                                           | Chart-left dominance; book+ticket right; blotter under chart. Depth shading. One-click close. Fast ticket. **Full pro toolset on the desk** (order types, TIF, TP/SL, tape, positions). | Promo strips, “platform as mall,” 12 marketing nav items. Tools stay; mall dies.                                       |
| **Coinbase Advanced**                                               | Calm empty/error. Failed fetch does not look rich. **Copy** is short.                                                                                                                   | Retail progressive disclosure as our **terminal default**                                                              |
| **dYdX**                                                            | Chart as the object; chrome thin.                                                                                                                                                       | Pixel clone                                                                                                            |
| **Lighter V3 (Jul 2026)**                                           | Nav / market / workflow refresh that still reads as a **tool**. “Rejects the swap-box aesthetic.”                                                                                       | ZK/L2 story as UI                                                                                                      |
| **2026 “pro terminal” aggregators** (Hyperdash, d.Terminal, Genius) | Saved layouts, command palette, all-in-one window                                                                                                                                       | Widget canvas, 13-panel drag-drop, news maps as **slice 1**. That is Wave C. Our **default grid** must be right first. |

**Consensus job (every serious desk in 2026):**

```
[ pair | last | chg | feed ]     [ account chip ]
[ markets ] [           CHART (biggest)           ] [ book ]
            [           CHART                     ] [ tape ]
            [           blotter: pos / orders     ] [ TICKET ]
```

Chart is ~50–60% of the canvas. Ticket is a **column**, not a manifesto. Markets are a rail or a pair-dropdown, not a novel.

**Anti-consensus (what CEX defaults do and we must not):** promo carousel, 12 nav items on the trade page, language picker covering Buy, six product mode buttons (Spot/Perps/Convert/Follow/Options) eating the ticket, honesty essays, white iView chips.

### 2.1 · Vibe already locked (do not re-pick)

From methodology 2026-07-31 (Nitro yes on 1–7) + N4 pick 2026-08-25:

| Already set                | Meaning on this desk                                                                                                                                                        |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pro workbench              | Built for people who trade for a living, not a marketing site with a chart                                                                                                  |
| **N4 Terminal Zero**       | Near-black, 1px hairlines, chrome-minimal, watchlist rail, no glass, no orange. Density pole — TWS lineage is a _risk to manage_ (a11y), not a reason to add lounge padding |
| Green / red = market only  | Accent is not PnL. N4 accent is gray chrome; up/down stay `#0ecb81` / `#f6465d`                                                                                             |
| Ownable (scorecard dim 9)  | Crop of `/exchange` must not read as “that’s Binance / OKX / HL.” INTAFACED honesty + N4 + our grid are the identity                                                        |
| Honesty moat (gates 4, 11) | Facts stay. Presentation is quiet (this file §8)                                                                                                                            |
| Desk before CMS            | `/exchange` is the product. Lab/Announce/Partner do not sit on it                                                                                                           |
| Free hands                 | Prior upstream-exchange chrome is **inventory**, not sacred. Bazaar _kit_ is still law (no new SPA)                                                                         |
| False betters              | Neon, wallpaper indicators, more tabs, AI homepage, retail progressive disclosure as the **terminal default**                                                               |

N2 was the methodology _recommendation_. Nitro **overruled** it with N4. Closed.

### 2.2 · Best-of jobs (compose — this is the product)

One desk. Each venue donates **one job**. Default view is the composition. Depth of tools is **on the first screen as packed strips** — not behind Advanced, not a second product.

| Job                                                            | Take from                                  | How it shows here                                                        | Do not take                                                                                  |
| -------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Chrome restraint / no ads on trade                             | **Hyperliquid**                            | Desk mode §4. Four cores visible. Mall nav gone                          | Perps-only, wallet-connect as identity, their teal                                           |
| Default grid: chart left-big, book+ticket right, blotter under | **OKX + Binance** (the good part of CEX)   | §5 1440 grid                                                             | Promo strips, 10+ default modules, yellow/gold identity                                      |
| Book as a tool (depth bars, click-to-price, grouping)          | **Binance / Bybit / OKX**                  | Already in `Exchange.vue` — keep and densify (L5)                        | Decorative book, fake depth                                                                  |
| Fast place / one-click close / input velocity                  | **Bybit + Binance**                        | Ticket §10; keyboard B7 stays                                            | Casino chrome, copy-trading as homepage                                                      |
| Calm empty / error; **copy** stays short                       | **Coinbase Advanced**                      | Quiet honesty §8 — one line, not a blog. Toolset stays full.             | Retail “simple vs advanced” as two products; Simple-app spreads; cutting TWAP “to look calm” |
| Chart as the object                                            | **dYdX + HL**                              | Chart fills pane; intervals in-pane (L4)                                 | Pixel clone, TradingView product                                                             |
| 390 that is still a desk                                       | **Bybit mobile** (clean) + our §6          | Pair, chart, book, ticket — no button farm                               | A second mobile app                                                                          |
| Command palette / later saved layout                           | **2026 terminals** (Hyperdash, d.Terminal) | ⌘K exists; widget canvas = Wave C                                        | 13-panel drag-drop as slice 1                                                                |
| **Our job (not stolen)**                                       | INTAFACED                                  | Honest `—` / down / unknown; dual-book labeled; ledger as the only money | Invented live-ness                                                                           |

**Composition rule:** `/exchange` is a **packed cockpit**. HL donates _what is not on the page_ (mall). OKX/Binance donate _what is on the page_ (every pro control, ordered). Coinbase donates _how failure looks_ (calm, short). Packing ≠ dumping: a 11px type strip is density; six fat tiles and eight policy paragraphs are noise. If a PR hides TWAP/stop/TP/positions “for cleanliness,” it fails. If it looks like a gray upstream-exchange mall, it fails. If it looks like a paste of Hyperliquid, it fails.

**Quality gates for this program** (methodology dims, desk-only): 1 time-to-read, 6 density+hierarchy, 7 chart-as-tool, 8 craft (alignment, mono, no glass), 9 ownable, plus honesty/feed gates. Never sacrifice 4/11 for 8.

---

## 3 · What we keep (leverage)

| Keep                                  | Where                                                                          |
| ------------------------------------- | ------------------------------------------------------------------------------ |
| Vue2 Bazaar shell `:8090`             | `05_Web_Front` · header in `src/App.vue`                                       |
| Route `/exchange` + `/exchange/:pair` | `src/config/routes.js`                                                         |
| Page `Exchange.vue`                   | pair, chart `#ix_kline`, book, tape, `#ix-ticket`, blotter — **already exist** |
| LWC 3.8                               | `assets/js/market-chart/`                                                      |
| Honesty facts                         | `ix-empty*`, `IxState`, feedLive, chartStatus ok/empty/failed                  |
| N4 tokens                             | `intafaced.css` `:root` after `#3301`                                          |
| Command palette                       | already in shell                                                               |
| Desk prefs B5                         | localStorage pair/TF/book mode                                                 |
| Skip-link, keyboard B7                | keep                                                                           |

**Forbidden rebuild:** new SPA, TradingView product, Tailwind/shadcn kit, second chart vendor, second money book, fixture-seeded candles.

---

## 4 · Desk mode (the IA we never shipped)

**On routes `/exchange` and `/exchange/:pair` the shell is Desk.**  
**Everywhere else the shell may be OS** (money, OTC, lab, cms).

### 4.1 Kill on Desk (must not appear at 1440)

From live `#3301` shot + `App.vue` links on tip **[RAN-IT]:**

| Kill on `/exchange`                                                  | Why                                             | Still reachable                                             |
| -------------------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------- |
| Lab                                                                  | Marketing on a trade surface                    | OS / ⌘K                                                     |
| Announcement                                                         | Same                                            | OS                                                          |
| C2C / OTC as a primary nav peer of Exchange                          | Splits the desk                                 | OS                                                          |
| Language megamenu covering the ticket                                | Bug + mall chrome                               | Footer or account chip                                      |
| Platform megamenu covering the chart                                 | Same                                            | Account chip                                                |
| Log In / Sign Up as floating layers over the chart                   | Bug                                             | One account chip, top-right                                 |
| “CEX · custodial / DEX · non-custodial” as a fat overlapping control | Plane is orthogonal; it must not cover the pair | Thin plane switch in the header, one row, never overlapping |
| Partner / invite as header                                           | Mall                                            | OS                                                          |
| White iView tab chips                                                | Defect from radius-0 + leftover kit             | Restyle or replace tab chrome **on this page**              |
| Ticket policy paragraphs                                             | Honesty dump                                    | `?` popover or help route                                   |
| Raw API paths in the book pane (`/api/v1/orderbook/...`)             | Engineer UI                                     | One human line + optional `details`                         |

### 4.2 Header that is allowed on Desk (one row, ≤ 48px)

`INTAFACED` wordmark · **pair** · **last** · **change** · **feed chip** · thin **plane** (CEX/DEX) · **account chip** (Sign in **or** session).

Nothing else. Language, lab, announcements are not in this row.

---

## 5 · 1440 grid (the picture)

Viewport **1440 × 900**. No horizontal page scroll. No overlapping layers.

```
Y0   HEADER  48px   pair | last | % | feed | plane | account
Y48  BODY    flex
     L 200px MARKETS rail (search + list)     hideable; pair-dropdown can replace on narrow
     C  flex  CHART pane  (min 52% of body width, min-height 420px)
              BLOT  120px  Positions | Open orders | History
     R 300px  BOOK + TAPE (tabs, both one click)
              TICKET packed: mode strip · side · type strip · TIF · price · amount · TP/SL · submit
```

Exact px may flex ±16. Ratios may not invert (ticket must not be taller than the chart).

**Z-index:** header 20, ticket 10, menus 30 **inside their chip**, never covering the chart unless the user opened that chip.

**Type:** tabular nums on last, book, ticket. Body 12–13px. No 15px marketing.

**Radius:** 0 on the desk (N4). If iView tabs break, **replace the tab chrome**, do not restore 14px glob.

---

## 6 · 390 grid

Document order, no sticky ticket covering the chart (that lesson from `#3281` stays):

1. Header (pair, last, feed)
2. Chart (full width, min-height 240)
3. Book (collapsed summary + expand)
4. Ticket — full type strip + Buy/Sell + amount + submit; modes as one compact row, not six fat tiles
5. Blotter

No white chips. No page-width overflow. Every pro control still **reachable** without a second page.

---

## 7 · Surface law (complete set)

| Surface                                                   | Now (post-3301)                                      | Must become                                                                                                                                                                                                                                            | Forbidden                                                                             |
| --------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| Pair                                                      | In header + drawer                                   | Header object; click opens markets                                                                                                                                                                                                                     | Hidden behind CMS nav                                                                 |
| Last / change                                             | `—` when no ticker                                   | Same honesty; **large**, next to pair                                                                                                                                                                                                                  | Tiny, truncated by overlapping menus                                                  |
| Feed                                                      | “NO FEED · NOT LIVE PRICES”                          | One chip: Live / Stale / Down                                                                                                                                                                                                                          | A sentence wrapping the header                                                        |
| Markets                                                   | Left rail + “unavailable — not empty”                | Keep honesty; density of a watchlist                                                                                                                                                                                                                   | Empty void 200px wide with 2 lines                                                    |
| Chart                                                     | Grid + banner + attribution in the void              | Pane chrome = Chart/Depth/Book/Trades **plus** 1m 5m 15m 1h 1D inside the pane. Empty/failed = **full-pane designed state** (title + one line). Attribution 11px in the pane footer                                                                    | Wallpaper; attribution as the hero; white Chart tab                                   |
| Book                                                      | Error essay + raw URL                                | Human one-liner if down; ladder if up; click-to-price stays                                                                                                                                                                                            | Fake depth; HTTP path as UI                                                           |
| Tape                                                      | Tab                                                  | Keep as tab in the chart pane or right rail                                                                                                                                                                                                            | Fake prints                                                                           |
| Ticket                                                    | Fat tiles + essays + types already on tip (`hlplus`) | **Packed cockpit:** mode strip (Spot Perps Convert Copy Options) · Buy/Sell · type strip (Limit Market Stop Stop-lmt Trail TP TWAP Scale TPSL) · TIF GTC/IOC/FOK compact · Price · Amount · Submit. Copy/clientOrderId behind 11px `More`. Essays gone | Policy paragraphs; six fat tiles; **hiding** stops/TWAP; inventing new matching types |
| Pro tools (TWAP, scale, OCO, GTD, copy, options, convert) | Always-on wall or buried                             | **Visible as a strip** — one click, no new page. GTD/GTT expire only when that TIF is selected                                                                                                                                                         | Hidden forever; or a manifesto always open                                            |
| Blotter                                                   | Honest “sign in for ledger”                          | Keep. One line + link. Tabs: Positions / Orders / History                                                                                                                                                                                              | Fake balances                                                                         |
| Plane                                                     | Overlapping CEX/DEX control                          | One compact switch in header                                                                                                                                                                                                                           | Covering the pair                                                                     |
| Honesty                                                   | Loud, many                                           | Quiet, one line, same vocabulary (loading / empty / error / unknown)                                                                                                                                                                                   | Failed fetch as `$0` or as a blog                                                     |
| Keyboard                                                  | B7 exists                                            | Keep                                                                                                                                                                                                                                                   | Six-click orders as the only path                                                     |

---

## 8 · Honesty presentation (new)

Facts do not change. **Presentation does.**

| State          | Visual                                                                                              |
| -------------- | --------------------------------------------------------------------------------------------------- |
| loading        | Skeleton in the **shape of the widget** (book rows, chart pane), not a spinner party                |
| empty          | “No trades yet” / “No candles for this market” — full pane, still a pane                            |
| error / down   | “Book unavailable” / “Chart unavailable” — **one line**. Optional `Details` disclosure for endpoint |
| unknown        | `—`                                                                                                 |
| unauth blotter | “Sign in for balances” + link                                                                       |

Ticket: if a field is refuse-closed (blank owner number), show `—` or disable with a **6-word** reason, not a paragraph.

---

## 9 · Chart law

- Host stays **LWC 3.8** in `kline.js`. Wave C = v5 panes. Not now.
- Three states: `ok` / `empty` / `failed`. Never synthesize candles.
- When `ok`, the widget **fills** `.ix-chart-body` (height 100%, no black letterbox).
- Intervals are **in-pane**, not a lost white chip.
- Attribution stays (Apache-2.0), footer of the pane, not the focal object.
- `#3301` crosshair decoration on empty is optional; it must not read as a broken chart.

If LWC cannot fill the pane honestly: **stop, name the hole**. Do not swap vendors.

---

## 10 · Ticket law

**Dense and complete.** A pro sees the toolset. A beginner is not the default audience.

Must be on the ticket **without opening a drawer** (compact strips, 11px, one row each). Names = **tip `Exchange.vue` today**, pack them, do not invent:

- Mode: Spot · Perps · Convert · Copy · Options (options stay paper-labeled)
- Side: Buy · Sell
- Type: Limit · Market · Stop · Stop-limit · Trailing · TP · TWAP · Scale · attached TP/SL
- TIF: compact select GTC / IOC / FOK (default GTC). `#3280` **merged** — restyle the select; do not rewrite the place engine.
- Price · Amount · submit

`More` (11px) may hold copy IDs, clientOrderId, reduce-only, post-only — not the order types themselves.

`advancedPlanLocked` already disables the ticket during batch/bracket — leave that meaning. Do not add a Simple/Advanced product toggle.

Place a limit in ≤ 2 clicks after focus **and** a TWAP in ≤ 3. Hunting = fail. Essays = fail. Fat tiles = fail.

---

## 11 · Plan completeness — slices (named, in order)

Each slice: one visible 1440 change, Orca 1440 + 390, **new** `pnpm wt` off **current** `origin/main`, never the door, never a homemade `:8090` server.

**Boot (worktree):** `pnpm ui:boot` → `http://127.0.0.1:8090/exchange/btc_usdt`. If the door already owns 8090: `PORT=8091 pnpm ui:boot`. Proof URL is **this process**, not the door tab.

| ID     | Slice                                                                    | Files (start here on **tip**)                                      | Done when                                                                                                            |
| ------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| **L0** | Kill visual defects from `#3301` (white chips, overlapping menus)        | `src/App.vue`, `src/assets/css/intafaced.css`, exchange tab chrome | No white rectangles; header does not cover chart                                                                     |
| **L1** | **Desk mode chrome** — `/exchange` header = §4.2 only                    | `src/App.vue` (nav is here, not `pages/App.vue`)                   | Lab/Announce/C2C/Language/Platform mega gone **on this route**; still on OS routes                                   |
| **L2** | **1440 grid** §5 — chart ≥ 52% width, ticket column, blotter under chart | `src/pages/exchange/Exchange.vue` + `intafaced.css` `.ix-terminal` | Crop matches `SHOW-LAYOUT.html`; B5 prefs still restore                                                              |
| **L3** | **Ticket packed** §10                                                    | `Exchange.vue` `#ix-ticket` only — restyle existing types          | Full type+mode strips visible (tip already has them); no essays; limit in 2 clicks, TWAP in 3; no new matching types |
| **L4** | **Chart as tool** §9                                                     | `Exchange.vue` chart chrome + `kline.js` **host size only**        | Intervals in pane; empty/failed is a designed full pane; LWC 3.8 stays                                               |
| **L5** | **Book + tape density**                                                  | `Exchange.vue` book rail                                           | Human down-state; ladder when live; no raw paths                                                                     |
| **L6** | **390** §6                                                               | same CSS                                                           | No overflow; no white chips; Buy not below six fat mode tiles; every type still reachable                            |
| **L7** | **Quiet honesty** §8                                                     | `src/assets/lang/en.js` + ticket notes                             | No policy paragraphs on the default ticket; facts unchanged                                                          |

**Not in this program:** admin, academy, CMS, login restyle, new SPA, TradingView, LWC v5, drag-save widget canvas, inventing feed data, rewriting TIF/FOK/TWAP/scale **engines**, futures matching, graphify as the deliverable, `#2473` protocol paths.

**Do not** start L2 until L0+L1 are visibly true. Chrome-on-top of a new grid is how `#3301` died.  
**Do not** dual-edit `Exchange.vue` ticket engines. Open PRs at audit: `#2473` Shehzad protocol, dependabot maven — **no path intersect** with this desk.

---

## 12 · Proof

- Orca **1440** and **390** of `/exchange/btc_usdt` from the **worktree** shell (`pnpm ui:boot`; `PORT=8091` if 8090 is the door).
- Compare to `SHOW-LAYOUT.html`.
- Compare jobs (not pixels) to L1 refs: `docs/styleboard/l1/A1-hyperliquid.png`, `A2-coinbase.png`, `A5-okx.png`.
- Fail if: overlapping chrome, white chips, ticket essay, chart void with a lost label, page scroll sideways, fake candles, hidden TWAP/stop, invented perps/matching, shots of the **door** instead of the worktree.
- Auth fixture: real session only. Never seed balances/orders/candles to pretty the crop.

---

## 13 · Approaches we considered

|     | Path                                            | Verdict                                                                                                |
| --- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| A   | More recolor / N4 polish                        | **Failed.** That is `#3301`.                                                                           |
| B   | **Desk-mode + 1440 grid on Bazaar** (this file) | **Take.** Ambition without a second website.                                                           |
| C   | New SPA / new chart product                     | **Forbidden** unless a written hole proves Bazaar+LWC cannot do §5–§9. “I prefer React” is not a hole. |

---

## 14 · Flip

This pack is wrong if Nitro says the wireframe is not the desk he meant; if LWC cannot fill the pane (then stop, don’t swap); if a second SPA is later law (ADR); if a new open PR owns `Exchange.vue` ticket engines (then L3 waits — `#3280` is **merged**, not a wait).

---

## 15 · Codex

Paste [`PROMPT-CODEX-EXCHANGE-DESK-LAYOUT-2026-08-25.md`](PROMPT-CODEX-EXCHANGE-DESK-LAYOUT-2026-08-25.md).  
**New** `pnpm wt` off **current** `origin/main` (`f7fbf77bb` or newer). Do not reuse `feat-exchange-terminal-zero`. Do not edit the Grok door. Copy this SoT pack into the worktree first.

---

## 16 · Final audit (2026-08-25) — peace of mind

**Verdict:** this file + `SHOW-LAYOUT.html` + the layout Codex prompt **are** the build bar. `#3301` was the wrong job (skin). Approach B (desk-mode + 1440 grid on Bazaar) is still the take. Codex may start **after** the pack is copied into a new worktree.

### What was already right (keep)

| Lock                        | Why it stands                                                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Bazaar `:8090` only         | Phase A / leverage law. No second SPA.                                                                                                |
| LWC 3.8 in-shell            | HL/Binance use TradingView — we steal **chrome jobs**, not their chart product.                                                       |
| N4 paint                    | Nitro pick. `#3301` landed `--ix-bg: #000` **[RAN-IT tip]**. Do not recolor.                                                          |
| Honest `—` / down / unknown | Doctrine. Presentation gets quiet (this file §8).                                                                                     |
| Best-of **jobs**            | OneKey 2026-05 still live: four cores, no ads. CEX donates grid + full types. Coinbase donates calm **copy**.                         |
| Dense and complete          | Nitro 2026-08-25. Confirmed by 2026 HL-terminal market: TWAP/scale **are** what a serious desk adds. Tip **already has** those types. |
| Slices L0→L7 in order       | Chrome before grid. `#3301` died by skipping IA.                                                                                      |

### Holes this audit closed (were going to poison Codex)

| Hole                                                                                                                                                             | Fix                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| §2.2 said tools live behind **Advanced**                                                                                                                         | Contradicted need 16. Deleted. Types stay on screen.                                |
| Coinbase “short ticket” read as fewer tools                                                                                                                      | Means short **copy**. Toolset stays full.                                           |
| Companion SoT tip SHA `845fd3465` / “still orange” / first slice = paint                                                                                         | Stale vs `#3301`. Companion retargeted to **this** bar.                             |
| `#3280` listed as open wait                                                                                                                                      | **Merged** 2026-08-25. Pack TIF; don’t rewrite engine.                              |
| Inventory from **door** `Exchange.vue` (~limit/market only, no perps)                                                                                            | Door is 168 commits behind. Tip has Perps + full hlplus types. Codex reads **tip**. |
| SoT pack untracked / missing in `pnpm wt`                                                                                                                        | Need 20 + Codex prompt: copy first.                                                 |
| Proof on door `:8090`                                                                                                                                            | Need 19 + boot recipe.                                                              |
| Methodology “full rebuild allowed” vs leverage “no new SPA”                                                                                                      | Need 23: craft on Bazaar.                                                           |
| Missing implicit: B5 persist, 1920, iView kit, graphify miss, options-paper, scorecard row, OS-scoped chrome, fees/dual-book, keyboard, motion, `/exchange`-only | Needs 17–30.                                                                        |
| `App.vue` path                                                                                                                                                   | `src/App.vue` on tip, not `pages/App.vue`.                                          |
| SCORECARD / STATE-OF-TRUTH / Design Bar still pointing at paint SoT / P21                                                                                        | Pointers retargeted same turn.                                                      |

### Internet leverage (not vibed)

- **IN** path `web.terminal`: tracker **done** for **wiring** (2026-08-22). Look residual = this file. Done ≠ pro look.
- Keep: V-SHELL, `Exchange.vue` surfaces, LWC 3.8, `ix-depth-feed`, ledger-client, iView 3, `pnpm ui:boot` (Node 18 via existing `STREAM_A_NODE` / `.tools/node18` — **no Node download**).
- Steal **jobs** (HL no-mall, OKX grid, Coinbase calm copy). Do not npm a terminal, Bookmap, TradingView, Hyperdash widget canvas.
- Phase B `trade.futures` is **LAW→IN** later — Perps **mode already exists** on the tip ticket; do not build a second futures matching book in this program.
- Forbidden rebuild list in §3 stands.

### Methodology + tools (right ones)

| Use                                                                   | Do not use as the bar                                                                                         |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| This file + SHOW-LAYOUT + companion kit/honesty                       | Old GO-READY / P21 / paint-first Codex prompt                                                                 |
| `FRONTEND-MASTER-METHODOLOGY` for **gates** (4, 11, 19) and scorecard | Its “code none until go” and P21 color-first — stale as live state                                            |
| Design Bar: one kit, no fake prices, empty ≠ zero                     | Its “P21 teal now” line                                                                                       |
| Orca 1440 + 390 as eyes                                               | PR body, hex lists, “0 orange matches”                                                                        |
| `pnpm ui:boot` in the worktree                                        | Homemade webpack server, second Node                                                                          |
| Graphify after code; open Vue files directly                          | Graphify as search for `Exchange.vue`                                                                         |
| last30days cookie wizard                                              | **Skipped** — would block Nitro. Landscape re-checked via live web (OneKey, Coin Bureau, Quicknode) **[WEB]** |

### Scope completeness (named — in vs later)

**This program (L0–L7):** desk chrome, 1440/390 grid, packed existing ticket, chart pane as tool, book/tape density, quiet honesty.

**On tip, keep, don’t rebuild:** pair drawer `#3281`, depth feed, blotter sign-in, command palette, skip-link, B5 prefs, fee `?`, sub-account selector, convert/copy/options/perps **modes**.

**Wave C / not this PR:** LWC v5 RSI-MACD, saved widget canvas, Trailing-as-new-engine, login/CMS restyle, academy, admin, `04_Web_Admin`, drag-13-panel, fake live-ness.

**Human / other owners:** `#2473` Shehzad protocol — don’t touch. Owner blanks (jurisdictions, live fee schedule magnitudes) stay refuse-closed.

### Residual risks (honest)

1. Vue2/iView may fight the 1440 grid — then **stop and name the hole**, don’t ship a smaller upstream desk, don’t start a SPA.
2. Door vs tip confusion — mitigated by copy-pack + PORT recipe; still the #1 Codex failure mode.
3. Crop-logo test: packed CEX types + N4 can still read as “gray Binance.” Ownable = honesty + no yellow/teal clone + our grid.
4. These docs are **uncommitted**. Next cold chat on a clean worktree will not see them until copied or landed in a docs PR (separate, not this craft PR unless Codex includes them).

**Go bar:** paste the layout Codex prompt into a **new** Codex on a **new** worktree off current `origin/main`. First visible: header no longer covers the chart, crop matches `SHOW-LAYOUT.html`.
