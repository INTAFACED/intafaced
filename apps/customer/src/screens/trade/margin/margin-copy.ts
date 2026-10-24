import { defineCopy } from '../../../shared/i18n';

// English source only (UI-SPEC §4.4). Every refused control says the real reason in one sentence.
export const marginCopy = defineCopy('trade.margin', {
  'Margin account': 'Margin account',
  'Margin intro':
    'Futures margin is isolated: each position carries its own margin and can lose only that. This page shows how much you have at risk and how close each position is.',

  // Account stats
  'Free balance': 'Free balance',
  'Margin posted': 'Margin posted',
  'Unrealised PnL': 'Unrealised PnL',
  'Open positions': 'Open positions',
  'Margin calls': 'Margin calls',
  'Free balance hint': 'In {asset}. This is what can still be put into a position.',
  'Needs sign in': 'Positions and margin belong to your account.',
  'Sign in title': 'Sign in to see your margin',
  'Sign in': 'Sign in',

  // Health table
  'Position health': 'Position health',
  'Position health table': 'Margin health of your open positions',
  Contract: 'Contract',
  Margin: 'Margin',
  'Maintenance margin': 'Maintenance margin',
  'Margin ratio': 'Margin ratio',
  'Liquidation price': 'Liquidation price',
  Distance: 'Distance',
  State: 'State',
  Actions: 'Actions',
  'Band ok': 'Healthy',
  'Band watch': 'Watch',
  'Band danger': 'Danger',
  'Band liquidation': 'Liquidatable',
  'Band unknown': 'Unknown',
  'Maintenance not published': 'Maintenance margin is not published for this position, so no ratio is shown.',
  'No positions title': 'No open futures positions',
  'No positions body': 'Open a position on the futures desk and its margin health appears here.',
  'Open futures desk': 'Open the futures desk',
  'Table error': 'Couldn’t load your positions',
  'Try again': 'Try again',
  'Band note':
    'Margin ratio is maintenance margin divided by margin plus unrealised PnL. The Healthy, Watch and Danger words are our reading of it (50%, 80%, 100%), not the platform’s liquidation trigger. A position shows — until its figures are available.',
  'Margin call called': 'Margin call {n} delivered, health {health}',

  // Rules
  'Margin rules': 'Margin rules',
  'Margin mode': 'Margin mode',
  'Isolated only': 'Isolated',
  'Cross margin': 'Cross margin',
  'Cross margin off': 'Not offered. A shared pool across positions would let one loss reach another.',
  'Portfolio margin': 'Portfolio margin',
  'Portfolio margin off': 'Not offered. Its offset and floor rules are not published.',
  'Hedge mode': 'Hedge mode',
  'Hedge mode off': 'No position-mode setting is published. Until the platform sets one, new positions are refused.',
  'Collateral class': 'Collateral class',
  'Collateral cash': 'Cash only',
  'Collateral off': 'Yield-bearing, staked and lending balances are refused as margin.',
  'Switch mode': 'Switch margin mode',
  'Switch mode reason': 'Margin mode is chosen when a position opens and can’t be changed afterwards.',
  'Rule offered': 'Offered',
  'Rule not offered': 'Not offered',

  // Spot margin
  'Spot margin': 'Spot margin and borrowing',
  'Spot margin title': 'Spot margin is not offered',
  'Spot margin reason':
    'Borrowing to buy spot has no borrow or repay service, so spot buys are paid in full from your balance. Nothing is borrowed on your behalf.',
  'Trade spot': 'Trade spot',
  'Bank loans': 'See bank loans',

  // Liquidation note
  'How liquidation works': 'How liquidation works',
  'Liquidation point 1':
    'The platform watches each position’s mark price. When a position can no longer cover its maintenance margin it is closed in steps, not all at once where that is safe.',
  'Liquidation point 2': 'While a liquidation step is running, changes to that position are refused.',
  'Liquidation point 3': 'A loss that has been posted is not reversed. A later correction is a new entry.',
  'Liquidation point 4':
    'If a position cannot be closed at a fair price, the platform’s last-resort steps are published in the ADL notice on the futures desk.',
  'ADL notice': 'Read the ADL notice',
});
