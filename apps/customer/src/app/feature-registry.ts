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
  'products',
  'products/new',
  'products/import',
  'settings/stores',
  'products/:productId',
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
    paths: ['/uc/withdraw', '/uc/withdraw/address', '/uc/withdraw/approvals', '/uc/withdraw/allowlist', '/approveAddress'],
    status: 'blocked',
    reason: 'Custody withdrawal is not connected',
    unlock: 'custody contract',
    tab: 'money',
  },
  {
    id: 'supported-assets',
    label: 'Supported assets',
    paths: ['/uc/assets'],
    status: 'blocked',
    reason: 'svc-ledger’s asset registry through svc-bank; unproven on main',
    unlock: 'J-wallet-01 #5 green in the Real-app journeys run on main',
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
  // Bank, one row per room (split 2026-10-23). A room is live once a Real-app journey proves it on the local stack;
  // the others stay blocked with the blocker their screen names.
  {
    id: 'bank-overview',
    label: 'Bank overview',
    paths: ['/bank'],
    status: 'live',
    reason: 'Terms, currencies, the profile in view and the room list load from svc-bank; account details name rail.bank in place',
    unlock: 'already live',
    tab: 'money',
    checked:
      'Real-app journeys run 39886483027 on main at dc30da1 (2026-10-23): J-bank-01 #1, #2, #3, #6 and #7 pass as a new TEST account (overview, terms, add and remove a currency, account details refusing with rail.bank, profile switch).',
  },
  {
    id: 'bank-spaces',
    label: 'Spaces',
    paths: ['/bank/spaces'],
    status: 'live',
    reason: 'Spaces list, create and the owner limit load from svc-bank',
    unlock: 'already live',
    tab: 'money',
    checked:
      'Real-app journeys run 39886483027 on main at dc30da1 (2026-10-23): J-bank-01 #4 creates a space and is refused at the TEST limit of 5.',
  },
  {
    id: 'bank-recovery-claim',
    label: 'Recovery claim',
    paths: ['/bank/recovery'],
    status: 'blocked',
    reason:
      'A named heir claims a dead owner’s free balances with the owner’s recovery keys once two staff confirm the death notice (RC-identity-08). Its journey step has not passed on main',
    unlock: 'J-identity-05 #7 (RC-identity-08) passing in the Real-app journeys run on main',
    tab: 'money',
  },
  {
    id: 'bank-direct-debits',
    label: 'Direct debits',
    paths: ['/bank/direct-debits'],
    status: 'blocked',
    reason: 'No direct debit scheme is connected (rail.bank); the scheme, failure fees and guarantee periods are owner decisions',
    unlock: 'an owner-chosen scheme, then J-bank-06 #4 passing against it',
    tab: 'money',
  },
  {
    id: 'bank-rules',
    label: 'Rules and notifications',
    paths: ['/bank/rules'],
    status: 'blocked',
    reason:
      'Rules that move money by themselves wait for owner-published terms (bank.rule_terms_unset). Reminders and failure notices reach the inbox through the notification service',
    unlock: 'J-bank-06 #6 passing on main',
    tab: 'money',
  },
  {
    id: 'bank-loan-apply',
    label: 'Apply for a loan',
    paths: ['/bank/loans/apply'],
    status: 'blocked',
    reason:
      'Rate tiers, the origination fee table and rules by jurisdiction are owner values: an unset fee refuses bank.loan_fee_unset and the page says not set; a published non-zero fee refuses bank.loan_fee_unwired',
    unlock: 'J-bank-09 #1 to #5 passing on main',
    tab: 'money',
  },
  {
    id: 'bank-loan-detail',
    label: 'Loan details',
    paths: ['/bank/loans/detail'],
    status: 'blocked',
    reason:
      "The payoff fee and how long a quote holds are owner values: unset, the quote refuses bank.loan_fee_unset or bank.loan_payoff_window_unset. The projection and statement are the bank's own reads",
    unlock: 'J-bank-11 #1 and #6 passing on main',
    tab: 'money',
  },
  {
    id: 'bank-statements',
    label: 'Statements and exports',
    paths: ['/bank/statements'],
    status: 'blocked',
    reason:
      'Statements, ledgers and trades are signed by svc-bank; a balance snapshot at a past date refuses bank.statement_balances_unavailable until the ledger offers a past-balance read, and background export jobs are not built',
    unlock: 'J-portfolio-11 passing on main',
    tab: 'money',
  },
  {
    id: 'bank-calendar',
    label: 'Money calendar',
    paths: ['/bank/calendar'],
    status: 'blocked',
    reason:
      'Loan products publish no repayment dates and no bill payment partner is connected, so those kinds show their reason instead of dates',
    unlock: 'published loan repayment dates and a bill partner, then J-bank-06 #5 passing with every kind dated',
    tab: 'money',
  },
  {
    id: 'bank-transfers',
    label: 'Bank transfers',
    paths: ['/bank/transfers'],
    status: 'live',
    reason: 'Moves between the person’s own spaces post through svc-bank and the ledger',
    unlock: 'already live',
    tab: 'money',
    checked:
      'Real-app journeys run 39886483027 on main at dc30da1 (2026-10-23): J-bank-01 #5 moves TEST 20 USDT from the main balance into a space, and a locked source is refused before any request.',
  },
  {
    id: 'bank-earn',
    label: 'Earn',
    paths: ['/bank/earn', '/bank/earn/pool'],
    status: 'blocked',
    reason: 'Earn products and rates are set by operators, and daily interest is switched off on the local stack',
    unlock: 'operator earn products and rates, then a proof run of this room',
    tab: 'money',
  },
  {
    id: 'bank-loans',
    label: 'Loans',
    paths: ['/bank/loans'],
    status: 'blocked',
    reason: 'Loan terms are set by operators, and loan accrual and the risk sweep are switched off on the local stack',
    unlock: 'operator loan terms, then a proof run of this room',
    tab: 'money',
  },
  {
    id: 'bank-cards',
    label: 'Cards',
    paths: ['/bank/cards'],
    status: 'blocked',
    reason: 'No card issuer is connected (bank.no_card_issuer)',
    unlock: 'a card issuer, then a proof run of this room',
    tab: 'money',
  },
  {
    id: 'bank-ramps',
    label: 'Add money and cash out',
    paths: ['/bank/ramps', '/bank/ramps/new', '/bank/ramps/accounts', '/bank/ramps/cash-out'],
    status: 'blocked',
    reason:
      'No payment partner is connected (rail.bank, rail.card), so no linked bank account can be verified; J-bank-02 proves only the refused ending',
    unlock: 'a payment partner, then J-bank-02 and J-bank-03 passing with money credited and paid out',
    tab: 'money',
  },
  {
    id: 'bank-analytics',
    label: 'Bank analytics',
    paths: ['/bank/analytics'],
    status: 'blocked',
    reason: 'No Real-app journey proves this room',
    unlock: 'a proof run of this room, with the evidence',
    tab: 'money',
  },
  {
    id: 'bank-business',
    label: 'Business banking',
    paths: ['/bank/business'],
    status: 'blocked',
    reason: 'No Real-app journey proves this room; a business has no account of its own in this build (bank.company_account_unwired)',
    unlock: 'a proof run of this room, with the evidence',
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
    reason:
      'Request makes payment links on this device and has no service behind it; Bill pay has no biller network and Send globally has no live rate, so both show their steps with the controls off',
    unlock: 'the request service (PP-send-request-12), the bills rail (PP-send-request-19) and the cross-border rail (PP-send-request-21)',
    tab: 'pay',
  },
  {
    id: 'pay-request-detail',
    label: 'Request detail and payment link',
    paths: ['/pay/request/:requestId', '/pay/l/:linkId'],
    status: 'blocked',
    reason:
      'A request made on this device shows its details; no service tracks it, so it cannot be paid, rejected or expire, and a link from someone else names no payee the app can read',
    unlock: 'the request service (PP-send-request-12)',
    tab: 'pay',
  },
  {
    id: 'pay-scheduled-preferences',
    label: 'Scheduled payments and Pay preferences',
    paths: ['/pay/scheduled', '/pay/preferences'],
    status: 'blocked',
    reason: 'No service stores a scheduled payment or a pay preference, so the controls are off',
    unlock: 'funding and scheduling preferences (PP-send-request-06)',
    tab: 'pay',
  },
  {
    id: 'pay-contacts',
    label: 'Contacts, groups and pools',
    paths: ['/pay/contacts', '/pay/contacts/groups/:groupId', '/pay/contacts/pools/:poolId'],
    status: 'blocked',
    reason: 'People paid from this device are listed; saved contacts, groups and pools are not stored by any service',
    unlock: 'contacts, groups and pools (PP-send-request-04 and PP-send-request-15)',
    tab: 'pay',
  },
  {
    id: 'pay-payment-detail',
    label: 'Payment detail',
    paths: ['/pay/history/:transferId'],
    status: 'blocked',
    reason: 'A payment in the latest activity shows its details and receipt; reporting a problem is not connected',
    unlock: 'the case desk (PP-disputes-safety-22)',
    tab: 'pay',
  },
  {
    id: 'pay-claim',
    label: 'Claim a payment',
    paths: ['/pay/claim/:token'],
    status: 'blocked',
    reason: 'Sending to someone without an account is not connected, so nothing can be claimed',
    unlock: 'unclaimed sends (PP-send-request-08)',
    tab: 'pay',
  },
  {
    id: 'pay-cases',
    label: 'Payment cases',
    paths: ['/pay/cases', '/pay/cases/:caseId'],
    status: 'blocked',
    reason: 'The case desk is not connected, so a case cannot be opened or read',
    unlock: 'the case desk (PP-disputes-safety-22)',
    tab: 'pay',
  },
  {
    id: 'pay-terms',
    label: 'Send limits and fees',
    paths: ['/pay/send/limits', '/pay/fees'],
    status: 'blocked',
    reason: 'No send limit or fee is published, so none is shown',
    unlock: 'published personal transfer terms (PP-send-request-07)',
    tab: 'pay',
  },
  {
    id: 'pay-scan',
    label: 'Scan to pay',
    paths: ['/pay/scan'],
    status: 'blocked',
    reason: "Scan to pay reads a person's pay code from the camera or an image and opens Send; shop and in-store codes are not read",
    unlock: 'shop and in-store codes, then a proof run of this room (PP-send-request-11)',
    tab: 'pay',
  },
  {
    id: 'pay-bill-detail',
    label: 'Bill detail',
    paths: ['/pay/bills/invoices/:invoiceId'],
    status: 'blocked',
    reason: 'There is no biller network, so a bill cannot be read or paid',
    unlock: 'the bills rail (PP-send-request-19)',
    tab: 'pay',
  },
  {
    id: 'oauth-apps',
    label: 'Registered apps and app sign-in',
    paths: ['/developers/apps', '/oauth/authorize'],
    status: 'blocked',
    reason:
      'oauth.lifetime_unset: the owner has not published the authorisation code and access token lifetimes, no service accepts an issued token, and the operator approval queue is not in the admin app',
    unlock:
      'publish OAUTH_CODE_TTL_SECONDS and OAUTH_ACCESS_TOKEN_TTL_SECONDS, add the token check to the services and the approval queue to admin',
    tab: 'person',
  },
  {
    id: 'developer-portal',
    label: 'Developer portal',
    paths: ['/developers', '/developers/*'],
    status: 'blocked',
    reason:
      'developer.hosts: no read for the owner host settings is connected, so every base address reads host not set; most section pages are not written',
    unlock: 'add the developer.hosts read in the payments settings and publish the section pages',
    tab: 'public',
  },
  {
    id: 'trade-news-calendar',
    label: 'News and economic calendar',
    paths: ['/trade/news', '/trade/calendar'],
    status: 'blocked',
    reason: 'feed.news: no news data feed is connected and no content store is mounted',
    unlock: 'connect a news data vendor and mount the content store',
    tab: 'trade',
  },
  {
    id: 'p2p',
    label: 'Person-to-person',
    paths: [
      '/p2p',
      '/ctc',
      '/uc/ad',
      '/uc/ad/*',
      '/uc/order',
      '/p2p/orders',
      '/p2p/orders/*',
      '/p2p/access',
      '/p2p/methods',
      '/chat',
      '/checkuser',
    ],
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
      '2026-10-22, real svc-pay on the local stack (apps/customer/tests/real-app/J-merchant-01.pw.mjs and, since 2026-10-29, the room walk in J-merchant-01-team.pw.mjs): a person with no business is led to setup, and the owner of a business whose verification has not started opens every /pay room from navigation with no refused read.',
  },
  {
    id: 'more-rooms',
    label: 'Academy, Agents, Quant, Launch, Market, Prediction, Mining, Token, Blueprint, Campaigns',
    paths: [
      '/academy',
      '/academy/learning',
      '/academy/certificates',
      '/academy/rooms',
      '/academy/videos',
      '/academy/programmes',
      '/academy/progress',
      '/academy/learning/course/:slug',
      '/academy/learning/course/:slug/assignment/:itemId',
      '/academy/:slug',
      '/agents',
      '/agents/team',
      '/agents/new',
      '/agents/:agentId',
      '/quant',
      '/quant/sandbox',
      '/quant/strategies',
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
      '/token/burn',
      '/token/governance/:proposalId',
      '/blueprint',
      '/blueprint/crew',
      '/blueprint/shared/:cardId',
      '/predict/*',
      '/market/*',
      '/launch/*',
      '/token/*',
      '/mining/*',
      '/blueprint/*',
      '/campaigns',
      '/campaigns/drops',
      '/campaigns/mine',
      '/campaigns/:campaignId',
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
    reason: 'No service behind them; what the Lab holds is an owner decision',
    unlock: 'per feature; the Lab when the owner records what it holds',
    tab: 'public',
  },
  {
    id: 'help-support',
    label: 'Help and Support',
    paths: [
      '/help',
      '/helplist',
      '/helpdetail',
      '/help/category/:id',
      '/help/section/:id',
      '/support',
      '/support/new',
      '/support/tickets',
      '/support/tickets/:ticketId',
    ],
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
