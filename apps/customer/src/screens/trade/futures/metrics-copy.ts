import { defineCopy } from '../../../shared/i18n';

// English source only. Curly apostrophes on purpose. Money words: no service names, no internal terms.
const messages = {
  'Metrics heading': 'Account metrics',
  'Metrics thing': 'your account metrics',
  'Metrics equity': 'Equity',
  'Metrics equity hint': 'Margin held on your positions plus their unrealised PnL',
  'Metrics available': 'Available',
  'Metrics available hint': 'Free balance a new position or a margin top-up draws on',
  'Metrics used': 'Used margin',
  'Metrics used hint': 'Margin held on your open positions now',
  'Metrics maintenance': 'Maintenance margin',
  'Metrics maintenance hint': 'What your positions must keep before liquidation starts',
  'Metrics ratio': 'Margin ratio',
  'Metrics ratio hint': 'Maintenance margin divided by equity',
  'Metrics exact': 'Exact figures, worked out by the platform from the current mark price.',
  'Metrics no positions': 'No open position, so there is no margin ratio.',
  'Metrics waiting': 'Not known yet: {fields}.',
  'Metrics mixed':
    'Your positions hold margin in more than one asset, so these figures are not added up across them. Each position shows its own margin and ratio.',
  'Metrics equity not positive': 'Equity is at or below zero, so there is no margin ratio: the position is past its liquidation level.',
  'Missing available': 'your free balance',
  'Missing usedMargin': 'the margin held',
  'Missing maintenanceMargin': 'the maintenance margin (it needs a mark price and the published tiers)',
  'Missing initialMargin': 'the initial margin',
  'Missing collateral': 'the margin held',
  'Missing unrealizedPnl': 'the unrealised PnL (it needs a mark price)',
  'Missing other': 'an input the platform has not published',
} as const;

export const metricsCopy = defineCopy('trade.futures.metrics', messages);
