import { defaultDeskPair, isHiddenPath } from './deps';

/** Buy and Sell open the instant Buy card once it is live; until then the working spot desk. */
const buyLive = () => !isHiddenPath('/trade/buy');
const deskHref = (symbol: string, sell: boolean) => `/trade/spot/${symbol}${sell ? '?side=sell' : ''}`;

/** Where Buy (or Sell) goes for a coin; null when no live page can take it. */
export function buyHref(asset: string | null, symbol: string | null, sell: boolean): string | null {
  if (buyLive()) return `/trade/buy?${asset ? `asset=${encodeURIComponent(asset)}&` : ''}side=${sell ? 'sell' : 'buy'}`;
  const target = symbol ?? defaultDeskPair;
  return isHiddenPath(`/trade/spot/${target}`) ? null : deskHref(target, sell);
}
