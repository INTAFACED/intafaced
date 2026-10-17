# Paste into Codex (exchange desk layout)

**[HISTORY 2026-09-01]** Desk `#3313` landed. Do **not** paste this as live law. Living map: [`FRONTEND-REMAINING-SOT-2026-08-25.md`](FRONTEND-REMAINING-SOT-2026-08-25.md). Codex paste now: [`PROMPT-CODEX-FRONTEND-NORTHSTAR-2026-08-31.md`](PROMPT-CODEX-FRONTEND-NORTHSTAR-2026-08-31.md). Chart end-state: Advanced Charts pending (`LICENCE-POSITION.md` §1.1a).

Working directory: a **new** `pnpm wt` off current `origin/main` (at audit: `f7fbf77bb`, includes `#3301` paint + `#3280` FOK merged). Never edit `/Users/Nitro/projects/Sovereign` (the Grok door — diverged, 168 behind). Do **not** reuse `feat-exchange-terminal-zero`.

**Copy first** (these files are untracked on the door, **not** on `origin/main`):

```
docs/FRONTEND-EXCHANGE-DESK-LAYOUT-SOT-2026-08-25.md
docs/styleboard/SHOW-LAYOUT.html
docs/FRONTEND-EXCHANGE-DESK-SOT-2026-08-25.md
docs/PROMPT-CODEX-EXCHANGE-DESK-LAYOUT-2026-08-25.md
```

From `/Users/Nitro/projects/Sovereign/docs/` into the worktree `docs/`. If they are missing, stop — do not craft from memory.

Nitro judges the **page**, not your PR body. He already said `#3301` looks like the old frontend, now buggy. Do not recolor again. Do not re-audit leverage. Do not read the **door’s** `Exchange.vue` as inventory (it is stale). Read **this worktree / tip**.

Read, in order:

1. `docs/FRONTEND-EXCHANGE-DESK-LAYOUT-SOT-2026-08-25.md` — **the bar** (final audit §16)
2. `docs/styleboard/SHOW-LAYOUT.html` — the 1440 picture
3. `docs/FRONTEND-EXCHANGE-DESK-SOT-2026-08-25.md` — kit / honesty facts / N4 paint
4. `docs/INTERNET-LEVERAGE-LAW.md` — Bazaar only; no second SPA

## Locked

- Product UI = Bazaar `vendor/upstream-exchange/05_Web_Front` `:8090` `/exchange`
- Header file = `src/App.vue` (not `pages/App.vue`)
- Chart host = lightweight-charts v3.8 already in-shell
- Money = ledger-client + svc-ledger. No fake candles, books, balances
- Paint = N4 already on tip (`--ix-bg: #000`). Market green/red only
- `#3301` paint stays. **Layout is the job now**
- **Vibe already set** (do not re-pick N1–N3): pro workbench, density pole, ownable (crop must not name HL/OKX/Binance)
- **Best-of jobs, one desk** (layout SoT §2.2): HL = no mall chrome (not fewer tools). OKX/Binance = chart-left grid + **full pro toolset on screen**. Coinbase Advanced = calm empty/error **copy**, not a simple-app. dYdX = chart is the object. Bybit = 390 still a desk.
- **Dense and complete:** hierarchy is size/order, not hiding. Pack **existing** tip types (Limit/Market/Stop/Stop-limit/Trailing/TP/TWAP/Scale/attached TPSL) and modes (Spot/Perps/Convert/Copy/Options-paper). Do not invent matching. Do not hide TWAP/stop/positions. Do not add a Simple/Advanced product (`advancedPlanLocked` is batch/bracket only).
- `#3280` FOK is **merged** — restyle TIF, do not rewrite the place engine.

## What “done” looks like

Open `SHOW-LAYOUT.html` then **this worktree’s** `/exchange` at 1440. Thin header, chart owns the canvas, book+tape+**packed ticket** on the right, blotter under the chart. Lab/Announce/Language/Platform mega **gone on this route** (still on OS routes). Ticket shows the **full type strip and mode strip** (packed, 11px). Honesty = one line, not a blog.

390: pair, chart, book, ticket — no white chips, no sideways scroll, no six fat mode tiles before Buy.

## Boot (do this, not a homemade server)

From the worktree:

```
pnpm ui:boot
```

If something already answers on 8090 (the door), use `PORT=8091 pnpm ui:boot`. Proof is that URL. No Node download. Use existing `STREAM_A_NODE` / `.tools/node18`. Graphify does not map vendor Vue — open `Exchange.vue` / `src/App.vue` directly. After edits: `GRAPHIFY_MAX_WORKERS=1 graphify update .`

## Do in order (do not skip)

L0 kill `#3301` defects (white chips, overlapping menus)  
L1 desk-mode chrome on `/exchange` (`src/App.vue`)  
L2 1440 grid (`Exchange.vue` + desk CSS) — keep B5 pair/TF prefs  
L3 packed ticket (existing types on a strip — not a 4-control toy, not new engines)  
L4 chart as tool (intervals in pane; empty/failed fills the pane)  
Then L5–L7 as in the layout SoT.

Proof each slice: Orca 1440 + 390 of `/exchange/btc_usdt` from **this worktree’s** `pnpm ui:boot`. Auth fixture never seeds money.

## Do not

New SPA, TradingView product, Tailwind/shadcn, rewriting TIF/FOK/TWAP/scale engines, admin/academy/CMS/login as the work, inventing feed data, graphify as the deliverable, shrinking L2 to “a bit less padding,” touching `#2473` protocol paths, claiming scorecard “improved” without a new LIVE row.

If Vue2/iView cannot do the 1440 grid, **stop and name the hole**. Do not silently ship a smaller desk. Do not start a new website.

Go. First visible change: `/exchange` header no longer covers the chart, and the crop matches `SHOW-LAYOUT.html`.
