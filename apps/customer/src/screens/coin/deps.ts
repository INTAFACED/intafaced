// The only file in this screen that knows where the shared pieces come from: the kit in @intafaced/ui, the data
// layer in ../../data, the Simple Buy card and chart adapter from the trade screens, and the feature registry.
export {
  Amount,
  Button,
  ChangeText,
  CoinIcon,
  HeroNumber,
  Money,
  Pct,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  StateBlock,
  ToggleGroup,
  ToggleGroupItem,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@intafaced/ui';

export {
  classifyRefusal,
  direction,
  fmtAmount,
  fmtChangeLine,
  fmtPct,
  fmtPrice,
  fmtUsd,
  primarySymbolFor,
  refusalCopy,
  useDataEnv,
  useFavorites,
  useMarkets,
  usePortfolio,
  useTicker,
} from '../../data';
export type { Candle, Decimal, Holding, Loadable, MarketRow, PortfolioSummary, TickerRow } from '../../data';
export { dec, decOrNull, fractionDigits, ratio, roundScaled, sub, times, toFixedString } from '../../data/decimal';
export { PAR_ASSETS } from '../../data/derive';

export { tickerSource } from '../../data/queries';

export { isHiddenPath } from '../../app/feature-registry';
export { coinHref } from '../../app/navigation';
export { navigate } from '../../app/location';

// Reused as they are: the Simple Buy and Sell card, the chart's candle hook, the desk's own fills list and tables.
export { BuyCard } from '../trade/buy/BuyCard';
export { useChartCandles, type ChartInterval } from '../trade/chart/candles';
export { useDeskMarkets, useFills } from '../trade/desk/data';
// How many fills the fills call returns at most; a full page means older fills may exist that it never saw.
export { FILLS_PAGE } from '../money/activity-view';
export { byNewest, FillsTable, LoadState, precisionOf } from '../trade/desk/OrderTables';
export { stepOf } from '../trade/chart/chart-data';
export { partialWindowStart, sinceLabel } from '../trade/markets/window';
export { zoneName } from '../trade/desk/time';
export { usePreferences } from '../../shared/preferences';
export { useSession } from '../../features/session/session';
export { useLotBook } from '../money/pnl-source';
export { fmtUsdChange } from '../../data/format';
export { useSupportedAssets } from '../../features/money/supported-assets-reads';
