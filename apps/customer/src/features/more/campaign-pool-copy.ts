import { defineCopy } from '../../shared/i18n';

const en = {
  title: 'Reward pool',
  loading: 'Reading the pool',
  pool: 'Pool',
  amountValue: '{amount} {asset}',
  slice: 'Paid out each day',
  cap: 'The most one person gets in a day',
  minBalance: 'Minimum venue balance to earn that day',
  dayLength: 'Length of a day',
  dayLengthValue: '{minutes} min',
  howTitle: 'How a day is shared',
  how: 'When a day ends, its slice is shared by activity: the notional of the venue’s fills of your orders placed through INTAFACED that day, in {asset}, over everyone’s. Your share is at most the per-user cap; what the cap keeps back stays in the pool. A day you hold less than the minimum on the venue earns nothing.',
  todayTitle: 'Today',
  todayNotJoined: 'Join to share in the pool.',
  todayOk: 'Day {day}, ending {ends}. Your venue balance: {balance} {asset}, read from the venue at {asOf}. Today’s activity counts.',
  todayBelow:
    'Nothing today: your venue balance of {balance} {asset}, read from the venue at {asOf}, is below the minimum of {min} {asset}.',
  todayUnread: 'Your venue balance could not be read just now ({code}); it is not counted as zero.',
  daysTitle: 'Your share for each day',
  daysLabel: 'Days of the pool',
  colDay: 'Day',
  colActivity: 'Your activity',
  colShare: 'Your share',
  colPaid: 'Paid',
  dayValue: 'Day {day}',
  dayOpen: 'Unsettled: a day is shared once it has ended',
  shareCapped: '{amount} {asset} (held to the per-user cap)',
  nothingToday: 'Nothing that day: your venue balance of {balance} {asset}, read at {asOf}, was below the minimum.',
  noShare: 'No share',
  remainder: 'Shared {shares} of {slice} {asset}; {remainder} stays in the pool.',
  paid: 'Paid',
  owed: 'Owed to you; the payment to your connected wallet is pending',
  noDays: 'No day has started yet.',
} as const;

export const campaignPoolCopy = defineCopy('more.campaigns.pool', en);
