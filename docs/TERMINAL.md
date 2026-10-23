# THE INTAFACED TERMINAL

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**[STALE-as-architecture 2026-08-31]** Product UI is Bazaar `vendor/upstream-exchange/05_Web_Front` `:8090`, not `apps/web`. Chart **end-state** is TradingView **Advanced Charts** pending approval (`docs/LICENCE-POSITION.md` §1.1a). Lightweight Charts on this page is the **interim** host. Living execution map: `docs/FRONTEND-REMAINING-SOT-2026-08-25.md`. Keep this file as product-ambition history; do not code from the `apps/web` diagram.

**Our terminal. Our book. Every other venue too.**

---

## 1 · The claim

A pro terminal that is _also_ the broker is a different machine from a terminal that merely watches brokers.

|                      | Research terminals | Broker apps   | **INTAFACED Terminal**           |
| -------------------- | ------------------ | ------------- | -------------------------------- |
| Market data          | many venues        | one venue     | **many venues**                  |
| Executable liquidity | none — read-only   | one venue     | **many venues + our own book**   |
| Settlement           | n/a                | that broker   | **our ledger, instantly**        |
| Fee capture          | none               | that broker's | **ours on internal fills**       |
| Identity / rank      | none               | that broker's | **one rank across every module** |

We are our own broker (Doctrine §0.6 — the ledger is the balance graph; §5 — svc-matching is our engine). Cross-venue does not dilute that. It means **the internal book competes for every order and usually wins**, because winning is cheap for us and we can price it that way.

---

## 2 · Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  apps/web — Next.js 15 · @intafaced/ui · lightweight-charts  │
│  Pro terminal · Convert · Copy · Portfolio                   │
└───────────────────────────┬──────────────────────────────────┘
                            │ tRPC + ws-gateway
┌───────────────────────────▼──────────────────────────────────┐
│  svc-trade — orders, fees, positions, copy, OTC              │
└─────────┬────────────────────────────────┬───────────────────┘
          │                                │
┌─────────▼──────────┐         ┌───────────▼──────────────────┐
│  svc-matching      │         │  packages/venue-adapter      │
│  OUR order book    │◄────────┤  SmartOrderRouter            │
│  price-time, gRPC  │  always │  ConsolidatedBook            │
└─────────┬──────────┘  a bid  └───────────┬──────────────────┘
          │                                │ LiquiditySource
┌─────────▼──────────┐         ┌───────────▼──────────────────┐
│  svc-ledger        │         │  external venues via CCXT    │
│  every fill posts  │         │  (MIT) · AMM pools · OTC     │
└────────────────────┘         └──────────────────────────────┘
```

**`LiquiditySource` is the §5.2 adapter interface.** The internal book is _itself_ a `LiquiditySource` — it is not a special case in the router, it is the source that happens to be ours. That is what keeps the routing logic honest: it cannot cheat in our favour, it can only be given better prices to work with.

Doctrine §0.4 holds exactly: _"All external rails sit behind internal interfaces… the platform never depends on them to function."_ Cut every external venue and the terminal still trades — on our book, which is the point.

---

## 3 · Scope

Ships incrementally with the phases. The reference audit put a serious terminal at ~57 screens; ours are grouped by the module that owns them, so nothing is built twice.

**Phase 2 — Trade**
`Pro terminal` (multi-book, depth, hotkeys, TradingView-style charting via **lightweight-charts**, Apache-2.0, already named in §1) · `Convert` one-tap · `Copy` leaderboards · `Sub-account switcher` · `Consolidated depth` with venue attribution · `Smart routing` preview showing exactly where an order will fill and why · `Positions` · `Order history` · `Algo execution` TWAP/VWAP/POV

**Phase 3 — Pay + P2P**
`Merchant dashboard` · `Checkout builder` · `P2P offers` · `Escrow` · `Disputes`

**Phase 5 — the research surface**
`Screener` · `Backtesting` · `Portfolio analytics` · `Watchlists` · `News` · `Economics` · `Derivatives analytics` · `Node editor` for automation · `Report builder` · `Market Scanner` and `Coach` agents (§8.2) · `Academy lobbies` (§8.3)

Every one of these is Next.js on `@intafaced/ui`. One design system, one language, one release.

---

## 4 · Cross-venue mechanics

### Consolidated book

Depth from every healthy source, merged and price-sorted, each level carrying its venue. The user sees one book; the router sees where each slice actually lives.

### Effective pricing

A venue's quoted price is not its real price. The router ranks on **effective price** — quote adjusted for that venue's taker fee, then for our own rank/IFC fee discount on internal fills (§4.1, §4.3). A venue quoting 0.1% better on paper but charging 0.2% more in fees loses, correctly.

### Internal-first tiebreak

At equal effective price, the internal book wins. Deliberate and defensible:

- The fee is ours (§4.3 buyback flywheel)
- Settlement is a ledger post — atomic, instant, no external counterparty
- No custody exposure at a third party
- No withdrawal latency

### External settlement boundary

An external fill means assets sitting at a third-party venue. That is custodial exposure and it is accounted as such: external legs post through a `venueBoundary` treasury account (§4.2), so `-balance` at that boundary is exactly our exposure per venue — a number the reconciliation job and the operator console both read.

### Health and circuit-breaking

Every source reports health. A degraded or stale venue is excluded from routing before it can fill an order at a price it no longer honours. Staleness is measured, not assumed.

---

## 5 · What is built

| Piece                                                                         | State                                     |
| ----------------------------------------------------------------------------- | ----------------------------------------- |
| `packages/exchange-contract` — CCXT-shaped API we **serve**                   | ✅ 26 tests                               |
| `packages/venue-adapter` — `LiquiditySource`, consolidated book, smart router | ✅ this document's subject                |
| `svc-matching` — our engine                                                   | Phase 2                                   |
| `svc-trade` — orders, fees, positions                                         | Phase 2                                   |
| `apps/web` — the terminal itself                                              | Phase 2                                   |
| External CCXT adapters (Binance, Kraken, …)                                   | Phase 2, §13 socket — interface ready now |

Doctrine §0.2 governs the order: **the Core comes first.** The router is contract and pure logic — no service, no surface, no dependency on an unfinished ledger — so it lands now. The screens land when there is a book to render.
