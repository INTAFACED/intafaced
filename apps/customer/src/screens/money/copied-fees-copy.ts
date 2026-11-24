import { defineCopy } from '../../shared/i18n';

// The follower's copied venue fills on /money/activity (J-copy-bots-otc-06 #1). English source only. The venue is named by
// its own name; INTAFACED is us. A leader is paid a share of our builder fee, never a share of the follower's result.
export const copiedFeesCopy = defineCopy('money.copied-fees', {
  Title: 'Copied trades',
  Lede: 'Each fill a copy made on your venue account, with each fee named by who charged it. The leader’s share comes out of our builder fee: INTAFACED pays it, and you are not charged for it.',
  Reading: 'Reading your copied trades…',
  Unread: 'Your copied trades couldn’t be read right now.',
  Trade: 'Trade',
  'Venue fee': 'Venue fee',
  'Our builder fee': 'Our builder fee',
  'Leader’s share of our builder fee': 'Leader’s share of our builder fee',
  'Bought {amount} {symbol} at {price}': 'Bought {amount} {symbol} at {price}',
  'Sold {amount} {symbol} at {price}': 'Sold {amount} {symbol} at {price}',
  'Fill {id}': 'Fill {id}',
  'Copying {lead}': 'Copying {lead}',
  'a leader no longer listed': 'a leader no longer listed',
  'From {venue}, as it reports it': 'From {venue}, as it reports it',
  'From INTAFACED, charged on the venue': 'From INTAFACED, charged on the venue',
  '{amount} {asset}': '{amount} {asset}',
  '{amount} {asset} to {lead}': '{amount} {asset} to {lead}',
  'Paid by INTAFACED. Not charged to you.': 'Paid by INTAFACED. Not charged to you.',
  'Owed by INTAFACED in our ledger': 'Owed by INTAFACED in our ledger',
  'Owed once the venue pays us this fee': 'Owed once the venue pays us this fee',
  'Recorded once our fee is booked': 'Recorded once our fee is booked',
  'No builder fee on this fill, so nothing is shared': 'No builder fee on this fill, so nothing is shared',
  'Nothing owed: the leader’s cap per follower is reached': 'Nothing owed: the leader’s cap per follower is reached',
  'Nothing owed: the share rounds to nothing': 'Nothing owed: the share rounds to nothing',
  TEST: 'TEST',
});
