import type { Door } from './navigation';
import { defaultDeskPair, findRoom, roomDescription, roomTitle, tradeTabHref } from './navigation';
import type { UiLocale } from '../shared/i18n';
import { isHiddenPath } from './feature-registry';
import type { ShellIconName } from './icons';
import type { shellCopy } from './shell-copy';

export type ShellCopyKey = Parameters<typeof shellCopy.t>[0];
/** Copy keys without `{placeholders}`, which `t(key)` can take on their own. */
type PlainKey =
  | 'Portfolio'
  | 'Your assets and their value'
  | 'Activity'
  | 'Trades, orders and transfers'
  | 'Profit and loss'
  | 'What your trades have made or lost'
  | 'Markets'
  | 'Prices for every market'
  | 'Spot'
  | 'Charts, order book and orders'
  | 'Buy and sell'
  | 'Buy crypto in a few steps'
  | 'Convert'
  | 'Swap one asset for another'
  | 'Send'
  | 'Send money to someone on INTAFACED'
  | 'Receive'
  | 'Share your details to get paid'
  | 'Help'
  | 'Answers and support'
  | 'Merchant'
  | 'Accept payments and run your business'
  | 'Academy'
  | 'Learning paths and certificates'
  | 'All rooms'
  | 'Everything INTAFACED offers'
  | 'Settings'
  | 'Display, language and notifications'
  | 'Account'
  | 'Security'
  | 'Verification'
  | 'Orders'
  | 'Open and past orders'
  | 'Advanced';
/**
 * The order of the phone bottom bar: the same five doors, in the same order, as the computer's top bar (owner decision
 * 2026-10-26, "One Money door"). More is the last tab, not a button in the phone header.
 */
export const MOBILE_DOOR_ORDER: readonly Door[] = ['Home', 'Money', 'Trade', 'Pay', 'More'];

export interface MenuItem {
  id: string;
  href: string;
  icon: ShellIconName;
  /** Rows without their own words take the title and description of the room they open, so a new room's name is written once. */
  title?: PlainKey;
  description?: PlainKey;
  /** Rows in the Advanced group sit under a heading in Simple mode; Pro lists every row flat. */
  group?: 'Advanced';
}
export interface TabSpec {
  door: Door;
  href: string;
  icon: ShellIconName;
  items: MenuItem[];
}

/** Path of an item without its query string; this is what the feature registry is asked about. */
function pathOf(href: string): string {
  return href.split('?')[0] ?? href;
}

/**
 * The five top-bar doors and the dropdown rows under them: Home, Money, Trade, Pay, More (owner decision 2026-10-26). Money
 * holds every room of the one ledger, the Assets and Bank rooms alike. A row whose route
 * belongs to a hidden feature would be dropped (none is today); a tab
 * left with no rows is a plain link. More and Settings need a session, so a signed-out visitor's More tab opens the public Help centre
 * (`/help`) and lists only that; a signed-in person gets `/more` and `/support`.
 */
export function tabSpecs(layoutMode: 'simple' | 'pro', signedIn = true): TabSpec[] {
  const all: TabSpec[] = [
    { door: 'Home', href: '/home', icon: 'home', items: [] },
    {
      door: 'Money',
      href: '/money',
      icon: 'wallet',
      items: [
        { id: 'portfolio', href: '/money', icon: 'wallet', title: 'Portfolio', description: 'Your assets and their value' },
        { id: 'deposit', href: '/uc/recharge', icon: 'receive' },
        { id: 'withdraw', href: '/uc/withdraw', icon: 'send' },
        { id: 'transfers', href: '/bank/transfers', icon: 'convert' },
        { id: 'spaces', href: '/bank/spaces', icon: 'wallet' },
        { id: 'cards', href: '/bank/cards', icon: 'cards' },
        { id: 'earn', href: '/bank/earn', icon: 'activity' },
        { id: 'loans', href: '/bank/loans', icon: 'loans' },
        { id: 'activity', href: '/money/activity', icon: 'activity', title: 'Activity', description: 'Trades, orders and transfers' },
        {
          id: 'pnl',
          href: '/money/pnl',
          icon: 'activity',
          title: 'Profit and loss',
          description: 'What your trades have made or lost',
          group: 'Advanced',
        },
        { id: 'addresses', href: '/uc/withdraw/address', icon: 'wallet', group: 'Advanced' },
        { id: 'ramps', href: '/bank/ramps', icon: 'buy', group: 'Advanced' },
        { id: 'analytics', href: '/bank/analytics', icon: 'markets', group: 'Advanced' },
        { id: 'business', href: '/bank/business', icon: 'merchant', group: 'Advanced' },
      ],
    },
    {
      door: 'Trade',
      href: tradeTabHref(layoutMode),
      icon: 'markets',
      items: [
        { id: 'markets', href: '/trade', icon: 'markets', title: 'Markets', description: 'Prices for every market' },
        { id: 'spot', href: `/trade/spot/${defaultDeskPair}`, icon: 'spot', title: 'Spot', description: 'Charts, order book and orders' },
        { id: 'buy', href: '/trade/buy', icon: 'buy', title: 'Buy and sell', description: 'Buy crypto in a few steps' },
        { id: 'convert', href: '/trade/convert', icon: 'convert', title: 'Convert', description: 'Swap one asset for another' },
        { id: 'margin', href: '/trade/margin', icon: 'margin', group: 'Advanced' },
        { id: 'futures', href: '/trade/futures', icon: 'futures', group: 'Advanced' },
        { id: 'options', href: '/trade/options', icon: 'options', group: 'Advanced' },
        { id: 'copy', href: '/trade/copy', icon: 'user', group: 'Advanced' },
        { id: 'bots', href: '/trade/bots', icon: 'settings', group: 'Advanced' },
        { id: 'otc', href: '/otc', icon: 'merchant', group: 'Advanced' },
        { id: 'execution', href: '/execution', icon: 'markets', group: 'Advanced' },
        { id: 'algo', href: '/quant', icon: 'activity', group: 'Advanced' },
        {
          id: 'orders',
          href: '/money/activity?tab=orders',
          icon: 'activity',
          title: 'Orders',
          description: 'Open and past orders',
          group: 'Advanced',
        },
      ],
    },
    {
      door: 'Pay',
      href: '/pay',
      icon: 'send',
      items: [
        { id: 'send', href: '/pay/send', icon: 'send', title: 'Send', description: 'Send money to someone on INTAFACED' },
        { id: 'receive', href: '/pay/receive', icon: 'receive', title: 'Receive', description: 'Share your details to get paid' },
        { id: 'request', href: '/pay/request', icon: 'receive' },
        { id: 'bills', href: '/pay/bills', icon: 'activity' },
        { id: 'global', href: '/pay/global', icon: 'send' },
        { id: 'p2p', href: '/p2p', icon: 'user' },
        {
          id: 'merchant',
          href: '/pay/merchant',
          icon: 'merchant',
          title: 'Merchant',
          description: 'Accept payments and run your business',
        },
      ],
    },
    {
      door: 'More',
      href: signedIn ? '/more' : '/help',
      icon: 'grid',
      items: signedIn
        ? [
            { id: 'academy', href: '/academy', icon: 'academy', title: 'Academy', description: 'Learning paths and certificates' },
            { id: 'rooms', href: '/more', icon: 'grid', title: 'All rooms', description: 'Everything INTAFACED offers' },
            { id: 'help', href: '/support', icon: 'help', title: 'Help', description: 'Answers and support' },
            { id: 'settings', href: '/view', icon: 'settings', title: 'Settings', description: 'Display, language and notifications' },
          ]
        : [{ id: 'help', href: '/help', icon: 'help', title: 'Help', description: 'Answers and support' }],
    },
  ];
  return all.map((tab) => ({ ...tab, items: tab.items.filter((item) => !isHiddenPath(pathOf(item.href))) }));
}

/** The words of a row: its own, or those of the room its link opens. */
export function menuItemWords(item: MenuItem, t: (key: PlainKey) => string, locale?: UiLocale): { title: string; description: string } {
  if (item.title && item.description) return { title: t(item.title), description: t(item.description) };
  const room = findRoom(pathOf(item.href));
  if (!room) throw new Error(`Menu row ${item.id} opens ${item.href}, which is not a room`);
  return {
    title: item.title ? t(item.title) : roomTitle(room, locale),
    description: item.description ? t(item.description) : roomDescription(room, locale),
  };
}
