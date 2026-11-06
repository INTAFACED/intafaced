import { defineCopy } from '../../../shared/i18n';

// English source only. Customer words: what is true and why a control is off. Curly apostrophes on purpose.
const messages = {
  Eyebrow: 'Trade',
  Title: 'Positions',
  Lead: 'Every position you hold, by product, with totals that are the sum of the rows.',
  'Signed out title': 'Sign in to see your positions',
  'Signed out reason': 'Your positions are private to your account.',
  'Sign in': 'Sign in',

  'Mode label': 'Position mode',
  'Mode explain':
    'One-way keeps one position per contract, so a buy against a short reduces it. Hedge keeps a long and a short on the same contract side by side.',
  'Mode loading': 'Reading your position mode…',
  'Mode now': 'Position mode now: {mode}',
  'Mode one way': 'One-way',
  'Mode hedge': 'Hedge',
  'Mode unset': 'Not chosen',
  'Mode unset note': 'Choose a position mode before you open a futures position.',
  'Mode fixed': 'This platform’s futures book keeps one position per contract, so the mode is one-way and cannot be changed.',
  'Mode choose': 'Choose a position mode',
  'Mode save': 'Switch mode',
  'Mode switched': 'Position mode switched to {mode}.',

  'Futures label': 'Futures positions',
  'Tag futures': 'Futures',
  'Options label': 'Options positions',
  'Tag options': 'Options',
  'Options blocked title': 'Option positions are not published',
  'Options blocked reason':
    'There is no way to read your open option positions until the options collateral model is published. None are shown, because building them from your fills would invent a position.',
  'Margin label': 'Margin positions',
  'Tag margin': 'Margin',
  'Margin blocked title': 'Spot margin is not offered',
  'Margin blocked reason':
    'Borrowing to buy spot has no borrow or repay service, so there is no margin position to show. Nothing is borrowed on your behalf.',

  'Totals label': 'Totals',
  'Totals count': 'Open positions',
  'Totals margin': 'Margin held',
  'Totals pnl': 'Unrealised PnL',
} as const;

export const positionsRoomCopy = defineCopy('trade.positions', messages);
