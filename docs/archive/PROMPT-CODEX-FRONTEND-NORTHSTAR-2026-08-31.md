# Paste into Codex — north-star desk on Bazaar (do not vibe a second terminal)

You are stronger at craft than the spec chat. **Use that on the NOW rows only.** Do not rewrite PX-S05 or the leverage law. **Do** re-verify a named REFUSE against tip `routes.js` + `svc-trade` / `svc-matching` / `svc-execution` before you omit a control. Do not stop because chrome PRs already merged.

Worktree: **new** `pnpm wt` off current `origin/main`. Never `/Users/Nitro/projects/Sovereign` (Grok door, diverged). Copy this prompt + `docs/FRONTEND-REMAINING-SOT-2026-08-25.md` if missing.

Read, in this order:

1. `docs/FRONTEND-REMAINING-SOT-2026-08-25.md` **§§19–21** (the map) then §§9–18 (safety/proof still open)
2. `PRO_TRADER_EXCHANGE_DEFINITIVE_SCOPE.md` M07 R01–R17 and M25 R01–R12 — **law**, do not rewrite
3. `docs/SPEC-PRO-EXCHANGE-TERMINAL-OMS-AND-TCA-2026-08-24.md` §§6–11, 19–20, 23.1
4. `docs/INTERNET-LEVERAGE-LAW.md` + `docs/LICENCE-POSITION.md` **§1.1a** (chart host) + UI row of `docs/BACKEND-INTERNET-LEVERAGE-PEACE-2026-08-31.md`
5. Tip `vendor/upstream-exchange/05_Web_Front/src/pages/exchange/Exchange.vue` (full type strip + TIF + amend already on tip)

Competitive delta (`SPEC-PRO-EXCHANGE-COMPETITIVE-DELTA-2026-08-31.md`) is **backend only / M07 out**. Do not shop FIX/SBE/QuantLib as frontend packages.

## Already on main — skip unless the crop is actually ugly or the map says NOW

Desk `#3313` · money `#3358` · bank `#3371` · pay `#3375` · p2p `#3379` · OS `#3380/#3385` · public `#3384` · TIF `#3388` · finish `#3406/#3419` · P0s `#3453/#3459/#3460/#3461/#3462/#3463` · route matrix `#3456/#3457`.

Tip already has Spot/Perps/Convert/Copy/Options, Limit/Market/Stop/Stop-limit/Trailing/TP/TWAP/Scale/attached TP-SL, GTC/IOC/FOK, amend + **staged** reprice, cancel-all, RSI/MACD, LWC **5.2.1**. Do not rebuild that chrome.

## Named NOW set (drop none; one family per PR)

### 1 · Session truth (M07-R09, R11, R10) — first

Per-channel status: auth, trading connection, private state, **each** market-data subscription, clock, schema/version, degraded deps. Never one green “connected.”

Recovery-lock: after refresh / sleep / tab-dup / reconnect, **no new submit** until server private+open-orders reconcile. Client retries cannot duplicate orders.

Order-entry lock + live banner. Destructive hotkeys no-op when locked. Default: flatten/reverse/join **off** until the service returns a blast-radius payload (`PX-S05-O04`). **Close** is NOW: `DELETE /api/v1/positions/:id` (`closePosition`) with per-target ACCEPTED/REJECTED/UNKNOWN — not a fill promise. Copy flatten is M26, not this control.

Proof: Orca 1440+390 of locked vs ready; duplicate-tab does not double-fire; reconnect does not replay.

### 2 · Ticket honesty (M07-R04)

Build an executable **capability matrix**: **PX-S03 / matching / trade doors ∪ visible buttons**. Iceberg is a live matching door with no ticket control — mount refuse-or-real. Peg is a typed refuse door — show it closed, do not omit. Unsupported = refuse-closed **on the ticket**, not a pretty 400.

Order preview: buying power / fee / impact from existing APIs; missing = unavailable, never `$0`.

Amend from the **ticket** only until Advanced Charts. Do not add LWC drag-reprice (it would be thrown away). After Advanced Charts access, chart-stage uses the AC API and still confirms through our amend. Keyboard price field remains the accessible path.

### 3 · Blotter + risk strip (M07-R05, R06)

Positions: if perps/isolated risk exists on the wire, show it. If not, keep `spotNoPerps`-class empty **with reason**. Never fake uPnL.

RFQ / funding / borrow / strategy tabs: mount only with a real query; else one unavailable line.

Risk strip: isolated IM/MM/liq if already returned. **Refuse** portfolio-margin / Deribit 2×2 as a UI flag.

### 4 · Layout Reset (M07-R01, R15) + ⌘K orphans

Reset to known-good. Version the prefs schema. Round-trip: save / reload / remount / 390. Corruption → visible fallback.

⌘K must reach `/quant` `/execution` `/ops` `/market` `/support` `/portfolio` (routes exist; catalog omitted them).

No cloud share, no multi-monitor product, no 13-panel widget canvas.

### 5 · Chart freshness (interim LWC; Advanced Charts is the intended host)

Latest-request-wins on pair/interval. Snapshot vs live vs stale vs reconnecting vs as-of. RSI/MACD compute only from accepted candle rows.

**Do not implement TradingView Advanced Charts in this session** — access/approval is still open (`LICENCE-POSITION.md` §1.1a). Do not pirate the repo. Do not commit TV files to this public tree. Do not npm `lightweight-charts-drawing` as a fake. Do not iframe Widgets (that is TradingView’s data).

After access (separate PR): mount official Advanced Charts **inside Bazaar**, our OHLCV/WS datafeed, N4 theme, attribution visible. Then drawings / indicator templates / compare. Still refuse: Alerts, Bar Replay (not in the library). Still not Trading Platform unless Nitro names it (multi-chart layouts + trade-from-chart live there).

### 6 · Admin queues (Layer A)

`apps/admin` users/orders/finance = source-backed table **or** explicit unavailable. Withdrawal approval stays `NOT MOUNTED`. Typed confirm + lock + receipt already started — do not regress `#3460`.

### 7 · Durable proof

`tooling/uiproof` already derives 89 routes / 178 cells. Missing screenshot is a **fail**, not a skip. Commit hashed evidence or immutable PR artifacts. `.artifacts` alone is not cold-start proof. Append a scorecard row only if you claim “better.”

### 8 · Toolchain (Wave 3, own PR)

Member shell must build on **current Node LTS**. Webpack 3 incremental. Do not Vue 3 rewrite. Do not combine with feature PRs.

## Locked (never “finish” by violating)

Bazaar Vue2 `:8090` = member UI. `apps/admin` = ops UI. No second SPA. Ledger-client only. No JS `Number` economics. No fake L3/heatmap/footprint/IV/candles/FX totals. Custody stays `CustodyNotBuilt`. Cards/ramps stay simulated. No Hyperswitch. No Bookmap/OpenDAX/AG Grid. M25 **care** chrome = refuse line. Algo/EMS parent+child = read-only if the wire returns it. TCA = no conclusions. `/predict` `/mining` **already exist** — honesty/empty, do not invent new routes. Convert = quote not a book fill. Copy flatten ≠ desk flatten. Chart **end-state** = Advanced Charts after approval; **now** = LWC interim.

Leverage line in every PR body: `IN vendor shell` or `IN LWC (interim chart)` or `EXT Advanced Charts after access` or `REFUSE <missing API>`. If you almost rebuilt a terminal kit, the session failed.

## Proof or it is not done

Worktree Orca 1440+390 for session-lock, ticket refuse, blotter empty-reason, layout Reset, chart as-of. Fail if any NOW crop still lies, still one global “Live”, or still submits on reconnect.

Go. First visible: session-status + recovery-lock. Session is not finished until NOW rows 1–7 are crop-true or explicitly refuse-closed with the hole named in the PR.
