import { defineCopy } from '../../../shared/i18n';

// The trading account statement (J-derivatives-25 #12). English source; curly apostrophes on purpose. No venue or partner
// brand is written here: each name is the one its own source gives. Every row is its source's own record, shown with the
// reference that source gave it; nothing here is a figure INTAFACED keeps.
export const statementCopy = defineCopy('trade.account-statement', {
  title: 'Statement',
  lead: 'Every move, fill and fee on your trading account, each with the reference its own source gave it: your venue, the chain or your partner bank. INTAFACED holds none of this money and keeps no figure of its own for it.',
  open: 'Open statement',
  close: 'Close statement',
  movesTitle: 'Moves',
  movesNone: 'No moves between your spending and trading money.',
  fillsTitle: 'Fills at {venue}',
  fillsSource: 'From {venue}',
  fillsNone: 'No fills on this venue account.',
  asOf: 'As of {time}',
  readFailed: 'Couldn’t read: {detail}',
  hWhen: 'When',
  hWhat: 'What',
  hAmount: 'Amount',
  hReference: 'Reference',
  hFee: 'Fee',
  hMarket: 'Market',
  hSide: 'Side',
  hSize: 'Size',
  hPrice: 'Price',
  legPartner: '{partner} sent to your wallet',
  legDeposit: 'Your wallet deposited to {venue}',
  refPartner: 'Partner reference {ref}',
  refChain: 'Chain transaction {tx}',
  refVenue: 'Venue fill {id}',
  notKnown: 'not known',
  notSent: 'Not sent',
  feeAmount: '{fee} {asset}',
  venueFee: 'Venue’s fee {fee} {asset}',
  builderFee: 'Our builder fee {fee} {asset}',
  buy: 'Buy',
  sell: 'Sell',
});
