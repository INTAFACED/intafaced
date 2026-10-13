import { defineCopy } from '../../shared/i18n';

// English source only (UI-SPEC §4.4); other languages fall back to English.
// Home Pro shares the Simple catalog (copy.ts) for words both screens use; this catalog holds the new ones, plus the
// words of the Simple / Pro switch in the top bar (so the shell does not need a new catalog for one tooltip).
const messages = {
  // The switch in the top bar
  'Switch name': 'Simple or Pro layout',
  'Switch tip':
    'Simple keeps things calm: big numbers and a few steps to buy. Pro is denser: tables with more columns, and markets that open the trading desk.',

  // Summary strip
  'Home summary': 'Summary',
  'Open orders': 'Open orders',
  'Open orders count': '{count} open orders',
  'Quick actions': 'Quick actions',

  // Your assets
  'Your assets': 'Your assets',
  Asset: 'Asset',
  Amount: 'Amount',
  Value: 'Value',
  Today: 'Today',
  Trade: 'Trade',
  'Trade {asset}': 'Trade {asset}',
  'View all assets': 'View all assets',
  'No assets yet': 'You don’t own any assets yet.',
  'No assets body': 'Receive crypto or buy some to see it here.',
  'Couldn’t load your assets': 'Couldn’t load your assets.',

  // Markets
  Markets: 'Markets',
  Favorites: 'Favorites',
  All: 'All',
  Gainers: 'Gainers',
  Losers: 'Losers',
  New: 'New',
  'Market filters': 'Market filters',
  'See all markets': 'See all markets',
  'Couldn’t load markets': 'Couldn’t load markets.',
  'Couldn’t load prices': 'Couldn’t load prices. The list may be out of date.',
  'Try again': 'Try again',
  'Star a market to keep it here.': 'Star a market to keep it here.',
  'Log in to keep your favorites here.': 'Log in to keep your favorites here.',
  'Browse markets': 'Browse markets',
  'Log in': 'Log in',
  'No markets are open right now.': 'No markets are open right now.',
  'Nothing is gaining right now.': 'Nothing is gaining right now.',
  'Nothing is falling right now.': 'Nothing is falling right now.',
  'No new listings.': 'No new listings.',
} as const;

export const proCopy: ReturnType<typeof defineCopy<typeof messages>> = defineCopy('customer.home.pro', messages);
