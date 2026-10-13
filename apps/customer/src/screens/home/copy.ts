import { defineCopy } from '../../shared/i18n';

// English source only (UI-SPEC §4.4); other languages fall back to English.
const messages = {
  Home: 'Home',
  'Est. total value': 'Est. total value',
  'Hide balances': 'Hide balances',
  'Show balances': 'Show balances',
  'How the total is worked out': 'How the total is worked out',
  'Total value rule':
    'USDT and USDC count as 1 USD. Other assets are valued at their last price against USDT, or USDC if there is no USDT market. Assets without a price are not counted.',
  Today: 'Today',
  'Today, from price moves': 'Today, from price moves',
  'Since {time}': 'since {time}',
  'Today change rule': 'Based on what you hold now and today’s prices. Trades and transfers made today are not counted.',
  'Today change rule label': 'About this change',
  Buy: 'Buy',
  Sell: 'Sell',
  Convert: 'Convert',
  Send: 'Send',
  Receive: 'Receive',
  Actions: 'Actions',
  'Your holdings': 'Your holdings',
  Cash: 'Cash',
  Crypto: 'Crypto',
  'No crypto yet': 'You don’t own any crypto yet.',
  'Assets not counted': '+ {count} assets not counted (no USD price)',
  'Asset not counted': '+ 1 asset not counted (no USD price)',
  'Not counted list': 'Not counted: {assets}',
  'Not counted label': 'Assets not counted',
  'Couldn’t load your balance': 'Couldn’t load your balance.',
  'Try again': 'Try again',
  Markets: 'Markets',
  'Couldn’t load markets': 'Couldn’t load markets.',
  'Top movers': 'Top movers',
  'Top movers rule': 'Biggest price moves in the last 24 hours',
  'Top movers label': 'About top movers',
  Watchlist: 'Watchlist',
  Popular: 'Popular',
  Edit: 'Edit',
  'Edit your watchlist': 'Edit your watchlist',
  Bitcoin: 'Bitcoin',
  Ethereum: 'Ethereum',
  Tether: 'Tether',
  'USD Coin': 'USD Coin',
} as const;

export const homeCopy: ReturnType<typeof defineCopy<typeof messages>> = defineCopy('customer.home', messages);

/** Plain names for the few assets we can name without guessing; anything else shows only its ticker. */
const assetNameKey = {
  BTC: 'Bitcoin',
  ETH: 'Ethereum',
  USDT: 'Tether',
  USDC: 'USD Coin',
} as const satisfies Record<string, keyof typeof messages>;

/** The plain name for an asset we can name, else null (the ticker then stands alone). */
export function assetName(base: string, copy: Pick<ReturnType<typeof homeCopy.useCopy>, 't'>): string | null {
  return base in assetNameKey ? copy.t(assetNameKey[base as keyof typeof assetNameKey]) : null;
}
