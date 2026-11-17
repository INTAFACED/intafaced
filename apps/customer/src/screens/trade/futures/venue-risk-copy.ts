import { defineCopy } from '../../../shared/i18n';

// The venue's own risk figures on the venue futures desk (J-derivatives-02): its margin tiers, what it takes as margin
// with each haircut, and the buying power that leaves. English source only.
export const venueRiskCopy = defineCopy('trade.futures.venue.risk', {
  'Tiers title': 'Margin tiers on {venue}',
  'Tiers table': 'Margin tiers {symbol}',
  Tier: 'Tier',
  'From notional': 'Position from',
  'Most leverage': 'Most leverage',
  'Maintenance rate': 'Maintenance margin',
  'Tiers note': 'As {venue} publishes them: a larger position falls in a higher tier, with less leverage and a higher maintenance margin.',
  'Tiers not published': 'Margin tiers not published by {venue}. Nothing is shown in their place.',
  'Collateral title': 'What {venue} takes as margin',
  'Collateral table': 'Margin {venue} takes on {symbol}',
  Asset: 'Asset',
  Haircut: 'Haircut',
  'Haircut not published': 'not published by {venue}',
  'Free on venue': 'Free on the venue',
  'Counts toward buying power': 'Counts toward buying power',
  'Buying power': 'Buying power on {symbol}',
  'Buying power value': '{amount} {asset}',
  'Buying power unknown': 'Not known: {venue} publishes no haircut for {asset}',
  'Buying power note': 'Buying power is the free balance of what {venue} takes as margin, less its haircut. Nothing else counts.',
  'Not taken title': 'Not taken as margin by {venue}',
  'Not taken row': '{asset}: {venue} does not take it as margin on {symbol}, so it adds nothing to buying power',
  'Collateral not published': '{venue} publishes no list of what it takes as margin on {symbol}.',
  'Margin not taken':
    '{venue} does not take {asset} as margin on {symbol}: it takes {taken}. Nothing was sent, and buying power is unchanged.',
  'Room left': 'Room left under the cap: {room} {base}, as the venue reports it.',
});
