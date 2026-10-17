# Exchange trader desk — source of truth

**[HISTORY 2026-09-01]** Honesty/kit facts may still be true; **not** the live execution map. Live: [`FRONTEND-REMAINING-SOT-2026-08-25.md`](FRONTEND-REMAINING-SOT-2026-08-25.md) §§9–21. Chart: Advanced Charts pending, LWC interim (`LICENCE-POSITION.md` §1.1a). Do not treat LWC 3.8 or “never TradingView” lines below as current.

**Status:** N4 **paint** landed (#3301) · **desk look FAILED** · **this file = kit / honesty / leverage facts only** · craft bar = [`FRONTEND-EXCHANGE-DESK-LAYOUT-SOT-2026-08-25.md`](FRONTEND-EXCHANGE-DESK-LAYOUT-SOT-2026-08-25.md) (final audit §16 2026-08-25)  
**Date:** 2026-08-25  
**Tip at audit:** `origin/main` `f7fbf77bb` **[RAN-IT]** — includes `#3281` 390, `#3301` N4, `#3280` FOK merged, `#3306`. Door is diverged; do not treat door `Exchange.vue` as tip inventory.  
**Live page this session:** Orca tab `http://127.0.0.1:8090/exchange/btc_usdt` is the Grok **door**, not tip. Codex boots from a **new** `pnpm wt`.  
**Do not use this file as the Codex craft bar.** Layout SoT + `SHOW-LAYOUT.html` win. This file still wins for kit, honesty, and “what not to rebuild.”

Shots from this pass: `docs/styleboard/shots/desk-sot-2026-08-25/1440-exchange-btc_usdt.png` · `390-exchange-btc_usdt.png`  
Pick artifact: `docs/styleboard/VIEW-PICK.html`

---

## 1 · Verdict

**#3301 did the wrong job.** It remapped orange → gray and squared corners. The page is still the vendored upstream exchange desk: marketing nav, overlapping menus, empty chart, ticket as a policy essay, broken white tab chips. Nitro is right. Proof: worktree `.artifacts/uiproof/n4-1440.png` / `n4-390.png`.

**The idiot move:** we asked him to pick N1–N4 off four _identical_ mini-desks. He picked **dense terminal**. We encoded **a skin**. Codex shipped the skin.

**Still true:** Bazaar `:8090` is the product. LWC v3.8 is the chart. Ledger is the book. No new SPA. N4 _paint_ (near-black, no orange, no glass) can stay.

**The real bar:** `/exchange` at 1440 must read as a pro venue in ~2s — Hyperliquid/OKX _jobs_ (chart dominates, book+ticket tight, marketing chrome gone on this route). Honesty stays; it must be _quiet_ (one line), not a wall of refuse copy.

Do not start a second website. Do not pick another palette. Next craft is **layout / IA / chrome-kill on Exchange.vue**, then the chart pane as a tool.

---

## 2 · What the desk is

The product UI is the vendored Bazaar trader shell:

`vendor/upstream-exchange/05_Web_Front` on **:8090**  
Route: `/exchange` and `/exchange/:pair` (`src/config/routes.js`)  
Page: `src/pages/exchange/Exchange.vue` (~7.3k lines on tip) **[RAN-IT]**

`apps/web` is deleted. Do not resurrect it.

What a pro must see (all already exist as surfaces — craft them, do not replace them):

| Surface                 | What it is on the page                                                                                                                                   | 1440             | 390 (live)                        |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | --------------------------------- |
| Pair                    | `ix-pair` / `ix-pair-switch` — BTC/USDT, star, caret opens market drawer (#3281)                                                                         | header           | top card                          |
| Last                    | `ix-last` — `—` when no ticker                                                                                                                           | header           | `—`                               |
| Change                  | 24h change / high / low / volume — labeled **snapshot**, not live depth                                                                                  | header           | `—` + “No feed · not live prices” |
| Feed                    | `ix-head-status` — Live vs down. Must stay honest                                                                                                        | header           | visible                           |
| Chart                   | `#ix_kline` + LWC v3.8. States: `ok` / `empty` / `failed`. Live failed copy: “Chart unavailable — the venue did not answer. This is not a blank market.” | huge black pane  | same, stacked                     |
| Book                    | rail + full tab; click-to-price; grouping; depth bars; spread; `IxState` when unreachable                                                                | right/centre tab | tab                               |
| Tape                    | Trades tab `ix-trades-full`                                                                                                                              | tab              | tab                               |
| Ticket                  | `#ix-ticket` Buy/Sell, Limit/Market/Stop/TP/TWAP/Scale, TIF, ledger labels                                                                               | right rail       | below fold                        |
| Empty / loading / error | `ix-empty*` + `IxState` + chart overlay. Failed fetch ≠ blank market ≠ `$0`                                                                              | yes              | yes                               |
| Blotter                 | Balances / positions / open orders / history — unauth: “No platform session… Go to platform session”                                                     | under chart      | under chart                       |
| Markets                 | watchlist rail + USDT/BTC/ETH filter; #3281 drawer                                                                                                       | left / drawer    | drawer from pair                  |

---

## 3 · Leverage table

Default path = **IN** (`web.terminal` Phase B). Tracker row `web.terminal` is **done** for wiring (2026-08-22 note) **[RAN-IT `tooling/tracker/features.mjs`]**. Done ≠ pro look. Peace audit: do not launder tracker-green into “venue finished.”

| Surface              | In-repo asset                                                                                                                                              | Keep / extend / replace                                              | Forbidden rebuild                                                                                                                         |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Shell / IA           | `05_Web_Front` · `App.vue` · `:8090`                                                                                                                       | **Keep.** Extend chrome                                              | New SPA, `apps/web`, second kit (Tailwind/shadcn/Radix)                                                                                   |
| Pair / last / change | `Exchange.vue` header                                                                                                                                      | **Keep** honesty (`—`, snapshot label)                               | Fake ticker so the header “looks live”                                                                                                    |
| Feed                 | `feedLive` + `ix-depth-feed.js` + `svc-ws`                                                                                                                 | **Keep.** `feedLive` only after snapshot                             | Invented depth                                                                                                                            |
| Chart                | `assets/js/market-chart/kline.js` + `lightweight-charts.standalone.production.js` **v3.8.0** **[RAN-IT]** · `kline-ohlcv.js` · `GET /api/v1/ohlcv/:symbol` | **Extend chrome.** Wave C = LWC **v5** panes (written plan, not now) | TradingView Charting Library / commercial product / second chart vendor unless LWC is **proved** unable — then **stop and name the hole** |
| Depth graph          | `components/exchange/DepthGraph.vue`                                                                                                                       | **Keep**                                                             | Decorative fake mountain                                                                                                                  |
| Book                 | `Exchange.vue` book + `useBookPrice` + `ix-depth-feed.js`                                                                                                  | **Keep / extend** grouping already shipped                           | Fake ladder                                                                                                                               |
| Tape                 | `Exchange.vue` trades tab                                                                                                                                  | **Keep / extend**                                                    | Fake prints                                                                                                                               |
| Ticket               | `#ix-ticket` + `ix-*-ticket.js` goldens                                                                                                                    | **Keep.** Path-intersect **#3280** (FOK, open)                       | Silent fill, invented fee, JS `number` money                                                                                              |
| Honesty              | `FRONTEND-HONESTY-VOCABULARY-A1` · `IxHonestState.vue` · `IxState` · `ix-empty*`                                                                           | **Keep one vocabulary**                                              | Failed fetch as empty or `$0.00`                                                                                                          |
| Money                | `packages/ledger-client` + `svc-ledger` only                                                                                                               | **Keep.** Ticket shows `—` / sign-in                                 | Second book, Java wallet as truth, fixture-seeded balances                                                                                |
| Tokens               | `src/assets/css/intafaced.css` `:root` after `#3301`                                                                                                       | **Keep N4.** Do not recolor                                          | Half-applied leftover orange as a “new look”                                                                                              |
| 390                  | #3281 document-order + pair drawer                                                                                                                         | **Extend**                                                           | A second mobile app                                                                                                                       |
| Admin                | `04_Web_Admin`                                                                                                                                             | Out of this pack                                                     | New ops console                                                                                                                           |
| Chart v5 / RSI-MACD  | `FRONTEND-LWC-V5-PLAN-A6`                                                                                                                                  | Later (Wave C)                                                       | Invent indicator math                                                                                                                     |

**Internet leverage:** Bazaar _is_ the adopted kit. “Use the internet” ≠ npm a new exchange.

---

## 4 · Look law

| Item                   | Law vs stale vs never decided                                                                                                                                                                                                                                                                                                                 |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Look system**        | **N4 Terminal Zero — LOCKED 2026-08-25 (Nitro, this chat).** Density pole: almost monochrome, chrome-minimal, 1px hairlines, no glass. Draft: `FRONTEND-STYLEBOARD-DRAFT-N1-N4-2026-07-31.md`. Board: `docs/styleboard/SHOW-LAYOUT.html` (`SHOW-NOW.html` is **absent**). N1/N2/N3 are closed unless he overrules.                            |
| **N4 tokens (target)** | bg `#000` · panel near-black · text `#c8c8c8` · 1px borders · control fill `#c8c8c8` on black · **no orange accent** · **no glass**. Market up `#0ecb81` / down `#f6465d` unchanged (trader meaning). Methodology’s “avoid pure `#000`” yields to this pick; Codex keeps **readable** contrast on small type (do not silently restyle to N2). |
| **Paint on tip today** | N4 landed in `#3301` **[RAN-IT 2026-08-25]** — `--ix-bg: #000000`. Do not recolor. Layout is the residual.                                                                                                                                                                                                                                    |
| **P21 teal**           | Dead. Two-day trial, reverted.                                                                                                                                                                                                                                                                                                                |
| **Orange sacred?**     | **No. Unpicked.** Not N4.                                                                                                                                                                                                                                                                                                                     |
| **#3281 (tip)**        | Pair-as-drawer / 390 order stay. Radius/gaps get N4 hairlines, not a redo of that PR.                                                                                                                                                                                                                                                         |

One kit: **iView 3** + CSS tokens. Design Bar still scores polish. Its “P21 teal now” line is **stale** (see §6).

---

## 5 · Honesty law (never on the desk)

From methodology + A1 vocabulary + live kline.js comments **[DOC + RAN-IT]**:

- No fake mids, depth, candles, fills, balances, volume.
- Failed fetch ≠ empty list ≠ `$0.00` ≠ “blank market.”
- Chart: `ok` / `empty` / `failed` are three facts. Gaps in series are real gaps, never a zero print.
- Last/24h are **REST snapshots**. Do not imply they are the live depth stream.
- Green/red = **market direction only.** Accent ≠ PnL.
- Dual-book: venue wallet vs platform ledger must be labeled. Unauth blotter already says sign-in for **ledger** balance.
- Auth fixture never seeds money.
- Oracle index on perps strip is `—` until a real source exists. Leave it.
- Owner blanks (fees, leverage, jurisdictions, settlement) stay refuse-closed.

---

## 6 · Stale docs (named)

| File                                                                      | What is untrue vs live git / live page                                                                                                                                                                                                   | What wins                                                                                        |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `FRONTEND-STATE-OF-TRUTH-2026-07-31.md`                                   | Still “P21 + Wave B desk core”; “next go = GO-READY brief.” Color lock is orange. Desk look home is **this file**.                                                                                                                       | This SoT + COLOR-LOCK current table                                                              |
| `STREAM-A-DESIGN-BAR.md`                                                  | “Provisional lock: P21 teal.” Tip tokens are orange.                                                                                                                                                                                     | COLOR-LOCK current + this SoT                                                                    |
| `FRONTEND-GO-READY-BRIEF-2026-08-02.md`                                   | “Already on main: P21.”                                                                                                                                                                                                                  | COLOR-LOCK                                                                                       |
| `FRONTEND-SCORECARD-LIVE.md`                                              | PROOF-1 (08-02) “P21 teal on login”; chart empty overlay was a residual. Live 08-25: orange chrome; chart **failed** overlay is readable.                                                                                                | Re-score only if Codex claims “better.” Density still not world-class **[RAN-IT shots]**         |
| `INTERNET-LEVERAGE-PHASE-B-FULL-HORIZON-2026-08-05.md` row `web.terminal` | Cell says **wip**. Tracker `features.mjs` says **done** (wired 2026-08-22).                                                                                                                                                              | Tracker for wiring status; this SoT for look residual. Peace audit: done ≠ professional mountain |
| `VENDORED-SHELL-PEACE-OF-MIND-MAP-2026-08-03.md`                          | Path `vendor/exchange-tree`, SHA `d768d7c`. Live path **`vendor/upstream-exchange`**. `apps/web` “retire” already executed.                                                                                                              | Phase A audit + this SoT                                                                         |
| `FRONTEND-MASTER-METHODOLOGY` / plan                                      | Tip SHA `94c0a3f`; “code none until go implement”; P21 color-first. Waves A/B honesty+craft **did** ship; color reverted.                                                                                                                | Still law for _method_ (scorecard, free-hands, gates). Not live git state                        |
| `ORCA-FRONTEND-LEVERAGE-2026-08-16.md`                                    | App **1.4.183**; Design Mode unused; Sovereign as folder. Live Orca **1.4.188** **[RAN-IT]**; a desk tab **is** open this session. Structural “folder vs git repo” may still be true — re-derive before claiming Orca worktree isolation | Live `orca status`                                                                               |

**Not stale (keep):** `INTERNET-LEVERAGE-LAW.md` · Phase A V-SHELL = sole product UI · `FRONTEND-HONESTY-VOCABULARY-A1` · LWC v5 plan (still later) · boom `2026-08-24-PRO-EXCHANGE-LEVERAGE-PEACE-AUDIT.md` (approach: deepen Bazaar, don’t start a new exchange). Styleboard is **picked: N4**.

**Missing (not invented):** `FRONTEND-MASTER-PLAN-WAVE-A-B-2026-08-31.md` — **missing**. 2026-07-31 plan is the one that exists.

---

## 7 · Next craft (not this file)

Paint slice **shipped and failed the glance test.** Next = **layout** L0–L7 in [`FRONTEND-EXCHANGE-DESK-LAYOUT-SOT-2026-08-25.md`](FRONTEND-EXCHANGE-DESK-LAYOUT-SOT-2026-08-25.md).

Paste [`PROMPT-CODEX-EXCHANGE-DESK-LAYOUT-2026-08-25.md`](PROMPT-CODEX-EXCHANGE-DESK-LAYOUT-2026-08-25.md) into a **new** worktree off current `origin/main`. Copy the SoT pack first (untracked on the door).

**Not:** another remap, TradingView, new SPA, inventing candles, restyling login/CMS.

---

## 8 · Out of scope (this pack)

Admin · academy · new SPA · TradingView product · graphify as the work · Denon matching/trade **engines** and open `svc-trade` files · Shehzad chain (`#2473`) · 29-domain pro-exchange paper / PX-S01–16 completeness · wallet RPC mainnet · mobile native · Wave C panes

---

## 9 · Unspoken needs locked (overrule in this file if wrong)

1. Ambition of the spec ships. No silent downgrade to “cleaner vendor skin.”
2. “Use the internet” = adopt Bazaar / named Phase A–B adapter — not a new SPA, not a TV clone, not npm a new exchange.
3. Green/red = market only. No fake prices, books, candles, balances.
4. Product UI = Bazaar on :8090. `apps/web` stays dead.
5. Money book = `ledger-client` + `svc-ledger` only.
6. Chart in-shell = lightweight-charts unless proved unable (then stop).
7. He watches the live desk in Orca. Design Mode = he points; builder paints. This spec chat does not steal that.
8. Codex (not this chat) does frontend craft after the pack is the bar.
9. Denon owns invent-risk trade engines; path-intersect open files. Shehzad = chain. Class X = Nitro human.
10. Files are state. Rulings this session land here.
11. Peace objects: keep / stale / first slice / what Codex must not invent — this file.
12. He ends sessions abruptly. This file is the handover.

---

## 10 · Flip conditions

This pack is wrong if any of these become true:

- Nitro overrules N4 (picks N1/N2/N3 or keep-orange) — look law updates **this file** the same turn.
- LWC 3.8 is proved unable to host the required chart job — stop; do not silently swap.
- Tip replaces `05_Web_Front` as product UI (forbidden unless a new ADR).
- `#3280` or another writer owns `Exchange.vue` chart/ticket in a way that a second writer would dual-edit — wait or take CSS-only in `intafaced.css` `.ix-chart-*`.
- Live desk on a **tip** worktree already has a dense pro chart pane (re-screenshot; this session’s door page is not proof of tip).

---

## 11 · Open writers (re-derived 2026-08-25, public GitHub API)

| PR            | Who        | Note                                                                                                          |
| ------------- | ---------- | ------------------------------------------------------------------------------------------------------------- |
| **#3281**     | ZenYoda3   | **Merged on tip** — responsive desk. Do not redo                                                              |
| **#3280**     | ZenYoda3   | **Open** — Bazaar FOK ticket in `05_Web_Front`. Path-intersect ticket. Stay off TIF/ticket for the look slice |
| #3279         | ZenYoda3   | svc-ws key IP — not the desk look                                                                             |
| #2473         | shehzad002 | protocol card-issuer — out                                                                                    |
| #3195 / #3196 | dependabot | Java deps — out                                                                                               |

`gh` on this door returned **401** this session. Counts above = unauthenticated public API **[RAN-IT]**. Re-`gh pr list` in the Codex worktree.

---

## 12 · Door (operators, not Nitro)

Grok door `/Users/Nitro/projects/Sovereign` **diverged** vs `origin/main` this session (`sync-door-to-tip.sh` → `DIVERGED`). Do not rebase in the dark. Product work stays in `pnpm wt`. Do not commit this pack on `main`.
