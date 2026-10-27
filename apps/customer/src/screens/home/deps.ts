// The only file in this screen that knows where the shared pieces come from: the kit in
// @intafaced/ui (B1), the data layer in ../../data (B3) and the feature registry (B2).
export { Amount, Button, ChangeText, CoinIcon, HeroNumber, Money, Pct, Skeleton, Sparkline, StateBlock, StatusTag } from '@intafaced/ui';
export { Tooltip, TooltipContent, TooltipTrigger } from '@intafaced/ui';
export { Loading } from '../../shared/ui';

export {
  direction,
  fmtAmount,
  fmtChangeLine,
  fmtPct,
  fmtPrice,
  fmtUsd,
  classifyRefusal,
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
export { moneyUnitOf, useDisplayRate, useHomePortfolio } from '../money/portfolio-source';
export { DerivedTotalTag } from '../money/total-note';
// One row per movement, as the Activity room groups them (an order's fills, holds and fees are one row).
export { groupActivity } from '../money/activity-view';
export { detailHref } from '../money/activity-detail';
export type { HomeHolding, HomePortfolio } from '../money/portfolio-source';
export { compareDecimal, dec, decOrNull, ratio, roundScaled, str, sub, toFixedString } from '../../data/decimal';

export { isHiddenPath } from '../../app/feature-registry';
export { coinHref, defaultDeskPair } from '../../app/navigation';
