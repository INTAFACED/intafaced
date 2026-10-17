# A6 — Lightweight Charts v5 plan (non-blocking Wave A)

**Status:** **INTERIM.** Tip already has LWC **5.2.1**. Owner 2026-08-31: intended chart is **TradingView Advanced Charts** pending approval (`docs/LICENCE-POSITION.md` §1.1a). Do not treat this file as the final chart host. Do not npm a drawing suite to fake Advanced Charts.  
**Today:** LWC **5.2.1** vendored standalone under `assets/js/market-chart/` (this file’s “v3.8” line is historical).  
**Attribution:** tradingview.com link on desk (A0.5)

## Goal

RSI / MACD panes and multi-pane layout without inventing indicators.

## Decision gates before upgrade

1. Golden tests for any indicator math (input candles → values) before UI.
2. NOTICE / Apache-2.0 vendored build (same pattern as v3.8) — **not** package.json without Denon.
3. Attribution remains on chart surface.
4. Wave C timing: after Wave A honesty DoD + style pick or waiver.

## Steps (when scheduled)

1. Diff v3.8 → v5 breaking API (createChart options, series API).
2. Spike branch: mount only; no indicators.
3. Port kline.js wrapper; keep resolution map.
4. Pane API for RSI/MACD after goldens.
5. Measure interaction latency (scorecard dim 16).

## Out of scope

AI trades, social, confetti, fake candles.
