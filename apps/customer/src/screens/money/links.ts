import { defaultDeskPair, isHiddenPath } from './deps';

type Mode = 'simple' | 'pro';

const deskHref = (symbol: string, sell: boolean) => `/trade/spot/${symbol}${sell ? '?side=sell' : ''}`;

/**
 * Where Buy (or Sell) goes for a coin; null when no live page can take it. Simple opens the Buy card; Pro opens the
 * desk (UI-SPEC 5.3: "Trade" is the Buy card in Simple and the desk in Pro). The desk is also the fallback when the
 * Buy card is not live.
 */
export function buyHref(asset: string | null, symbol: string | null, sell: boolean, mode: Mode = 'simple'): string | null {
  if (mode === 'simple' && !isHiddenPath('/trade/buy'))
    return `/trade/buy?${asset ? `asset=${encodeURIComponent(asset)}&` : ''}side=${sell ? 'sell' : 'buy'}`;
  // The desk's address spells a pair with a dash (BTC-USDT); a market's own symbol has a slash (BTC/USDT).
  const target = (symbol ?? defaultDeskPair).replace('/', '-');
  return isHiddenPath(`/trade/spot/${target}`) ? null : deskHref(target, sell);
}
