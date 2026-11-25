import { defineCopy } from '../../shared/i18n';

// English source only (UI-SPEC §4.4); other languages fall back to English.
const messages = {
  'Switch market': 'Switch market',
  'Search {count} markets: a coin, a pair, a perp': 'Search {count} markets: a coin, a pair, a perp',
  'Search markets': 'Search markets',
  'Show markets': 'Show markets',
  All: 'All',
  Favorites: 'Favorites',
  Perps: 'Perps',
  Spot: 'Spot',
  Perp: 'Perp',
  Recent: 'Recent',
  Results: 'Results',
  'Recently opened': 'Recently opened',
  '{count} markets': '{count} markets',
  '1 market': '1 market',
  '{name} perpetual': '{name} perpetual',
  '{name} spot': '{name} spot',
  'Vol {volume}': 'Vol {volume}',
  '{pair}, last 24 hours': '{pair}, last 24 hours',
  'No market matches “{query}”. Try a coin like BTC, or a pair like ETH/USDC.':
    'No market matches “{query}”. Try a coin like BTC, or a pair like ETH/USDC.',
  'No favorites yet. Star a market on Markets to keep it here.': 'No favorites yet. Star a market on Markets to keep it here.',
  'Loading markets…': 'Loading markets…',
  'Markets could not be loaded.': 'Markets could not be loaded.',
  'Try again': 'Try again',
  'No markets are open right now.': 'No markets are open right now.',
  'This market’s desk is not open here': 'This market’s desk is not open here',
  'No price yet': 'No price yet',
  move: 'move',
  'open the desk': 'open the desk',
  'new tab': 'new tab',
  close: 'close',
  'prices, testnet venue': 'prices, testnet venue',
  Close: 'Close',
} as const;

export const switcherCopy = defineCopy('customer.markets.switcher', messages);
