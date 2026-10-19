// The only file in this screen that knows where the shared pieces come from: the kit in
// @intafaced/ui (B1), the data layer in ../../data (B3) and the feature registry (B2).
export { Amount, Button, ChangeText, CoinIcon, HeroNumber, Money, Pct, Skeleton, Sparkline, StateBlock, StatusTag } from '@intafaced/ui';
export { Tooltip, TooltipContent, TooltipTrigger } from '@intafaced/ui';

export {
  direction,
  fmtAmount,
  fmtChangeLine,
  fmtPct,
  fmtPrice,
  fmtUsd,
  refusalCopy,
  useActivity,
  useFavorites,
  useMarkets,
  useMovers,
  useSparklines,
  useTickers,
} from '../../data';
export type { ActivityFeed, ActivityItem, Decimal, Loadable, MarketRow, TickerRow } from '../../data';
// One total: Home reads the same source as the Money screen (the bank's valuation, which counts named accounts).
export { useHomePortfolio } from '../money/portfolio-source';
export { DerivedTotalNote } from '../money/total-note';
export type { HomeHolding, HomePortfolio } from '../money/portfolio-source';
export { compareDecimal, dec, decOrNull, ratio, roundScaled, sub, toFixedString } from '../../data/decimal';

export { isHiddenPath } from '../../app/feature-registry';
export { coinHref, defaultDeskPair } from '../../app/navigation';
