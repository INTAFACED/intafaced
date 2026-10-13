import { defineCopy } from '../../shared/i18n';

// English source only (UI-SPEC §4.4). Plain money words: no internal terms, none of the banned words.
const messages = {
  // Portfolio
  Money: 'Money',
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
  Actions: 'Actions',
  Buy: 'Buy',
  Sell: 'Sell',
  Convert: 'Convert',
  Send: 'Send',
  Receive: 'Receive',
  'Buy {asset}': 'Buy {asset}',
  'Sell {asset}': 'Sell {asset}',
  'Send {asset}': 'Send {asset}',
  'Assets not counted': 'Excludes {count} coins (no USD price)',
  'Asset not counted': 'Excludes 1 coin (no USD price)',
  'Not counted list': 'Not counted: {assets}',
  'Not counted label': 'Coins not counted',
  'Where your money is': 'Where your money is',
  'Share of your total': 'Share of your total by coin',
  Other: 'Other',
  Cash: 'Cash',
  Crypto: 'Crypto',
  Coin: 'Coin',
  Amount: 'Amount',
  Value: 'Value',
  Share: 'Share',
  'Small balances': 'Small balances',
  '{count} coins under $1': '{count} coins under $1',
  '1 coin under $1': '1 coin under $1',
  'Your accounts': 'Your accounts',
  'Your accounts note': 'Money you have set aside in named accounts. It is already counted in your total.',
  'Nothing held': 'You don’t hold anything yet.',
  'Nothing held body': 'Buy crypto, or ask someone on INTAFACED to send you USDT.',
  'Buy crypto': 'Buy crypto',
  'Couldn’t load your balance': 'Couldn’t load your balance.',
  'Try again': 'Try again',
  Bitcoin: 'Bitcoin',
  Ethereum: 'Ethereum',
  Tether: 'Tether',
  'USD Coin': 'USD Coin',

  // Activity
  Activity: 'Activity',
  All: 'All',
  Deposits: 'Deposits',
  Transfers: 'Transfers',
  Trades: 'Trades',
  'Activity filters': 'Filter your activity',
  Date: 'Date',
  Status: 'Status',
  Completed: 'Completed',
  'Load more': 'Load more',
  'Loading more': 'Loading…',
  'Couldn’t load more': 'Couldn’t load more.',
  'Couldn’t load your activity': 'Couldn’t load your activity.',
  'No activity yet': 'No activity yet',
  'No activity yet body': 'When you receive, send or trade, it shows up here.',
  'No deposits yet': 'No deposits yet',
  'No transfers yet': 'No transfers yet',
  'No trades yet': 'No trades yet',
  'Nothing of this kind yet body': 'Nothing here so far. Your other activity is under All.',
  'See all activity': 'See all activity',
  'Searching your history': 'Looking further back…',
  'Loading activity': 'Loading your activity',

  // What each kind of entry is called
  Deposit: 'Deposit',
  'Welcome test funds': 'Welcome test funds',
  Received: 'Received',
  'Received from {handle}': 'Received from @{handle}',
  Sent: 'Sent',
  'Sent to {handle}': 'Sent to @{handle}',
  Trade: 'Trade',
  Fee: 'Fee',
  'Payment received': 'Payment received',
  'Payment sent': 'Payment sent',
  Withdrawal: 'Withdrawal',
  'Moved between your accounts': 'Moved between your accounts',
  'Other activity': 'Other activity',
  'In account {name}': 'Account: {name}',
} as const;

export const moneyCopy: ReturnType<typeof defineCopy<typeof messages>> = defineCopy('customer.money', messages);

const assetNameKey = {
  BTC: 'Bitcoin',
  ETH: 'Ethereum',
  USDT: 'Tether',
  USDC: 'USD Coin',
} as const satisfies Record<string, keyof typeof messages>;

/** The plain name for an asset we can name, else null (the ticker then stands alone). */
export function assetName(asset: string, copy: Pick<ReturnType<typeof moneyCopy.useCopy>, 't'>): string | null {
  return asset in assetNameKey ? copy.t(assetNameKey[asset as keyof typeof assetNameKey]) : null;
}
