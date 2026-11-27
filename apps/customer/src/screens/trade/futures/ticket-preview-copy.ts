import { defineCopy } from '../../../shared/i18n';

// The futures order form before a wallet is connected: the order's figures at the venue's own rates, and the one step
// that comes first. English source only.
export const ticketPreviewCopy = defineCopy('trade.futures.venue.preview', {
  'Venue fees': 'Venue fees: taker {taker}%, maker {maker}%',
  'Venue fees unpublished': 'Venue fees: not published by this venue',
  'Leverage over': 'Leverage on {symbol} is at most {max}x on this venue.',
  'Leverage bad': 'Leverage is a whole number of times, 1 or more.',
  'At review': 'At review',
  'Next step': 'To place it, connect your wallet, then start a trading session: your wallet signs once, and the session signs each order.',
  'Next step wallet': 'To place it, connect your wallet: it signs each order.',
  'Make wallet go': 'Make a wallet to trade',
  'Connect go': 'Use {name} to trade',
});
