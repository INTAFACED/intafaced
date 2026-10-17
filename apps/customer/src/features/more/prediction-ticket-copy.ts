import { defineCopy } from '../../shared/i18n';

// English source only. Prediction markets run on INTACORE; until it is activated every control here is switched off with that reason.
export const ticketCopy = defineCopy('prediction-ticket', {
  title: 'Place an order',
  idleBody: 'Open an event from the list, then choose Yes or No, to see its order ticket.',
  intro: 'Pick the side, the kind of order and the number of contracts. A contract pays 1 {asset} if the event resolves your way.',
  chainReason: 'Prediction markets run on INTACORE, which is not activated yet.',
  outcomeFor: 'Order for',
  side: 'Side',
  sideBuy: 'Buy',
  sideSell: 'Sell',
  type: 'Order type',
  typeLimit: 'Limit: at my price or better',
  typeMarket: 'Market: at the best price now',
  quantity: 'Number of contracts',
  price: 'Limit price per contract ({asset})',
  collateralLabel: 'Held as collateral',
  collateralBody: 'The full amount would be held while the order is open: 1 {asset} for each contract.',
  review: 'Review order',
});
