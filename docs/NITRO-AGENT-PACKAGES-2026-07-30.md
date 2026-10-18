# Agent-ready packages for Stream A — 30 July 2026

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Author:** Denon (Stream B / spine). **Audience:** Nitro's agents, cold-start safe.
**Board SoT:** `docs/DENON-NITRO-PARALLEL-BOARD-2026-07-30.md`. **If this file
disagrees with live git, the tracker or a live endpoint: live wins.**

Every endpoint fact below was **probed against the running stack today**, not
recalled. Where something is broken I say so and say who fixes it.

**Never invent:** a money model, a licence answer, a rails or chain decision, the
multi-asset merge, or a kill-drill result. If a package seems to need one of
those, stop and say so — it is Denon's.

---

## Ground truth: what the shell can actually call today

| endpoint                                                                       | via                      | status                | notes                                                                                                                    |
| ------------------------------------------------------------------------------ | ------------------------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `POST /market/symbol-thumb`                                                    | :8090 proxy              | **200, real data**    | BTC/USDT ~118,450 with volume and turnover. Safe to build on.                                                            |
| `GET /market/history`                                                          | :8090 proxy              | **200, real candles** | **Works.** Takes `from`/`to` in **milliseconds**, not seconds. See Package C.                                            |
| `GET /api/v1/markets`                                                          | edge :4000               | **200**               | CCXT shape. 16 markets: crypto, commodity, forex.                                                                        |
| `GET /api/v1/{ticker,ohlcv,trades,orderbook,tickers,orders,positions,account}` | edge :4000               | **404**               | Mounted in `svc-trade` source but not answering. **Denon investigating — do not build against these yet.**               |
| `svc-ws` trades channel                                                        | **direct, not the edge** | wired (#162)          | The edge buffers and cannot proxy a socket, so the browser reaches svc-ws directly. That is by design, not a bug to fix. |

**Two infrastructure facts that will waste your day if you do not know them:**

1. **MongoDB dies.** `intafaced-coinex-mongo` had been `Exited (14)` for three
   hours today, which made every candle query return empty. If the chart or
   market data goes blank, check `docker ps -a | grep mongo` **before** debugging
   your own code.
2. **CI is dead** — 100 consecutive runs, zero successes, every job failing with
   **zero steps executed**. It is a quota/runner problem, not code. `main` is
   healthy: local `pnpm verify` is **86/86 with the DoD gate passing**. So verify
   locally and say so on the PR. Never claim CI green.

---

# Package A — Shell polish against live endpoints

**Goal.** Make every screen in the vendored shell honest and usable against the
endpoints that actually answer, so nothing displays a number it did not receive.

**In scope**

- Order entry: validation, precision from the market's real tick/lot, fee
  preview, confirmation and error states.
- Account panes (Balances, Positions, Open Orders, Trade History, Order
  History): wire to what answers; where a call 403s or 404s, show **which**
  refusal it was.
- Mobile: the shell has a drawer and nobody has checked it since the retheme.
- Empty and error states everywhere. The backend goes down — see the Mongo note.

**Out of scope**

- Anything that needs a new proxy prefix or edge route → **Package B**.
- The candle path → **Package C**.
- Money models, licences, rails.

**Paths you may touch**

```
vendor/upstream-exchange/05_Web_Front/src/pages/**
vendor/upstream-exchange/05_Web_Front/src/components/**
vendor/upstream-exchange/05_Web_Front/src/assets/images/**
vendor/upstream-exchange/05_Web_Front/src/App.vue
vendor/upstream-exchange/05_Web_Front/src/config/routes.js
vendor/upstream-exchange/05_Web_Front/src/assets/lang/en.js   (append-only region)
```

Branch prefix `feat/app-*`.

**Contracts that already exist**

- `POST /market/symbol-thumb` — the market list and 24h stats. Real.
- `GET /api/v1/markets` — tick size, lot size, min notional, maker/taker, per
  market. **Use this for order-entry precision instead of hardcoding decimals.**
- The three refusal codes are now distinguishable: missing scope, insufficient
  verification tier, and blocked region are separate. **Render which one.** "Verify
  to tier basic" is actionable; "forbidden" is not.

**Done when**

- Browser proof (screenshot or recording) of each screen with data, and each
  screen with the backend stopped.
- Shell compiles: `docker logs intafaced-shell-web --since 3m | grep -E "Compiled|error  in"` → the only warning is the pre-existing `InnovationMinings.vue` v-for key.
- `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8090/app.js` → 200.
- `node vendor/upstream-exchange/scan-cjk.mjs` → **zero CJK**. That property was hard-won.

**Blocked on Denon?** **No.** Start now.

---

# Package B — The cross-stream door, pre-opened

**Goal.** Let you add screens that need a new backend prefix without waiting on me.

I own `config/index.js` (dev proxy), `src/main.js`, `services/svc-edge/src/routes.ts`
and `docker-compose.apps.yml`. Rather than have you file an issue per prefix,
here is the **exact change** and the door is open for these specific cases.

**Already open — no request needed.** `/api/*` is proxied to `svc-edge` and the
edge routes 13 prefixes: `identity trade token agents bank p2p pay blueprint
protocol dex indexer notify` plus `/api/v1`. **Anything under those, just call it.**

**If you need a NEW prefix**, open a `[cross-stream]` issue containing exactly this,
filled in — it is a two-minute change on my side and I will not ask questions:

```
[cross-stream] proxy+edge route for <name>

Prefix wanted:      /api/<name>
Upstream service:   svc-<name>
Container port:     <port>          # must match the service's own HTTP_PORT
Preserve full path? yes|no          # yes only for absolute-path contracts like /api/v1
Why the shell needs it: <one line>
```

**Why I do not just hand you the files:** a wrong upstream port does not fail
cleanly — it reaches a _live service that answers a different API_. `svc-dex` once
called `svc-matching` on `svc-trade`'s port and the gate stayed green. There is now
a `workspace-sync` check for it, and it belongs on my side of the line.

**Done when** the prefix answers 200 through :8090 and your screen renders.

**Blocked on Denon?** **Only for a new prefix**, and then by minutes.

---

# Package C — Demo quality: the candle path. **DECIDED: seed, not external.**

**The decision is mine and it is made: seeded candles, no external feed.** An
external market-data feed is a licence and vendor choice, it is a live dependency
in a demo, and we already have 100 kline collections on disk. **Do not shop for a
data provider.**

**Goal.** The chart shows a real market on every timeframe.

### CORRECTION — the candle path is NOT broken. I was wrong.

An earlier version of this package said `GET /market/history` returns `[]` and
called it a spine bug I would fix. **That was my error, not the code's.** I probed
it with `from`/`to` in **seconds**, which is the TradingView UDF convention. This
endpoint takes **milliseconds**.

With the right units it returns real candles:

```
GET /market/history?symbol=BTC/USDT&from=1785000000000&to=1785400000000&resolution=1H
→ [[1785002400000,111552.84,111637.73,111048.62,111093.02,575.316536],
   [1785006000000,111093.02,111903.01,110900.99,111847.90,510.830298], …]
```

**Milliseconds is correct and consistent all the way through**, which is why there
is nothing to fix:

- the production writer uses `setTime(calendar.getTimeInMillis())`
  (`DefaultCoinProcessor.java`) — live klines are ms
- the seeder wrote ms, matching it
- `kline.js` sends `Date.now()` and `to - spanSec * 1000` — the datafeed already
  sends ms
- `kline.js` then normalises on the way back: `if (t > 1e12) t = Math.floor(t / 1000)`,
  because lightweight-charts wants seconds

**How I got it wrong, since it is worth not repeating:** I inferred the contract
from the stored data and the TradingView convention instead of reading the client
that actually calls it. Six lines of `kline.js` would have answered it. The
`[]` I saw was real, but its cause was **MongoDB being down for three hours** — and
once it was back I re-probed with the same wrong units and blamed the units.

**So Package C is NOT blocked on me at all.** Everything below is available now.

**Your half:**

**In scope**

- Interval switching in the terminal UI, driving the `resolution` parameter the
  endpoint expects. Note the mapping the Java side performs: `1H → 1hour`,
  `1D → 1day`, `1W → 1week`; bare numbers are minutes.
- An honest empty state: when history returns no bars, the chart says "no data
  for this range", **never a flat line at the last price**. A flat line reads as
  a real market that did not move, which is a lie.
- **Indicator overlays computed client-side from the candles you already have** —
  SMA, EMA, MACD, RSI, Bollinger. This is the single highest-value visual win
  available and it needs **no chart licence**: it is arithmetic over an array
  rendered as extra series on lightweight-charts. Volume already works.
- Loading and reconnect states.

**Out of scope**

- Choosing or integrating a market-data provider. **Mine.**
- The seconds/milliseconds fix. **Mine, shipping first.**
- Restoring the proprietary charting library — purged in #106 and blocked in
  `.gitignore`. There is no grant on file. **Do not re-add it under any
  circumstances**, and do not add a licensed chart dependency.

**Paths:** `vendor/upstream-exchange/05_Web_Front/src/assets/js/market-chart/**` plus
the terminal page and components.

**Done when** the chart renders bars on 1m/5m/15m/1h/4h/1d, indicators toggle,
and an empty range shows the empty state rather than a fabricated line. Browser
proof.

**Blocked on Denon?** **No — corrected. Nothing here waits on me.** An earlier
version said bars waited on a unit fix from me; there is no unit fix, the endpoint
works, and the whole package is available now.

**One thing to check first when the chart looks empty:** `docker ps -a | grep mongo`.
`intafaced-coinex-mongo` had been `Exited (14)` for three hours today, which makes
every candle query return `[]` with a 200. That is the failure that fooled me.

---

# Package D — WAVE-AUDIT after each spine merge

**Goal.** After each of my waves, refresh only what my wave could have changed —
not a re-archaeology of the repo.

**Trigger.** A PR of mine merges with `spine` in the branch name.

**What to refresh, and nothing else**

1. **Tracker honesty for the touched features only.** Re-probe the endpoints that
   PR claims, with a real token, and correct `docs/TRACKER.md` where the claim and
   the response disagree. **A tracker that says "shipped" for a 404 is the single
   most expensive lie in this repo** — it has already cost a full session.
2. **The shell against the new surface.** If I landed a procedure your screens
   call, confirm the screen still renders and its refusal states still read true.
3. **Residual.** Append what my wave did _not_ finish. Do not re-litigate what it
   deliberately left — read the PR body, which states scope and omissions.

**Explicitly NOT in a wave audit**

- Re-auditing the agent wave ~#110–#168. **Do not rebuild it.**
- Money-path correctness. That is my self-audit; if you think a money path is
  wrong, **say so in an issue** rather than changing it.
- Re-deciding anything in `docs/DECISIONS-2026-07-30.md`.

**Done when** the tracker rows for the touched features match live responses, and
the residual note names what is left with evidence.

**Blocked on Denon?** **No** — it is triggered by my merges.

---

## Currently in flight on my side, so you can see what is coming

Seven spine agents: `protocol.smart-accounts` (the primary mountain), venue-hours
enforcement, wallet secrets and host perimeter, S2S body binding, ops kill-switches
and treasury, pay rails and gateway, bank loans.

**Two of those will change what your screens can show:** kill-switches (an
operator can halt spot trading, so order entry needs to render that refusal) and
venue hours (a closed forex market must refuse, and the UI should say when it
reopens — `nextScheduleTransition` gives you the timestamp).

## Two things only the owner can unblock

- **GitHub billing / spending limit** — until then CI cannot go green for anyone.
- **The TradingView Advanced Charts application** — free, but days of lead time.
  Until a grant is on file, lightweight-charts plus Package C indicators is the
  terminal.
