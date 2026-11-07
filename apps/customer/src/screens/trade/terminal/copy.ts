import { defineCopy } from '../../../shared/i18n';

// English source only. Customer words: say what is true and name the real reason in one sentence.
const messages = {
  Terminal: 'Terminal',
  'Terminal description': 'Your orders, fills, copied positions and algo orders in one view, read from your account.',
  'Terminal tabs': 'Terminal',
  Orders: 'Orders',
  History: 'History',
  Positions: 'Positions',
  'Algo orders': 'Algo orders',
  DOM: 'DOM',
  'Sign in title': 'Sign in to open the terminal',
  'Sign in reason': 'Orders, fills and positions belong to your account, so they only show once you are signed in.',
  'Sign in': 'Sign in',

  'Open orders': 'Open orders',
  'No open orders': 'No open orders',
  'Order history': 'Order history',
  'No ended orders': 'No ended orders yet',
  Fills: 'Fills',
  'No fills': 'No fills yet',
  'History partly unread': 'Part of your history could not be read just now, so it may be missing rows. It is read again shortly.',

  'Copied from {leader}': 'Copied from {leader}',
  'No follows': 'You are not copying anyone',
  'No follows reason': 'A copied position shows here once you follow a leader and one of their trades is copied.',
  'Follows unread': 'Your follows could not be read just now.',
  'Check in Copy': 'A close is still waiting for an answer. Open Copy to check it; closes stay locked until then.',
  'Open Copy': 'Open Copy',

  'Child orders': 'Child orders',
  'Pick a schedule': 'Pick an algo order above to list its child orders and fills.',
  'No child orders': 'No child orders yet',
  'Child orders of {id}': 'Child orders and fills of {id}',

  'Depth of market': 'Depth of market',
  'DOM preview title': 'Depth of market · Preview',
  'DOM preview engine': 'Engine: CFD dealing and MetaTrader 5-class account server',
  'DOM preview reason':
    'Depth beyond our own books needs this engine, and it is not connected yet. Nothing below is a live price, and nothing here can be traded.',
  'DOM live link': 'Live depth of our own BTC/USDT book is on the spot desk',
  'Preview · sample data': 'Preview · sample data',
  TEST: 'TEST',
  'Sample level': 'Sample',
  Bid: 'Bid',
  Ask: 'Ask',
  Price: 'Price',
  Size: 'Size',
  Side: 'Side',
} as const;

export const terminalCopy = defineCopy('trade.terminal', messages);
