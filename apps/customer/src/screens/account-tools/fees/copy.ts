import { defineCopy } from '../../../shared/i18n';

// English source only (UI-SPEC 4.4). Plain words: no internal terms, none of the banned words.
const messages = {
  title: 'Fees',
  line: 'What trading costs, and the fee level your account is on.',
  retry: 'Try again',

  'your level': 'Your fee level',
  'your volume': '30-day trading volume',
  'your discount': 'Rank discount',
  'level caption': 'Levels based on how much you trade haven’t been set yet.',
  'volume caption': 'We don’t count your trading volume towards a fee level yet.',
  'discount caption': 'Taken off your trading fees. From Rank {rank}.',
  'discount caption none': 'Taken off your trading fees. Rank up to earn one.',
  'rank loading': 'Loading your rank',
  'rank failed': 'Couldn’t load your rank',

  'levels title': 'Fee levels',
  'col level': 'Level',
  'col volume': '30-day volume',
  'col maker': 'Maker',
  'col taker': 'Taker',
  'levels none': '—',
  'levels caption':
    'Levels and their rates haven’t been set yet. Until they are, the market rates below apply to everyone, less your rank discount.',

  'markets title': 'Rates by market',
  'markets label': 'Trading fees by market',
  'col market': 'Market',
  'markets loading': 'Loading market rates',
  'markets failed': 'Couldn’t load market rates',
  'markets empty title': 'No markets yet',
  'markets empty body': 'Rates will show here when markets open.',
  'markets caption': '— means a rate hasn’t been set for that market yet.',
  'maker note': 'Maker: your order rests on the book and someone else trades with it.',
  'taker note': 'Taker: your order trades with one already on the book.',
  'rank word': 'Rank {rank}',
} as const;

export const feesCopy: ReturnType<typeof defineCopy<typeof messages>> = defineCopy('customer.account-tools.fees', messages);
