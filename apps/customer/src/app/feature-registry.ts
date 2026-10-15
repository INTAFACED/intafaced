import { hasPattern, matchPath } from './path-match';

/**
 * One row per feature that is hidden from customers or still to be confirmed live
 * (UI-SPEC 3.4). The top-bar menus, Home actions, More and search read this file, and
 * nothing hidden is linked anywhere. A row becomes `live` only when its screen loads
 * real data on the local stack with no refusal; whoever flips it writes the evidence
 * in the pull request.
 */
export type FeatureStatus = 'live' | 'hidden';
export type FeatureTab = 'home' | 'money' | 'trade' | 'pay' | 'more' | 'person' | 'public';

export interface Feature {
  id: string;
  label: string;
  /** Route patterns (`:param`, trailing `*`). Empty for a section or a switch with no route of its own. */
  paths: readonly string[];
  /** Query strings that are also hidden, as `name=value`. */
  queries?: readonly string[];
  status: FeatureStatus;
  /** Shown in the dev ribbon, so it names the cause in plain words. */
  reason: string;
  unlock: string;
  /** Where a customer lands when they open a hidden path. */
  tab: FeatureTab;
  /** Evidence for rows that were re-checked on the local stack. */
  checked?: string;
}

// `/pay/checkout` is the payer-facing hosted checkout: it stays public and is not hidden here.
const businessPaySlugs = [
  'merchant',
  'money',
  'links',
  'payments',
  'customers',
  'payouts',
  'settlements',
  'disputes',
  'network',
  'permissions',
  'invoices',
  'subscriptions',
  'reports',
  'developer',
  'onboarding',
  'team',
  'exports',
  'notifications',
  'approvals',
  'pricing',
  'limits',
  'disputes/:disputeId',
  'customers/:customerRef',
  'payments/:paymentId',
  'settlements/:settlementId',
  'payouts/:payoutId',
] as const;

export const features: readonly Feature[] = [
  {
    id: 'deposit',
    label: 'Deposit',
    paths: ['/uc/recharge'],
    status: 'hidden',
    reason: 'Custody is not connected',
    unlock: 'deposit address endpoint (U10) + custody',
    tab: 'money',
  },
  {
    id: 'withdraw',
    label: 'Withdraw',
    paths: ['/uc/withdraw', '/uc/withdraw/address'],
    status: 'hidden',
    reason: 'Custody withdrawal is not connected',
    unlock: 'custody contract',
    tab: 'money',
  },
  {
    id: 'repeat-buy',
    label: 'Repeat buy',
    paths: ['/portfolio/:asset/repeat-buy'],
    status: 'hidden',
    reason: 'Scheduled transfers are off locally',
    unlock: 'scheduler flag + review',
    tab: 'money',
  },
  {
    id: 'bank',
    label: 'Bank',
    paths: [
      '/bank/spaces',
      '/bank/transfers',
      '/bank/earn',
      '/bank/loans',
      '/bank/cards',
      '/bank/ramps',
      '/bank/analytics',
      '/bank/business',
    ],
    status: 'hidden',
    reason: 'Not part of the new Money tab; earn rate, loans, cards, ramps not set up',
    unlock: 'product decision per feature',
    tab: 'money',
  },
  {
    id: 'margin-futures-options',
    label: 'Margin, Futures, Options',
    paths: ['/trade/margin', '/trade/futures', '/trade/options'],
    status: 'hidden',
    reason: 'Contracts or flags not live',
    unlock: 'per contract',
    tab: 'trade',
  },
  {
    id: 'copy-bots-execution-quote',
    label: 'Copy, Bots, Execution, Quote desk',
    paths: ['/trade/copy', '/trade/bots', '/execution', '/otc', '/otc/*'],
    status: 'hidden',
    reason: 'Not a first-release customer path',
    unlock: 'per contract',
    tab: 'trade',
  },
  {
    id: 'buy-flow',
    label: 'Buy and sell (instant)',
    paths: ['/trade/buy'],
    status: 'live',
    reason: 'M2 Buy card (B8) places a market order on the live USDT/USDC market through svc-trade',
    unlock: 'already live',
    tab: 'trade',
    checked:
      '2026-10-14, local stack as test_friend: bought $10 of BTC (0.00015 BTC filled through the ledger); Opus money review PASS at 48826285c.',
  },
  {
    id: 'convert-flow',
    label: 'Convert',
    paths: ['/trade/convert'],
    status: 'live',
    reason: 'M2 Convert card (B8) quotes and settles through svc-trade convert',
    unlock: 'already live',
    tab: 'trade',
    checked: '2026-10-14, local stack as test_friend: converted 10 USDT to 0.0038 ETH; Opus money review PASS at 48826285c.',
  },
  {
    id: 'coin-page',
    label: 'Coin page',
    paths: ['/coin/:asset', '/portfolio/:asset'],
    status: 'live',
    reason: 'M3 coin page (B13) reads the ticker, candles, balance and fills',
    unlock: 'already live',
    tab: 'trade',
    checked: '2026-10-14, local stack as test_friend: Home coin card to /coin/BTC, price, chart, ranges and Buy card.',
  },
  {
    id: 'simulated-markets',
    label: 'Simulated markets',
    paths: [],
    queries: ['simulated=true'],
    status: 'hidden',
    reason: 'No paper market is published',
    unlock: 'publish a paper market',
    tab: 'trade',
  },
  {
    id: 'request-bills-global',
    label: 'Request, Bill pay, Send globally',
    paths: ['/pay/request', '/pay/bills', '/pay/global'],
    status: 'hidden',
    reason: 'No contract',
    unlock: 'per contract',
    tab: 'pay',
  },
  {
    id: 'p2p',
    label: 'Person-to-person',
    paths: ['/p2p', '/ctc', '/uc/ad', '/uc/ad/*', '/uc/order', '/chat', '/checkuser'],
    status: 'hidden',
    reason: "Needs owner's instrument encryption provider",
    unlock: 'owner',
    tab: 'pay',
  },
  {
    id: 'business-pay',
    label: 'Business Pay and business account',
    paths: [...businessPaySlugs.map((slug) => `/pay/${slug}`), '/identbusiness'],
    status: 'hidden',
    reason: 'No verified business account contract',
    unlock: 'contract',
    tab: 'pay',
  },
  {
    id: 'more-rooms',
    label: 'Academy, Agents, Quant, Launch, Market, Prediction, Mining, Token, Blueprint, Campaigns',
    paths: [
      '/academy',
      '/academy/:slug',
      '/agents',
      '/quant',
      '/quant/studio',
      '/quant/backtest',
      '/launch',
      '/market',
      '/market/mine',
      '/market/strategy',
      '/predict',
      '/mining',
      '/token',
      '/blueprint',
      '/campaigns',
      '/uc/innovation/myorders',
    ],
    status: 'hidden',
    reason: 'Not a first-release customer path, or service/data not ready',
    unlock: 'per feature',
    tab: 'more',
  },
  {
    id: 'promotions-dividends',
    label: 'Promotions, Invitations, Dividends',
    paths: ['/uc/promotion', '/uc/promotion/mycards', '/uc/promotion/mypromotion', '/uc/invitingmining', '/uc/paydividends'],
    status: 'hidden',
    reason: 'Not redesigned / no contract',
    unlock: 'redesign later',
    tab: 'person',
  },
  {
    id: 'strategy-subaccounts',
    label: 'Strategy subaccounts (section of Account)',
    paths: [],
    status: 'hidden',
    reason: 'Not a first-release customer path',
    unlock: 'Copy trading and bots go live',
    tab: 'person',
  },
  {
    id: 'public-extras',
    label: 'Notices, Lab, App, Partner',
    paths: ['/notice', '/notice/:id', '/announcement', '/announcement/:id', '/lab', '/lab/detail/:id', '/bzb', '/app', '/partner'],
    status: 'hidden',
    reason: 'No service behind them',
    unlock: 'per feature',
    tab: 'public',
  },
  {
    id: 'help-support',
    label: 'Help and Support',
    paths: ['/help', '/helplist', '/helpdetail', '/support'],
    status: 'live',
    reason: 'svc-support answers on the local stack',
    unlock: 'already live',
    tab: 'more',
    checked:
      '2026-10-13, local stack edge 127.0.0.1:14500 as test_friend: support.searchKb 200 with seeded articles (also 200 signed out), support.listMine 200 (empty list).',
  },
  {
    id: 'notifications',
    label: 'Notifications',
    paths: ['/notifications'],
    status: 'live',
    reason: 'svc-notify answers on the local stack',
    unlock: 'already live',
    tab: 'person',
    checked:
      '2026-10-13, local stack edge 127.0.0.1:14500 as test_friend: notify.list 200 with a real notification, notify.channels 200, notify.mutePrefs 200, notify.targets 200 (empty).',
  },
  {
    id: 'passkeys',
    label: 'Passkeys (section of Security)',
    paths: [],
    status: 'live',
    reason: 'WebAuthn is on in the local stack (relying party localhost)',
    unlock: 'already live',
    tab: 'person',
    checked:
      '2026-10-14, local stack: svc-identity runs WEBAUTHN_ENABLED=true with relying-party ID localhost (tooling/scripts/local-test-stack.mjs), open the app on http://localhost:3210; the founder tests the Touch ID enrolment there.',
  },
  {
    id: 'pro-mode-switch',
    label: 'Simple / Pro switch',
    paths: [],
    status: 'live',
    reason: 'Pro screens landed in M2',
    unlock: 'already live',
    tab: 'home',
  },
];

export function featureById(id: string): Feature | undefined {
  return features.find((feature) => feature.id === id);
}
export function isFeatureLive(id: string): boolean {
  return featureById(id)?.status === 'live';
}

function patternMatches(pattern: string, path: string): boolean {
  return pattern === path || (hasPattern(pattern) && matchPath(pattern, path) !== undefined);
}

/** The hidden feature that owns `path` (and `search`, for hidden query strings), if any. */
export function hiddenFeatureFor(path: string, search = ''): Feature | undefined {
  const query = new URLSearchParams(search);
  return features.find(
    (feature) =>
      feature.status === 'hidden' &&
      (feature.paths.some((pattern) => patternMatches(pattern, path)) ||
        (feature.queries ?? []).some((pair) => {
          const [name = '', value = ''] = pair.split('=');
          return query.get(name) === value;
        })),
  );
}
export function isHiddenPath(path: string): boolean {
  return hiddenFeatureFor(path) !== undefined;
}

const tabHomes: Record<FeatureTab, string> = {
  home: '/home',
  money: '/money',
  trade: '/trade',
  pay: '/pay',
  more: '/more',
  person: '/more',
  public: '/',
};
/** Customer builds send a hidden path to its tab home. */
export function tabHome(feature: Feature): string {
  return tabHomes[feature.tab];
}

/** Dev builds (`vite dev`, or the local test stack build) still open hidden screens, under a ribbon. */
export function isDevBuild(): boolean {
  return Boolean(import.meta.env.DEV) || import.meta.env.VITE_LOCAL_TEST === '1';
}
