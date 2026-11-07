import { defineCopy } from '../../../shared/i18n';

// Market analytics (SP-markets-data-03 b; J-cex-spot-14 #9). English source; other languages fall back to English.
const en = {
  title: 'Market analytics',
  description: 'Who took liquidity in a named window, read from the public trades. Nothing here is a forecast.',
  window: 'Window',
  window_5m: 'Last 5 minutes',
  window_1h: 'Last 1 hour',
  window_24h: 'Last 24 hours',
  differential: 'Aggressor differential',
  differentialNote: 'Bought by takers minus sold by takers, in {base}',
  bought: 'Bought by takers',
  sold: 'Sold by takers',
  trades: 'Trades',
  tradesSplit: '{buys} buy-initiated, {sells} sell-initiated',
  range: 'Range',
  rangeNone: 'No trades in this window',
  windowLine: 'Window: {window}, {from} to {to} UTC',
  partial: 'More trades than one read holds: these figures cover {from} to {to} UTC only.',
  explain:
    'A trade is buy-initiated when the taker bought. The differential is positive when buyers took more than sellers in the window. Every figure is computed from the public trade tape on each read.',
  pairUnknownTitle: 'There’s no such market',
  pairUnknownBody: 'Check the pair in the address, for example BTC-USDT.',
  windowUnsetTitle: 'Pick a window',
  windowUnsetBody: 'Analytics need a named window: 5 minutes, 1 hour or 24 hours.',
  failedTitle: 'Analytics couldn’t load',
  failedBody: 'Nothing is shown rather than an old or guessed figure. Try again.',
} as const;
export const marketAnalyticsCopy = defineCopy('trade.marketAnalytics', en);
