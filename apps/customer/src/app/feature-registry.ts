import { hasPattern, matchPath } from './path-match';

/**
 * One row per feature that is still to be confirmed live (UI-SPEC 3.4), with the reason and what unlocks it.
 * Founder order 2026-10-17: nothing in the customer app is hidden. A `blocked` row is reachable and linked from the
 * menus, Home actions, More and search like any other; its own screen shows the honest refusal or empty state, and the
 * reason and unlock here are what `/dev/features` lists. A row becomes `live` only when its screen loads real data on
 * the local stack with no refusal; whoever flips it writes the evidence in the pull request.
 *
 * `hidden` stays as a mechanism (the lookups below, and every `isHiddenPath` consumer, still honour it) but no row uses
 * it, and no build redirects a hidden path any more: a Docker build behaves exactly like `vite dev`.
 */
export type FeatureStatus = 'live' | 'blocked' | 'hidden';
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
  /** The tab the feature belongs to (`tabHome` gives that tab's landing page). */
  tab: FeatureTab;
  /** Evidence for rows that were re-checked on the local stack. */
  checked?: string;
}

// `/pay/checkout` is the payer-facing hosted checkout: it stays public and is not hidden here.
const businessPaySlugs = [
  'refunds',
  'refunds/new',
  'refunds/:refundId',
  'merchant',
  'money',
  'money/activity',
  'links',
  'links/new',
  'links/:linkId',
  'payments',
  'customers',
  'payouts',
  'settlements',
  'disputes',
  'network',
  'permissions',
  'conversion',
  'conversion/new',
  'conversion/:orderId',
  'compliance',
  'settings',
  'settings/profile',
  'settings/team',
  'settings/notifications',
  'invoices',
  'invoices/:invoiceId',
  'subscriptions',
  'subscriptions/new',
  'subscriptions/:subscriptionId',
  'reports',
  'reports/exports',
  'developer',
  'developer/keys',
  'developer/signing',
  'developer/webhooks',
  'developer/webhooks/:endpointId',
  'developer/deliveries',
  'onboarding',
  'onboarding/business',
  'onboarding/verification',
  'onboarding/go-live',
  'team',
  'exports',
  'notifications',
  'approvals',
  'pricing',
  'limits',
  'payouts/new',
  'payouts/destinations',
  'analytics',
  'analytics/fees',
  'settings/security',
  'activity',
  'invoices/new',
  'developer/sandbox',
  'developer/docs',
  'network/:childId',
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
    status: 'blocked',
    reason: 'Custody is not connected',
    unlock: 'deposit address endpoint (U10) + custody',
    tab: 'money',
  },
  {
    id: 'withdraw',
    label: 'Withdraw',
    paths: ['/uc/withdraw', '/uc/withdraw/address'],
    status: 'blocked',
    reason: 'Custody withdrawal is not connected',
    unlock: 'custody contract',
    tab: 'money',
  },
  {
    id: 'repeat-buy',
    label: 'Repeat buy',
    paths: ['/portfolio/:asset/repeat-buy'],
    status: 'blocked',
    reason: 'Scheduled transfers are off locally',
    unlock: 'scheduler flag + review',
    tab: 'money',
  },
  {
    id: 'bank',
    label: 'Bank',
    paths: [
      '/bank',
      '/bank/spaces',
      '/bank/transfers',
      '/bank/earn',
      '/bank/loans',
      '/bank/cards',
      '/bank/ramps',
      '/bank/analytics',
      '/bank/business',
    ],
    status: 'blocked',
    reason:
      'Every room is reachable and wired to the bank service; each room is confirmed live only after its own proof run (ramps need a provider, cards need an issuer, earn and loan products are set by operators)',
    unlock: 'split this row per room, or flip it to live once all nine rooms pass a proof run, with the evidence',
    tab: 'money',
  },
  {
    id: 'margin-futures-options',
    label: 'Options',
    paths: ['/trade/options'],
    status: 'blocked',
    reason: 'Contracts or flags not live',
    unlock: 'per contract',
    tab: 'trade',
  },
  {
    id: 'copy',
    label: 'Copy trading',
    paths: ['/trade/copy'],
    status: 'blocked',
    reason:
      'The leader fee share and the list of countries where copy trading is allowed are not approved, so the service refuses every new follow',
    unlock: 'Approval of the leader fee share and of the country list',
    tab: 'trade',
  },
  {
    id: 'bots',
    label: 'Bots',
    paths: ['/trade/bots'],
    status: 'live',
    reason: 'Catalogue, set-up and controls load real data through svc-trade',
    unlock: 'already live',
    tab: 'trade',
    checked:
      '2026-10-17, local stack as the TEST account: every bot room and action walked to a result or a typed refusal (TRCOPY receipt).',
  },
  {
    id: 'execution-quote',
    label: 'Execution, Quote desk',
    paths: ['/execution', '/otc', '/otc/*'],
    status: 'blocked',
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
    status: 'blocked',
    reason: 'No paper market is published',
    unlock: 'publish a paper market',
    tab: 'trade',
  },
  {
    id: 'request-bills-global',
    label: 'Request, Bill pay, Send globally',
    paths: ['/pay/request', '/pay/bills', '/pay/global'],
    status: 'blocked',
    reason: 'Request makes payment links on this device; Bill pay has no biller service and Send globally has no cross-border service',
    unlock: 'per service',
    tab: 'pay',
  },
  {
    id: 'personal-pay-rooms',
    label: 'Personal Pay: payment record, contacts, scan, scheduled, cases, limits, fees and preferences',
    paths: [
      '/pay/request/:requestId',
      '/pay/scheduled',
      '/pay/contacts',
      '/pay/contacts/groups/:groupId',
      '/pay/contacts/pools/:poolId',
      '/pay/history/:transferId',
      '/pay/claim/:token',
      '/pay/cases',
      '/pay/cases/:caseId',
      '/pay/send/limits',
      '/pay/fees',
      '/pay/preferences',
      '/pay/scan',
      '/pay/l/:linkId',
      '/pay/bills/invoices/:invoiceId',
    ],
    status: 'blocked',
    reason:
      'Contacts, payment records and requests read this device only; scheduled, claim, cases, limits, fees, preferences, links, invoices, groups and pools have no service or owner setting',
    unlock: 'per room',
    tab: 'pay',
  },
  {
    id: 'p2p',
    label: 'Person-to-person',
    paths: ['/p2p', '/ctc', '/uc/ad', '/uc/ad/*', '/uc/order', '/p2p/orders', '/p2p/orders/*', '/chat', '/checkuser'],
    status: 'blocked',
    reason: "Needs owner's instrument encryption provider",
    unlock: 'owner',
    tab: 'pay',
  },
  {
    id: 'business-pay',
    label: 'Business Pay and business account',
    paths: [...businessPaySlugs.map((slug) => `/pay/${slug}`), '/identbusiness'],
    status: 'live',
    reason: 'The rooms open from the signed-in session: business access comes from merchant.myAccess, with no separate provider',
    unlock: 'already live',
    tab: 'pay',
    checked:
      '2026-10-17, stand-in backend (apps/customer/src/features/pay/portal/mock/): every /pay room opens for an owner and shows "No business account yet" with Start setup for a person with none; pay-routes.test.tsx pins both. Not yet run against a real svc-pay.',
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
      '/predict/positions',
      '/predict/:marketId',
      '/market/purchases',
      '/market/:listingId',
      '/launch/new',
      '/launch/check',
      '/launch/requirements',
      '/launch/:projectId',
      '/mining',
      '/mining/workers',
      '/mining/shares',
      '/mining/rewards',
      '/mining/status',
      '/mining/workers/:workerId',
      '/token',
      '/token/governance',
      '/token/economy',
      '/token/governance/:proposalId',
      '/blueprint',
      '/blueprint/crew',
      '/blueprint/shared/:cardId',
      '/campaigns',
      '/uc/innovation/myorders',
    ],
    status: 'blocked',
    reason: 'Not a first-release customer path, or service/data not ready',
    unlock: 'per feature',
    tab: 'more',
  },
  {
    id: 'promotions-dividends',
    label: 'Promotions, Invitations, Dividends',
    paths: ['/uc/promotion', '/uc/promotion/mycards', '/uc/promotion/mypromotion', '/uc/invitingmining', '/uc/paydividends'],
    status: 'blocked',
    reason: 'Not redesigned / no contract',
    unlock: 'redesign later',
    tab: 'person',
  },
  {
    id: 'strategy-subaccounts',
    label: 'Strategy subaccounts (section of Account)',
    paths: [],
    status: 'blocked',
    reason: 'Not a first-release customer path',
    unlock: 'Copy trading and bots go live',
    tab: 'person',
  },
  {
    id: 'public-extras',
    label: 'Notices, Lab, App, Partner',
    paths: ['/notice', '/notice/:id', '/announcement', '/announcement/:id', '/lab', '/lab/detail/:id', '/bzb', '/app', '/partner'],
    status: 'blocked',
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
/** The landing page of a feature's tab. */
export function tabHome(feature: Feature): string {
  return tabHomes[feature.tab];
}

/** Dev builds (`vite dev`, or a `VITE_LOCAL_TEST` bundle) show the blocker ribbon and `/dev/features`; they open the same screens as every other build. */
export function isDevBuild(): boolean {
  return Boolean(import.meta.env.DEV) || import.meta.env.VITE_LOCAL_TEST === '1';
}
