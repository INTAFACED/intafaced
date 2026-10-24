// The only file in this screen that knows where the shared pieces come from: the kit in @intafaced/ui, the data
// layer in ../../data and the feature registry (same arrangement as screens/home/deps.ts).
export {
  Amount,
  Button,
  ChangeText,
  CoinIcon,
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
  HeroNumber,
  Money,
  Pct,
  Skeleton,
  StateBlock,
  StatusTag,
  Switch,
  Tabs,
  TabsList,
  TabsTab,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@intafaced/ui';

export { fmtAmount, fmtChangeLine, fmtPct, fmtUsd, refusalCopy, useMarkets } from '../../data';
export type { Decimal, Loadable, MarketRow } from '../../data';
export type { BalanceEntry } from '../../data/derive';
// The activity hook is a new file in the data layer (not yet in the data barrel).
export { ACTIVITY_KINDS, ACTIVITY_PAGE_SIZE, useActivity } from '../../data/activity';
export type { ActivityFeed, ActivityItem, ActivityKind } from '../../data/activity';
export { dec, decOrNull, roundScaled, SCALE, str, times, toFixedString } from '../../data/decimal';
export { primarySymbolFor } from '../../data/derive';

export { isHiddenPath } from '../../app/feature-registry';
export { coinHref, defaultDeskPair } from '../../app/navigation';
export { navigate } from '../../app/location';
export { quotePlaces } from '../trade/desk/text';
