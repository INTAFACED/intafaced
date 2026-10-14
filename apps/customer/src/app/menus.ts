import type { Door } from './navigation';
import { defaultDeskPair, tradeTabHref } from './navigation';
import { isHiddenPath, isPreviewEnabled } from './feature-registry';
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
  | 'Deposit'
  | 'Add funds to your account'
  | 'Withdraw'
  | 'Send funds to your own wallet'
  | 'Earn'
  | 'Put idle funds to work'
  | 'Loans'
  | 'Borrow against your assets'
  | 'Margin'
  | 'Trade with borrowed funds'
  | 'Futures'
  | 'Perpetual and dated contracts'
  | 'Options'
  | 'Calls, puts and strikes'
  | 'Copy trading'
  | 'Follow a trader you pick'
  | 'Trading bots'
  | 'Automated grid and DCA strategies'
  | 'Agents'
  | 'Assistants that suggest, you approve'
  | 'P2P'
  | 'Trade directly with other people'
  | 'Card'
  | 'Spend your balance anywhere'
  | 'IFC'
  | 'Academy'
  | 'Lessons and certifications'
  | 'Staking tiers and fee discounts';
export interface MenuItem {
  id: string;
  href: string;
  icon: ShellIconName;
  title: PlainKey;
  description: PlainKey;
  /** A Preview product (feature-registry `preview` row): the menu draws the Preview chip. Kept only while the build shows Preview. */
  preview?: true;
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
export function tabSpecs(layoutMode: 'simple' | 'pro', signedIn = true, previewEnabled: boolean = isPreviewEnabled()): TabSpec[] {
  const all: TabSpec[] = [
    { door: 'Home', href: '/home', icon: 'home', items: [] },
    {
      door: 'Money',
      href: '/money',
      icon: 'wallet',
      items: [
        { id: 'portfolio', href: '/money', icon: 'wallet', title: 'Portfolio', description: 'Your assets and their value' },
        { id: 'activity', href: '/money/activity', icon: 'activity', title: 'Activity', description: 'Trades, orders and transfers' },
        {
          id: 'deposit',
          href: '/preview/deposit',
          icon: 'receive',
          title: 'Deposit',
          description: 'Add funds to your account',
          preview: true,
        },
        {
          id: 'withdraw',
          href: '/preview/withdraw',
          icon: 'send',
          title: 'Withdraw',
          description: 'Send funds to your own wallet',
          preview: true,
        },
        { id: 'earn', href: '/preview/earn', icon: 'earn', title: 'Earn', description: 'Put idle funds to work', preview: true },
        { id: 'loans', href: '/preview/loans', icon: 'loans', title: 'Loans', description: 'Borrow against your assets', preview: true },
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
        { id: 'margin', href: '/preview/margin', icon: 'margin', title: 'Margin', description: 'Trade with borrowed funds', preview: true },
        {
          id: 'futures',
          href: '/preview/futures',
          icon: 'futures',
          title: 'Futures',
          description: 'Perpetual and dated contracts',
          preview: true,
        },
        {
          id: 'options',
          href: '/preview/options',
          icon: 'options',
          title: 'Options',
          description: 'Calls, puts and strikes',
          preview: true,
        },
        { id: 'copy', href: '/preview/copy', icon: 'copy', title: 'Copy trading', description: 'Follow a trader you pick', preview: true },
        {
          id: 'bots',
          href: '/preview/bots',
          icon: 'bots',
          title: 'Trading bots',
          description: 'Automated grid and DCA strategies',
          preview: true,
        },
        {
          id: 'agents',
          href: '/preview/agents',
          icon: 'agents',
          title: 'Agents',
          description: 'Assistants that suggest, you approve',
          preview: true,
        },
        { id: 'p2p', href: '/preview/p2p', icon: 'p2p', title: 'P2P', description: 'Trade directly with other people', preview: true },
      ],
    },
    {
      door: 'Pay',
      href: '/pay',
      icon: 'send',
      items: [
        { id: 'send', href: '/pay/send', icon: 'send', title: 'Send', description: 'Send money to someone on INTAFACED' },
        { id: 'receive', href: '/pay/receive', icon: 'receive', title: 'Receive', description: 'Share your details to get paid' },
        { id: 'card', href: '/preview/card', icon: 'card', title: 'Card', description: 'Spend your balance anywhere', preview: true },
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
            {
              id: 'academy',
              href: '/preview/academy',
              icon: 'academy',
              title: 'Academy',
              description: 'Lessons and certifications',
              preview: true,
            },
            { id: 'ifc', href: '/preview/ifc', icon: 'ifc', title: 'IFC', description: 'Staking tiers and fee discounts', preview: true },
          ]
        : [{ id: 'help', href: '/help', icon: 'help', title: 'Help', description: 'Answers and support' }],
    },
  ];
  return all.map((tab) => ({ ...tab, items: tab.items.filter((item) => !isHiddenPath(pathOf(item.href), previewEnabled)) }));
}

export const accountMenu: ReadonlyArray<{ href: string; title: PlainKey }> = [
  { href: '/uc/account', title: 'Account' },
  { href: '/uc/safe', title: 'Security' },
  { href: '/verification', title: 'Verification' },
  { href: '/view', title: 'Settings' },
];
