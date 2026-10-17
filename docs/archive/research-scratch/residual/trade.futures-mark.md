# trade.futures mark feed — research brief

## Law

Doctrine: no invent prices. Liquidation on a printed last is an attack vector (see svc-bank loans/prices.ts §header).

## On main now

- planLiquidation + runLiquidationTick take external MarkSource
- Bank loans: MarkQuality mid|last|index + refuse stale/weak for liquidation
- Trade public ticker: last/bid/ask from matching — no TWAP/index

## Gaps

1. Real index oracle product (multi-venue / TWAP)
2. Wire mark-source into production job host
3. Depth-aware mid at size band

## DoD (this slice)

- [x] MarkSource adapters: memory book + book snapshot mid
- [x] Default liquidateOn excludes `last`
- [x] Tests prove empty → null, stale → null, integration with liq tick
- [ ] Live index feed (product later)

## First PR

feat/trade-futures-mark-source — pure port only.
