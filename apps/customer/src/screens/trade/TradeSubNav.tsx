import { SubNav } from '@intafaced/ui';

export type TradeRoom = 'spot' | 'margin' | 'futures' | 'options' | 'copy' | 'bots' | 'execution' | 'otc' | 'convert';

const ROOMS = [
  { id: 'spot', label: 'Spot', href: '/trade/spot/BTC-USDT' },
  { id: 'margin', label: 'Margin', href: '/trade/margin' },
  { id: 'futures', label: 'Futures', href: '/trade/futures' },
  { id: 'options', label: 'Options', href: '/trade/options' },
  { id: 'copy', label: 'Copy', href: '/trade/copy' },
  { id: 'bots', label: 'Bots', href: '/trade/bots' },
  { id: 'convert', label: 'Convert', href: '/trade/convert' },
  { id: 'execution', label: 'Execution', href: '/execution' },
  { id: 'otc', label: 'Quote desk', href: '/otc' },
] as const;

/** The one row every Trade room carries (Binance/OKX product switch), so a trader moves between rooms in one click and the row never changes size. */
export function TradeSubNav({ active, className }: { active: TradeRoom; className?: string }) {
  return <SubNav aria-label="Trading rooms" items={ROOMS} active={active} className={className} />;
}
