import { defineCopy } from '../../../shared/i18n';

// The trading account's statement (J-derivatives-26 #7). English source; curly apostrophes on purpose. The venue is named
// only as its own status names it, and every line is the venue's own record with the venue's own id.
export const tradingStatementCopy = defineCopy('trade.account-statement', {
  title: 'Statement',
  open: 'Open statement',
  close: 'Close statement',
  source: 'Every line is {venue}’s own record of your trading account',
  asOf: 'As of {time}',
  asOfUnknown: 'Time not known',
  empty: '{venue} reports no trade and no liquidation on this account.',
  unread: 'Couldn’t read {venue}’s records: {detail}',
  waiting: 'Statement',
  hRecord: 'Record',
  hTime: 'Time',
  hMarket: 'Market',
  hSize: 'Size',
  hPrice: 'Price',
  hAmount: 'Amount',
  hVenueId: 'Venue id',
  trade: 'Trade',
  tradeFee: 'Trading fee',
  builderFee: 'Builder fee',
  liquidation: 'Liquidation',
  liquidationFee: 'Liquidation fee',
  buy: 'buy',
  sell: 'sell',
  long: 'long',
  short: 'short',
});
