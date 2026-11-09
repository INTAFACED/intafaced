import { defineCopy } from '../../../shared/i18n';

// The spot desk's words in venue mode (B1). English source only; the shared venue words are in
// features/trade/venue/venue-copy.ts.
export const spotVenueCopy = defineCopy('trade.desk.venue', {
  'Spot on venue': '{symbol} spot',
  'Order ticket': 'Order ticket',
  Buy: 'Buy',
  Sell: 'Sell',
  'Order type': 'Order type',
  Limit: 'Limit',
  Market: 'Market',
  Price: 'Price',
  'Worst price': 'Worst price (slippage limit)',
  Amount: 'Amount ({asset})',
  'Time in force': 'Time in force',
  'Review buy': 'Review buy',
  'Buy asset': 'Buy {asset}',
  'Sell asset': 'Sell {asset}',
  'Verify first': 'Verify your identity first',
  'Verify first body': 'You need to be verified for trading to place an order.',
  'Verify now': 'Verify now',
  'Under review': 'Your account is under review',
  'Under review body': 'Orders wait until the review is done. Nothing was sent.',
  'Access unread': 'Your trading access could not be read, so no order can be sent. Try again in a moment.',
  'Review sell': 'Review sell',
  'Positions not applicable': 'Not applicable: cash spot holds balances, not positions',
  'Market not offered': 'This venue does not list this market.',
});
