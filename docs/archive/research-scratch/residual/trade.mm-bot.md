# trade.mm-bot residual — research brief (2026-07-31)

## Law

§5.1 matching owns the book · §5.2 trade owns product · no invent balances · seed depth must use real orders/holds or documented house path.

## Why this mountain matters now

Futures mark-from-depth + liq ticks need a two-sided book. Journals only seed markets after real orders. Empty books → mid null → liquidation skip (correct) but product looks dead.

## On main now

- `matching.engine` **done** — book, depth, submit, journal/replay
- `trade.spot` money path places real orders that journal markets
- `planSeedQuotes` pure planner (external mid only)
- Ledger: `marketMakerSeedFund` + `marketMakerOrderHold` / release
- `seedMarket` orchestrator: hold → matching PO submit as `house:market-maker`
- Still no wall-clock job / env market list / house tradeFill

## Gaps

1. ~~Seed process that posts two-sided quotes without lying about money~~ — **seedMarket** (partial)
2. ~~Who holds inventory~~ — `house/market-maker` pot + per-order holds
3. Which markets get seeds (explicit list — never invent all)
4. Restart: reseed vs journal replay ownership
5. House fill settlement when a user hits a seed order (`tradeFill` still user-shaped)
6. Ops job host default OFF

## DoD candidates (smallest ships)

| #   | Ship                                       | Proof                  |
| --- | ------------------------------------------ | ---------------------- |
| 1   | Research pack (this file)                  | Named residual set     |
| 2   | Design: house seeder account + recipe path | Recipes + tests        |
| 3   | `seedMarket` hold + matching PO submit     | Unit tests (no invent) |
| 4   | Ops job + market list env (default OFF)    | residual               |
| 5   | House tradeFill / cancel lifecycle         | residual               |

## Collision

Order-route #289 · futures jobs (consume depth, do not seed) · Denon multi-asset.
