import { defineCopy } from '../../../shared/i18n';

// The spot desk's words in venue mode (B1, J-cex-spot-01). English source only; the shared venue words are in
// features/trade/venue/venue-copy.ts, and the ticket's own words are today's desk's (copy.ts).
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

  // The venue account panel
  'Venue account': 'Your venue account',
  'Venue account note': 'Your own account on the venue. These are the venue’s figures; INTAFACED holds none of it.',
  Free: 'Free',
  Used: 'Used',
  'As of': 'As of',
  Deposit: 'Deposit',
  Withdraw: 'Withdraw',
  Connected: 'Connected',

  // The ticket
  'No price protection': 'Market orders are closed: the price protection that bounds them is not set.',
  'Worst price line': 'Worst price: {price} {quote}',
  'No book side': 'The venue shows no price to meet on this side, so no market order can be placed now.',
  'Venue fees line': 'The venue’s fees: maker {maker}, taker {taker}',
  'Checking venue': 'Checking with the venue…',
  'Connect to trade': 'Connect your wallet to trade on your venue account.',
  'Checking verification': 'Checking your verification…',
  'Verification unread': 'Your verification could not be read, so no order is sent. Reload to try again.',
  'Not a step': '{field} must be a multiple of {step}.',
  'Enter amount': 'Enter an amount.',
  'Enter price': 'Enter a price.',
  'Waiting wallet': 'Waiting for your wallet…',

  // The review
  'Review intro': 'These are the venue’s own figures for this order. Nothing is signed until you confirm.',
  'Venue locks': 'The venue locks',
  'Venue fee': 'Venue’s fee',
  'Our builder fee': 'Our builder fee',
  'Fee role': 'Fee role',
  'Client id': 'Client id held for retry',
  'Worst price review': 'Worst price (slippage limit)',
  Cancel: 'Cancel',
  'Confirm buy': 'Confirm buy',
  'Confirm sell': 'Confirm sell',

  // Deposit
  'Deposit title': 'Deposit into your venue account',
  'Deposit why':
    'Your wallet sends {asset} from your own address to the venue’s deposit address. The venue credits your account; INTAFACED moves nothing.',
  'Deposit amount': 'Amount ({asset})',
  'Deposit to': 'To the venue’s deposit address',
  'Deposit token': 'Token',
  'Deposit network': 'Network',
  'Deposit send': 'Deposit and sign in your wallet',
  'Deposit no route': 'The venue names no deposit address, so no deposit can be made from here.',
  'Deposit wrong network': 'The venue takes deposits on network {chainId}; your wallet is on another one.',
  'Deposit amount bad': 'Enter an amount of {asset} with at most {places} decimals.',
  'Deposit sent': 'Sent from your wallet: {amount} {asset}. The venue credits it when it sees the transfer.',
  'Deposit failed': 'Nothing was sent: {detail}',
  'Deposit rejected': 'You cancelled in your wallet. Nothing was sent.',

  // Withdraw
  'Withdraw title': 'Withdraw to your wallet',
  'Withdraw amount': 'Amount ({asset})',
  'Withdraw to': 'To your wallet',
  'Withdraw send': 'Withdraw and sign in your wallet',
  'Withdraw amount bad': 'Enter an amount to withdraw.',
});
