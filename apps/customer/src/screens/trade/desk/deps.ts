// The only file in this screen that knows where the shared pieces come from: the Volt kit in @intafaced/ui/lit and the
// data layer in ../../../data (the same pattern as the Home screen).
export {
  Button,
  ChangeText,
  CoinIcon,
  Menu,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Pct,
  Price,
  StateBlock,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  Bone,
} from '@intafaced/ui/lit';
// The desk's loading shapes: Volt draws a placeholder by its shape (rows, figure, chart, form), never a size in pixels.
export { Skeleton, type SkeletonShape } from '@intafaced/ui/lit/templates';

export {
  direction,
  fmtAmount,
  fmtPct,
  fmtPrice,
  refusalCopy,
  useFavorites,
  useTicker,
  useTickers,
  type Loadable,
  type TickerRow,
} from '../../../data';
export { compareDecimal, fractionDigits } from '../../../data/decimal';
export { isHiddenPath } from '../../../app/feature-registry';
export { defaultDeskPair, normalizePair } from '../../../app/navigation';
