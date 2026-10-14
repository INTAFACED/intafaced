import type { Door } from './navigation';
import { defaultDeskPair, tradeTabHref } from './navigation';
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
  | 'Settings'
  | 'Display, language and notifications'
  | 'Account'
  | 'Security'
  | 'Verification'
  | 'API keys'
  | 'Sub-accounts'
  | 'Fees';
export interface MenuItem {
  id: string;
  href: string;
  icon: ShellIconName;
  title: PlainKey;
  description: PlainKey;
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
 * The five top-bar tabs and the dropdown rows under them (UI-SPEC 3.1). A row whose route
 * belongs to a hidden feature is dropped, so a menu only ever lists things that work; a tab
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
        { id: 'activity', href: '/money/activity', icon: 'activity', title: 'Activity', description: 'Trades, orders and transfers' },
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
      ],
    },
    {
      door: 'Pay',
      href: '/pay',
      icon: 'send',
      items: [
        { id: 'send', href: '/pay/send', icon: 'send', title: 'Send', description: 'Send money to someone on INTAFACED' },
        { id: 'receive', href: '/pay/receive', icon: 'receive', title: 'Receive', description: 'Share your details to get paid' },
      ],
    },
    {
      door: 'More',
      href: signedIn ? '/more' : '/help',
      icon: 'grid',
      items: signedIn
        ? [
            { id: 'help', href: '/support', icon: 'help', title: 'Help', description: 'Answers and support' },
            { id: 'settings', href: '/view', icon: 'settings', title: 'Settings', description: 'Display, language and notifications' },
          ]
        : [{ id: 'help', href: '/help', icon: 'help', title: 'Help', description: 'Answers and support' }],
    },
  ];
  return all.map((tab) => ({ ...tab, items: tab.items.filter((item) => !isHiddenPath(pathOf(item.href))) }));
}

export const accountMenu: ReadonlyArray<{ href: string; title: PlainKey }> = [
  { href: '/uc/account', title: 'Account' },
  { href: '/uc/safe', title: 'Security' },
  { href: '/verification', title: 'Verification' },
  { href: '/uc/api', title: 'API keys' },
  { href: '/uc/sub-accounts', title: 'Sub-accounts' },
  { href: '/uc/fees', title: 'Fees' },
  { href: '/view', title: 'Settings' },
];
