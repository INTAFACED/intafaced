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
  'Review sell': 'Review sell',
  'Positions not applicable': 'Not applicable: cash spot holds balances, not positions',
  'Market not offered': 'This venue does not list this market.',
});
