import { defineCopy } from '../../shared/i18n';

// A paper run's orders (J-algo-dev-05 #1 #2 #5 #6): each order's events in order, a reversal's legs and the TEST
// price path resting limits met. Figures, symbols and reasons enter through parameters.
const en = {
  eventsTitle: 'Order events',
  eventsNone: 'This run placed no orders.',
  eventsNote: 'Every event of every order, in the order it happened. Paper — nothing left the paper book.',
  event: '{order} {kind}: {side} {qty} {symbol} ({type}), market {market}',
  eventLimit: ', limit {limit}',
  eventPrice: ', filled at {price}',
  eventFee: ', fee {fee}',
  eventReason: ' — {reason}',
  eventCash: ': notional {notional} plus fee {fee} is more than the cash {cash}',
  eventPosition: ': position {position}, resting sells {reserved}',
  legsTitle: 'Reversal legs',
  leg: '{leg} leg: {side} {qty} {symbol}, checked, {outcome}',
  legReason: ' — {reason}',
  noShortRule: 'no short rule: spot paper has no published rule for opening a short',
  ticksTitle: 'TEST price path',
  ticksNote: 'After the script, resting limit orders meet this TEST path once. It is a fixture, not a feed.',
  ticks: '{symbol}: {path}',
} as const;

export const ordersCopy = defineCopy('quant.orders', en);
