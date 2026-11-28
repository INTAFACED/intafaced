import { Tabs } from '@intafaced/ui/lit/templates';

const ROOMS = [
  { label: 'Spot', href: '/trade/spot/BTC-USDT', match: ['/trade/spot'] },
  { label: 'Margin', href: '/trade/margin' },
  { label: 'Futures', href: '/trade/futures' },
  { label: 'Options', href: '/trade/options' },
  { label: 'Copy', href: '/trade/copy' },
  { label: 'Bots', href: '/trade/bots' },
  { label: 'Convert', href: '/trade/convert' },
  { label: 'Execution', href: '/execution', match: ['/execution'] },
  { label: 'Quote desk', href: '/otc', match: ['/otc'] },
] as const;

/**
 * The one row every Trade room carries (Binance/OKX product switch), so a trader moves between rooms in one click: the
 * kit's section tab bar, its lit tab the route's own (a room it does not list, such as the terminal, lights none).
 */
export function TradeSubNav() {
  return <Tabs label="Trading rooms" items={ROOMS} />;
}
