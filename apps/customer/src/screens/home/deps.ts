// The only file in this screen that knows where the shared pieces come from.
// When B1 (packages/ui components) and B3 (apps/customer/src/data) merge, point these lines at
// '@intafaced/ui' and '../../data/...' and delete ./doubles. Search for TODO(B1/B3).

// TODO(B1): swap to `export { Button, HeroNumber, Sparkline, CoinIcon, Money, Pct, ChangeText, Skeleton, StateBlock, Tooltip } from '@intafaced/ui'`
export { Button, HeroNumber, Sparkline, CoinIcon, Money, Pct, ChangeText, Skeleton, StateBlock, InfoTip } from './doubles/ui';
export { EyeIcon, EyeOffIcon, ChevronRightIcon } from './doubles/icons';

// TODO(B3): swap to '../../data/format' (+ compare/direction helpers if B3 exposes them)
export { fmtUsd, fmtSignedUsd, fmtPrice, fmtPct, directionOf, compareDecimal, absDecimal } from './doubles/format';
export type { Direction } from './doubles/format';

// TODO(B3): swap to '../../data/portfolio', '../../data/markets', ... and '../../data/favorites'
export { usePortfolio, useMarkets, useTickers, useSparklines, useMovers, useFavorites, primarySymbolFor } from './doubles/data';

export type { Decimal, Loadable, MarketRow, PortfolioSummary, TickerRow } from '../../data/types';

// TODO(B2): replace with the feature registry (apps/customer/src/app/feature-registry.ts). Only live actions render.
export const liveActionPaths: ReadonlySet<string> = new Set(['/trade/buy', '/trade/convert', '/pay/send', '/pay/receive']);

// TODO(B3): swap to refusalCopy from '../../data/refusals'
export { refusalCopy } from './doubles/refusals';
