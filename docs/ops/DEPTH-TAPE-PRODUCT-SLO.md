# Depth / tape product SLO — honest empty book

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Tracker:** D26-P4-06 · board [`DENON-HARD-PARALLEL-BOARD-2026-08-09.md`](../DENON-HARD-PARALLEL-BOARD-2026-08-09.md) §8  
**Status:** **Accepted — 2026-08-15.** Spec for the shell client. Class **N**.  
**Decision owner:** Denon. **Written by:** Denon agent.  
**Lane:** LIVE-LANES `denon-d26-p4-06-depth-slo`  
**This PR does not edit** `services/svc-trade` (open futures listing PRs) · no Vue craft · no Shehzad chain · no mm-bot seed as live.

---

## The decision

> **An empty book stays empty.** The product surface may show listed-and-quiet, listed-and-dark, or kill-switched. It may not invent depth, invent a mid, manufacture a cross, or replay seed fills as live tape.

This is a **honesty SLO**, not a latency SLO. No measured depth/tape p50/p99 exists in this repo. **No number is published here.** An unscored feed must not receive a fake grade (same rule as D-S-18 latency grading: a measurement that has not run is **no score**, not a low score).

---

## What this file is for

The vendored shell (`:8090`, Phase A **V-SHELL**) is the sole product UI. Agents must not rebuild it. This spec tells that client — and any later wire — what the existing **public doors already answer**, so the desk cannot “look live” by filling a hole.

**Leverage (Phase A IN):** V-SHELL + `svc-matching` + `svc-ws` + `svc-trade` public REST already on tip. Horizon row `web.terminal` is **IN / NOW / N**. Path is wire-to-existing-doors, not a second book.

---

## 1 · Public doors (read-only — named by file)

These are the doors the shell may read. This spec does **not** change them.

### Matching — engine book (not the listing)

| Door                                  | File                                                                                             | Honest empty / dark                                                                                                                                                               |
| ------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /markets/:marketId/depth?limit=` | [`services/svc-matching/src/router.ts`](../../services/svc-matching/src/router.ts)               | **404** `MarketNotFound` when the engine holds no book. Reading must not allocate. A 200 with `bids: []` / `asks: []` is only for a book that **exists** and is empty.            |
| `GET /markets`                        | same                                                                                             | Journal markets only — not `trade.markets` listing authority.                                                                                                                     |
| `GET /ready`                          | [`services/svc-matching/src/index.ts`](../../services/svc-matching/src/index.ts)                 | **503** when `MATCHING_ENGINE_ENABLED` is off (`matching.engine flag is off`).                                                                                                    |
| Writes when disabled                  | [`services/svc-matching/src/engine/engine.ts`](../../services/svc-matching/src/engine/engine.ts) | Submit refuses when the engine flag is off. Depth **reads** still go through `existingBook` — do not treat a still-served empty ladder as “the venue is live” if `/ready` is 503. |

Contract text: [`services/svc-matching/README.md`](../../services/svc-matching/README.md) (depth is public because a price is not a secret).

Edge does **not** proxy matching. Halt new risk via the **trade** module, not a fake `/api/matching` path — [`services/svc-edge/src/routes.ts`](../../services/svc-edge/src/routes.ts).

### Trade — CCXT public REST (listing + tape)

Do **not** edit this service in the D26-P4-06 ship. Named so the shell knows which contract it is already on:

| Door                               | File                                                                                   | Honest empty / dark                                                                                                                                                                                                                                                                              |
| ---------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/v1/markets`              | [`services/svc-trade/src/public-rest.ts`](../../services/svc-trade/src/public-rest.ts) | Listing authority. A listed market that has never traded is still listed. `orderable` is the kill-switch the place path already enforces — listed ≠ orderable.                                                                                                                                   |
| `GET /api/v1/orderbook/:symbol`    | same                                                                                   | Matching **404** (no book) is mapped to `{ bids: [], asks: [], sequence: 0 }` in [`services/svc-trade/src/spot/matching-client.ts`](../../services/svc-trade/src/spot/matching-client.ts) — **200 empty**, not 502. Engine **down / 5xx** is `MatchingUnavailableError` → **502**. Empty ≠ down. |
| `GET /api/v1/ticker/:symbol`       | same                                                                                   | BBO from depth; `bid`/`ask` **null** when both sides empty. Last from public tape or **null**. 24h high/low/vwap/volume stay **null** until a real windowed job exists — `presentTicker` must not invent stats.                                                                                  |
| `GET /api/v1/tickers`              | same                                                                                   | Bulk path: a missing book must not 502 the whole map; that market still appears with empty BBO.                                                                                                                                                                                                  |
| `GET /api/v1/trades/:symbol`       | same                                                                                   | **200 + `[]`** when nothing has printed. Seed volume is excluded from this tape (SD-3).                                                                                                                                                                                                          |
| `GET /api/v1/ohlcv/:symbol`        | same                                                                                   | Candles from the **real taker fill tape** only. Empty chart when never traded — not a fabricated candle.                                                                                                                                                                                         |
| `GET /api/v1/funding-rate/:symbol` | same                                                                                   | Published rate or refuse. Never invent zero.                                                                                                                                                                                                                                                     |

Proofs (do not dual-edit): `public-rest.test.ts`, `promise-falsify-public-doors.test.ts`.

### WS — shell live feed (empty ≠ zero)

| Door                            | File                                                                                                                           | Honest empty / dark                                                                                                                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /markets/:marketId/depth`  | [`services/svc-ws/src/routes.ts`](../../services/svc-ws/src/routes.ts)                                                         | Unlisted → **404** `MarketNotFound`. Listed with no resting depth → **404** `NoBook` — **never** `200` with `bids/asks []`. Kill-switch → **503**. Matching 5xx → **502** `UpstreamUnavailable`. |
| `GET /markets/:marketId/trades` | same                                                                                                                           | Listed with no prints → **404** `NoTape` — never `200 { trades: [] }`.                                                                                                                           |
| Depth poll                      | [`services/svc-ws/src/depth/source.ts`](../../services/svc-ws/src/depth/source.ts)                                             | Matching 404 → `DepthNoBookError`. Callers must not coerce that into `{ sequence: 0, bids: [], asks: [] }`.                                                                                      |
| Socket                          | [`services/svc-ws/README.md`](../../services/svc-ws/README.md) · `empty-book-honesty.test.ts` · `empty-trades-honesty.test.ts` | Socket stays **open with no snapshot** until matching has resting depth. First real quote is a **snapshot**, not a delta off a fake sequence 0. No invented prints or mids.                      |
| `GET /ready`                    | `routes.ts`                                                                                                                    | **503** when `WS_GATEWAY_ENABLED` is off. Bus down ≠ not ready (depth still works).                                                                                                              |
| Kill-switch                     | [`services/svc-ws/src/ws/gateway.ts`](../../services/svc-ws/src/ws/gateway.ts)                                                 | Upgrade **503**; hub closes sockets with a reason. svc-ws is **not** behind svc-edge (`socket.ws-behind-the-edge`) — flipping edge `ws` does not stop the browser socket.                        |

Listing union: `TRADE_URL` `GET /api/v1/markets` is authority; matching `GET /markets` is unioned. Engine unreachable → listed markets stay subscribable **without a fabricated book**. Both unreachable → keep last known list; never report zero markets. Law: [`docs/adr/2026-08-04-market-id-authority.md`](../adr/2026-08-04-market-id-authority.md). WS later tightened “empty ≠ zero” on the **socket** (404 / no snapshot) so a client cannot treat absence as a priced empty ladder.

---

## 2 · What the shell MAY show

| Condition                                         | May show                                                                                                                               | Must not show                                                                                   |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Listed, never traded (matching 404 / WS `NoBook`) | Market row from listing. Copy equivalent to **No bids / No asks** or **no book yet**. REST orderbook may be a 200 empty ladder (CCXT). | Spinner-as-error, fabricated rungs, invented last/mid, “market closed” unless schedule says so. |
| Engine has a book and both sides empty            | Same as empty book.                                                                                                                    | A mid.                                                                                          |
| Matching / trade hop **5xx or unreachable**       | Outage / retry / last **labelled stale** if the client already held a snapshot.                                                        | Coerce to empty book. That lie is exactly the 404-vs-5xx rule.                                  |
| Unknown id                                        | Refuse by name (`unknown market` / CCXT bad symbol).                                                                                   | Widen id pattern to accept `BTC/USDT` as a market id.                                           |
| Matching kill-switch (`/ready` 503)               | Dark / unavailable.                                                                                                                    | Quiet market with a live-looking empty ladder.                                                  |
| Trade spot/seed/algo kill-switch                  | Listed, **not orderable**. Depth/tape still only what matching actually holds.                                                         | Seed the book to look open.                                                                     |
| WS gateway kill-switch                            | No live stream (503). REST may still answer.                                                                                           | Invent a last snapshot.                                                                         |
| Dark venue / desynced mark feed                   | **null** mark (existing venue/OTC/futures ports).                                                                                      | Invented mid from last print, dust, or house quotes.                                            |
| Seed / mm resting (ops ON, flagged `seeded`)      | Resting size that is **actually in the engine**, if the operator has armed seed.                                                       | Seed **fills** on the public tape; manufactured crosses; unflagged seed as organic volume.      |

Marks that move money stay refuse-closed on dust / one-sided / internal quotes ([`docs/adr/2026-08-13-mark-dust-floor.md`](../adr/2026-08-13-mark-dust-floor.md), P0-01 Q3). The desk must not display a payout-grade mid the engine itself refused.

---

## 3 · Forbidden (product)

1. **Manufactured crosses** — house/seed must not take its own other side to print a last. D26-P1-T10: [`services/svc-trade/src/mm/seed-honesty.ts`](../../services/svc-trade/src/mm/seed-honesty.ts) (read-only here).
2. **Seed fills as live** — public tape / OHLCV / “last” / volume windows exclude seeded prints (SD-3). A seed job is ops liquidity, not organic flow.
3. **Invent mid** — empty book, empty venue, unmapped id, desynced stream, dark OTC feed → **null**. Never last-print-as-mid, never `(bid+ask)/2` on missing sides, never env map after the live source said no.
4. **Empty-as-healthy when the hop is down** — 502/503/throw stay 502/503/throw.
5. **Latency theater** — no invented p99, “sub-100ms desk”, or Connect-style letter grade for a feed that has not been measured.

Internal market-making on **our** book stays blocked (D26-P0-01 Q1). `trade.mm-bot` may seed when ops enable it; that seed is still not live tape and is not a mark input.

---

## 4 · SLO statement (honesty)

| Claim                                                    | Status                                                                                                                                 |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Empty book / no tape is distinguishable from engine-down | **In force** on the doors in §1.                                                                                                       |
| Seed volume is not user volume                           | **In force** (T10 / SD-3).                                                                                                             |
| Mid never invented                                       | **In force** (venue mark, OTC, MM seed mid, D-S-18 capture hole ≠ quiet market).                                                       |
| Depth/tape **latency** SLO (p50/p99, staleness budget)   | **Does not exist.** No dashboard, no probe, no published number. Refuse to invent one. Residual: measure later, then write the number. |

D-S-18 ([`docs/adr/2026-08-04-predict-quant-connect-law.md`](../adr/2026-08-04-predict-quant-connect-law.md)): a venue that is not connected is **absent in the record, never an empty book**. Same shape: a hole in capture or a dark socket is a hole, not a quiet market.

---

## 5 · Leftover (not this spec)

- Vue / shell **craft** — HUMAN lane `nitro-frontend-all`. This file is the contract; it is not a UI PR.
- `services/svc-trade` code — open futures listing PRs; do not dual-edit.
- Measured latency SLO — none; do not fake it.
- Internal house MM on our venue — blocked until a later owner ruling.
- D26-P4-05 private positions payload freeze — sibling, not this mountain.
- Edge kill-switch does not halt the browser’s direct `svc-ws` socket — named SOCKET, not closed here.

---

## Done bar

1. Named the existing trade/matching/ws public doors by file (read-only).
2. Named what the platform may show when empty / dark / kill-switched.
3. Named the three forbids: manufactured crosses, seed fills as live, invent mid.
4. Stated that the SLO is honesty, and that **no measured latency SLO exists**.
