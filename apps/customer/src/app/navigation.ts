export type Door = 'Home' | 'Assets' | 'Bank' | 'Trade' | 'Pay' | 'More';
export type Room = {
  path: string;
  title: NavigationCopyKey;
  description: NavigationCopyKey;
  door?: Door;
  area: 'home' | 'money' | 'trade' | 'pay' | 'more' | 'person' | 'public' | 'web3' | 'team';
  business?: boolean;
  /**
   * Redirect target (replace). It may carry a query (`/money/activity?tab=orders`) and the
   * same `:param` names as `path` (`/coin/:asset`); see `resolveAlias`.
   */
  alias?: string;
  /** Not offered in search: a parameter route, or a sign-in step. */
  hidden?: boolean;
  /** Redesigned screen that renders this route; rooms without one render their old view inside `.legacy-room`. */
  screen?: ScreenId;
};

const WEB3_DESCRIPTION = {
  chain: 'Blocks, validators and chain status',
  dex: 'Swap and liquidity',
  protocol: 'Contracts, rails and audit',
  wallet: 'Your wallet and its activity',
} as const;

export const rooms: readonly Room[] = [
  { path: '/', title: 'Home', description: 'Intafaced', area: 'public', hidden: true },
  { path: '/index', title: 'Home', description: 'Intafaced', area: 'public', alias: '/' },
  { path: '/login', title: 'Sign in', description: 'Access your account', area: 'public', hidden: true },
  { path: '/login/returnUrl/:returnUrl', title: 'Sign in', description: 'Return to your room', area: 'public', hidden: true },
  { path: '/register', title: 'Create account', description: 'Your personal account', area: 'public', hidden: true },
  { path: '/reg', title: 'Create account', description: 'Your personal account', area: 'public', alias: '/register' },
  { path: '/findPwd', title: 'Password recovery', description: 'Recover account access', area: 'public', hidden: true },
  { path: '/confirm-email', title: 'Confirm email', description: 'Prove your email address', area: 'public', hidden: true },
  { path: '/help', title: 'Help centre', description: 'Find answers and contact support', area: 'public' },
  { path: '/helplist', title: 'Help centre', description: 'Published help', area: 'public', alias: '/help' },
  { path: '/helpdetail', title: 'Help article', description: 'Published guidance', area: 'public', hidden: true },
  { path: '/status', title: 'Platform status', description: 'Trading mode of each market', area: 'public' },
  { path: '/notice', title: 'Notices', description: 'Product announcements', area: 'public' },
  { path: '/notice/:id', title: 'Notice', description: 'Product announcement', area: 'public', hidden: true },
  { path: '/announcement', title: 'Notices', description: 'Product announcements', area: 'public', alias: '/notice' },
  { path: '/announcement/:id', title: 'Notice', description: 'Product announcement', area: 'public', hidden: true },
  { path: '/about-us', title: 'About Intafaced', description: 'One account, connected experiences', area: 'public' },
  { path: '/invite', title: 'Invite', description: 'Invite someone to Intafaced', area: 'public' },
  { path: '/app', title: 'Get the app', description: 'Mobile availability', area: 'public' },
  { path: '/partner', title: 'Partners', description: 'Work with Intafaced', area: 'public' },
  { path: '/developers', title: 'Developers', description: 'Connect to Intafaced from your own code', area: 'public' },
  { path: '/developers/hosts', title: 'Base addresses', description: 'Hosts per protocol, environment and region', area: 'public' },
  { path: '/developers/status', title: 'Service status', description: 'Components, incidents and maintenance', area: 'public' },
  { path: '/developers/changelog', title: 'Changelog', description: 'What changed in the developer interfaces', area: 'public' },
  {
    path: '/developers/changelog/upcoming',
    title: 'Upcoming breaking changes',
    description: 'Breaking changes and retired endpoints',
    area: 'public',
  },
  {
    path: '/developers/:section',
    title: 'Developer section',
    description: 'One section of the developer portal',
    area: 'public',
    hidden: true,
  },
  { path: '/lab', title: 'Campaigns', description: 'Public activities', area: 'public' },
  { path: '/lab/detail/:id', title: 'Campaign', description: 'Activity details', area: 'public', hidden: true },
  { path: '/bzb', title: 'Campaigns', description: 'Public activities', area: 'public', alias: '/lab' },
  { path: '/home', title: 'Home', description: 'Your money and markets', door: 'Home', area: 'home', screen: 'home' },
  { path: '/money', title: 'Money', description: 'Holdings and available funds', door: 'Assets', area: 'money', screen: 'money' },
  {
    path: '/money/activity',
    title: 'Activity',
    description: 'Trades, orders and transfers',
    door: 'Assets',
    area: 'money',
    screen: 'money',
  },
  {
    path: '/money/pnl',
    title: 'Profit and loss',
    description: 'What your trades have made or lost',
    door: 'Assets',
    area: 'money',
    screen: 'money',
  },
  {
    path: '/money/activity/:id',
    title: 'Activity',
    description: 'Transaction details',
    door: 'Assets',
    area: 'money',
    hidden: true,
    screen: 'money',
  },
  {
    path: '/money/balance/:asset',
    title: 'Activity',
    description: 'Activity details',
    door: 'Assets',
    area: 'money',
    hidden: true,
    screen: 'money',
  },
  {
    path: '/coin/:asset',
    title: 'Coin',
    description: 'Asset details and actions',
    door: 'Trade',
    area: 'money',
    hidden: true,
    screen: 'coin',
  },
  { path: '/portfolio', title: 'Holdings', description: 'Your assets in one ledger', door: 'Assets', area: 'money', alias: '/money' },
  {
    path: '/portfolio/:asset',
    title: 'Holding',
    description: 'Asset details and actions',
    door: 'Assets',
    area: 'money',
    alias: '/coin/:asset',
    hidden: true,
  },
  {
    path: '/portfolio/:asset/repeat-buy',
    title: 'Repeat buy',
    description: 'Scheduled asset purchases',
    door: 'Assets',
    area: 'money',
    hidden: true,
  },
  {
    path: '/money/asset/:asset',
    title: 'Holding',
    description: 'Asset details and actions',
    door: 'Assets',
    area: 'money',
    alias: '/coin/:asset',
    hidden: true,
  },
  { path: '/uc/money', title: 'Money', description: 'Your holdings', door: 'Assets', area: 'money', alias: '/money' },
  { path: '/uc/recharge', title: 'Deposit', description: 'Add funds', door: 'Assets', area: 'money' },
  { path: '/uc/withdraw', title: 'Withdraw', description: 'Withdraw available funds', door: 'Assets', area: 'money' },
  { path: '/uc/withdraw/approvals', title: 'Approvals', description: 'Withdrawals waiting for your team', door: 'Assets', area: 'money' },
  { path: '/uc/withdraw/allowlist', title: 'Address list', description: 'Where withdrawals may go', door: 'Assets', area: 'money' },
  { path: '/uc/withdraw/address', title: 'Addresses', description: 'Withdrawal destinations', door: 'Assets', area: 'money' },
  {
    path: '/uc/record',
    title: 'Activity',
    description: 'Money moving in and out',
    door: 'Assets',
    area: 'money',
    alias: '/money/activity',
  },
  { path: '/bank', title: 'Bank', description: 'The bank behind your balance', door: 'Bank', area: 'money' },
  { path: '/bank/spaces', title: 'Spaces', description: 'Organise funds for your goals', door: 'Bank', area: 'money' },
  { path: '/bank/transfers', title: 'Transfers', description: 'Move funds between your spaces', door: 'Bank', area: 'money' },
  { path: '/bank/earn', title: 'Earn', description: 'Available earning products', door: 'Bank', area: 'money' },
  { path: '/bank/loans', title: 'Loans', description: 'Applications and repayments', door: 'Bank', area: 'money' },
  { path: '/bank/cards', title: 'Cards', description: 'Card issuer availability and controls', door: 'Bank', area: 'money' },
  { path: '/bank/ramps', title: 'Cash and crypto', description: 'Onramps and offramps', door: 'Bank', area: 'money' },
  { path: '/bank/ramps/new', title: 'Add money', description: 'Pay in by bank transfer, bank or card', door: 'Bank', area: 'money' },
  { path: '/bank/analytics', title: 'Spending', description: 'Understand your activity', door: 'Bank', area: 'money' },
  {
    path: '/bank/business',
    title: 'Business approvals',
    description: 'Approval rules on your accounts',
    door: 'Bank',
    area: 'money',
    business: true,
  },
  { path: '/trade', title: 'Markets', description: 'Prices for every market', door: 'Trade', area: 'trade', screen: 'trade/markets' },
  { path: '/exchange', title: 'Trade', description: 'Spot trading terminal', door: 'Trade', area: 'trade', alias: '/trade' },
  {
    path: '/trade/spot/:pair',
    title: 'Trade',
    description: 'Linked chart, book and order ticket',
    door: 'Trade',
    area: 'trade',
    hidden: true,
    screen: 'trade/desk',
  },
  {
    path: '/exchange/:pair',
    title: 'Trade',
    description: 'Linked chart, book and order ticket',
    door: 'Trade',
    area: 'trade',
    alias: '/trade/spot/:pair',
    hidden: true,
  },
  {
    path: '/charts',
    title: 'Charts',
    description: 'Linked charts for one market',
    door: 'Trade',
    area: 'trade',
    screen: 'charts',
  },
  {
    path: '/charts/:symbol',
    title: 'Charts',
    description: 'Linked charts for one market',
    door: 'Trade',
    area: 'trade',
    hidden: true,
    screen: 'charts',
  },
  {
    path: '/trade/buy',
    title: 'Buy and sell',
    description: 'Buy crypto in a few steps',
    door: 'Trade',
    area: 'trade',
    screen: 'trade/buy',
  },
  {
    path: '/trade/margin',
    title: 'Margin',
    description: 'Isolated margin, health and collateral',
    door: 'Trade',
    area: 'trade',
    screen: 'trade/margin',
  },
  {
    path: '/trade/futures',
    title: 'Futures',
    description: 'Perpetual and dated contracts',
    door: 'Trade',
    area: 'trade',
    screen: 'trade/futures',
  },
  {
    path: '/trade/options',
    title: 'Options',
    description: 'Calls, strikes and puts',
    door: 'Trade',
    area: 'trade',
    screen: 'trade/options',
  },
  { path: '/trade/copy', title: 'Copy', description: 'Follow a trading strategy', door: 'Trade', area: 'trade' },
  { path: '/trade/bots', title: 'Trading bots', description: 'Automated strategies', door: 'Trade', area: 'trade' },
  {
    path: '/trade/risk',
    title: 'Risk control',
    description: 'Cancel every open order, close positions and see platform incidents',
    door: 'Trade',
    area: 'trade',
  },
  {
    path: '/trade/orders',
    title: 'Order history',
    description: 'Past orders by side, state and date, with each order’s fills and fees',
    door: 'Trade',
    area: 'trade',
  },
  {
    path: '/trade/orders/:id',
    title: 'Order detail',
    description: 'One order’s fills, fees and changes',
    door: 'Trade',
    area: 'trade',
    hidden: true,
  },
  { path: '/trade/news', title: 'News', description: 'Market news by category, language and symbol', door: 'Trade', area: 'trade' },
  { path: '/trade/calendar', title: 'Economic calendar', description: 'Scheduled releases and their values', door: 'Trade', area: 'trade' },
  {
    path: '/trade/convert',
    title: 'Convert',
    description: 'Convert between available assets',
    door: 'Trade',
    area: 'trade',
    screen: 'trade/convert',
  },
  {
    path: '/execution',
    title: 'Execution',
    description: 'Cross-venue execution',
    door: 'Trade',
    area: 'trade',
    screen: 'trade/execution',
  },
  {
    path: '/otc',
    title: 'Quote desk',
    description: 'Request a quoted trade',
    door: 'Trade',
    area: 'trade',
    screen: 'trade/otc',
  },
  {
    path: '/otc/:quoteId',
    title: 'Quoted order',
    description: 'Review a quoted trade',
    door: 'Trade',
    area: 'trade',
    hidden: true,
    screen: 'trade/otc',
  },
  { path: '/otc/tradeInfo', title: 'Quoted order', description: 'Review a quoted trade', door: 'Trade', area: 'trade', hidden: true },
  { path: '/otc/trade/*', title: 'Quoted order', description: 'Your trade context', door: 'Trade', area: 'trade', hidden: true },
  {
    path: '/uc/entrust/current',
    title: 'Open orders',
    description: 'Manage working orders',
    door: 'Trade',
    area: 'trade',
    alias: '/money/activity?tab=orders',
  },
  {
    path: '/uc/entrust/history',
    title: 'Order history',
    description: 'Past trading orders',
    door: 'Trade',
    area: 'trade',
    alias: '/money/activity?tab=orders&status=closed',
  },
  { path: '/pay', title: 'Pay', description: 'Send, receive and request', door: 'Pay', area: 'pay', screen: 'pay' },
  { path: '/pay/send', title: 'Send', description: 'Pay a person', door: 'Pay', area: 'pay', screen: 'pay' },
  { path: '/pay/request', title: 'Request', description: 'Request a payment', door: 'Pay', area: 'pay', screen: 'pay' },
  { path: '/pay/receive', title: 'Receive', description: 'Receive into your account', door: 'Pay', area: 'pay', screen: 'pay' },
  { path: '/pay/bills', title: 'Bill pay', description: 'Pay a bill', door: 'Pay', area: 'pay', screen: 'pay' },
  { path: '/pay/global', title: 'Send globally', description: 'Send to a bank account abroad', door: 'Pay', area: 'pay', screen: 'pay' },
  // Personal rooms (PP-order-02). They sit before the business catch-alls below so a personal address never reads as a business page.
  { path: '/pay/scheduled', title: 'Scheduled', description: 'Payments set for a later date', door: 'Pay', area: 'pay', screen: 'pay' },
  { path: '/pay/contacts', title: 'Contacts', description: 'People you pay, groups and pools', door: 'Pay', area: 'pay', screen: 'pay' },
  { path: '/pay/send/limits', title: 'Send limits', description: 'How much you can send', door: 'Pay', area: 'pay', screen: 'pay' },
  { path: '/pay/fees', title: 'Pay fees', description: 'What a payment costs', door: 'Pay', area: 'pay', screen: 'pay' },
  { path: '/pay/preferences', title: 'Pay preferences', description: 'How you pay and get paid', door: 'Pay', area: 'pay', screen: 'pay' },
  { path: '/pay/scan', title: 'Scan to pay', description: 'Pay from a QR code', door: 'Pay', area: 'pay', screen: 'pay' },
  { path: '/pay/cases', title: 'Cases', description: 'Problems you reported with a payment', door: 'Pay', area: 'pay', screen: 'pay' },
  {
    path: '/pay/request/:requestId',
    title: 'Payment request',
    description: 'One request you made',
    door: 'Pay',
    area: 'pay',
    screen: 'pay',
    hidden: true,
  },
  {
    path: '/pay/history/:transferId',
    title: 'Payment',
    description: 'One payment from your history',
    door: 'Pay',
    area: 'pay',
    screen: 'pay',
    hidden: true,
  },
  {
    path: '/pay/claim/:token',
    title: 'Claim a payment',
    description: 'Claim money sent before you had an account',
    door: 'Pay',
    area: 'pay',
    screen: 'pay',
    hidden: true,
  },
  {
    path: '/pay/cases/:caseId',
    title: 'Case',
    description: 'One case about a payment',
    door: 'Pay',
    area: 'pay',
    screen: 'pay',
    hidden: true,
  },
  {
    path: '/pay/l/:linkId',
    title: 'Payment link',
    description: 'A link someone sent you to pay',
    door: 'Pay',
    area: 'pay',
    screen: 'pay',
    hidden: true,
  },
  {
    path: '/pay/bills/invoices/:invoiceId',
    title: 'Bill',
    description: 'One bill you can pay',
    door: 'Pay',
    area: 'pay',
    screen: 'pay',
    hidden: true,
  },
  {
    path: '/pay/contacts/groups/:groupId',
    title: 'Group',
    description: 'People you pay together',
    door: 'Pay',
    area: 'pay',
    screen: 'pay',
    hidden: true,
  },
  {
    path: '/pay/contacts/pools/:poolId',
    title: 'Pool',
    description: 'A shared amount several people pay into',
    door: 'Pay',
    area: 'pay',
    screen: 'pay',
    hidden: true,
  },
  { path: '/p2p', title: 'Person-to-person', description: 'Offers, orders and counterparties', door: 'Pay', area: 'pay' },
  { path: '/ctc', title: 'Person-to-person', description: 'Offers and orders', door: 'Pay', area: 'pay', alias: '/p2p' },
  { path: '/uc/ad', title: 'My offers', description: 'Manage your person-to-person offers', door: 'Pay', area: 'pay' },
  { path: '/uc/ad/create', title: 'Create offer', description: 'Publish a person-to-person offer', door: 'Pay', area: 'pay', hidden: true },
  { path: '/uc/ad/update', title: 'Edit offer', description: 'Review a person-to-person offer', door: 'Pay', area: 'pay', hidden: true },
  { path: '/uc/order', title: 'Person-to-person orders', description: 'Your active and past trades', door: 'Pay', area: 'pay' },
  {
    path: '/p2p/orders',
    title: 'Person-to-person orders',
    description: 'Your active and past trades',
    door: 'Pay',
    area: 'pay',
    alias: '/uc/order',
    hidden: true,
  },
  {
    path: '/p2p/orders/:tradeId',
    title: 'Person-to-person orders',
    description: 'Your active and past trades',
    door: 'Pay',
    area: 'pay',
    alias: '/uc/order?tradeId=:tradeId',
    hidden: true,
  },
  { path: '/chat', title: 'Order conversation', description: 'Communicate about your order', door: 'Pay', area: 'pay', hidden: true },
  { path: '/checkuser', title: 'Counterparty', description: 'Check trade context', door: 'Pay', area: 'pay', hidden: true },
  ...(
    [
      ['merchant', 'Merchant home', 'Manage your business payments'],
      ['money', 'Merchant balance', 'Funds belonging to your merchant account'],
      ['money/activity', 'Balance activity', 'Records explaining merchant balance changes'],
      ['links', 'Payment links', 'Share a payment link'],
      ['links/new', 'Create a payment link', 'Review a new checkout link'],
      ['checkout', 'Checkout', 'Hosted payment checkout'],
      ['refunds', 'Refunds', 'Find refunds by their original payment'],
      ['refunds/new', 'Issue a refund', 'Review a full or partial refund'],
      ['payments', 'Payments', 'Customer payment activity'],
      ['customers', 'Customers', 'Business customer records'],
      ['payouts', 'Payouts', 'Review outgoing business payments'],
      ['settlements', 'Settlements', 'Settlement activity'],
      ['disputes', 'Disputes', 'Manage payment disputes'],
      ['network', 'Sub-merchants', 'Your merchant network'],
      ['permissions', 'Permissions', 'Merchant access controls'],
      ['conversion', 'Conversion', 'USD to USDT availability and orders'],
      ['conversion/new', 'Convert USD to USDT', 'Review a conversion quote'],
      ['compliance', 'Compliance', 'Business verification and requirements'],
      ['settings', 'Business profile', 'Merchant account details and preferences'],
      ['settings/team', 'Team settings', 'Manage merchant team access'],
      ['settings/notifications', 'Notification preferences', 'Choose business alerts'],
      ['invoices', 'Invoices', 'Issue and manage invoices'],
      ['subscriptions/new', 'Create subscription', 'Start a schedule from an existing mandate'],
      ['subscriptions', 'Subscriptions', 'Recurring billing'],
      ['reports', 'Reports', 'Export business activity'],
      ['reports/exports', 'Export jobs', 'Request and download account reports'],
      ['developer/keys', 'API keys', 'Sandbox credentials and their scopes'],
      ['developer/signing', 'Request signing', 'Request signing availability'],
      ['developer/webhooks', 'Webhook endpoints', 'Merchant event receivers'],
      ['developer/deliveries', 'Webhook deliveries', 'Recorded event delivery attempts'],
      ['developer', 'Developer', 'Test keys and webhooks'],
      ['onboarding', 'Set up your account', 'Open your merchant account in three steps'],
      ['onboarding/business', 'Business details', 'Save your legal business and contact details'],
      ['onboarding/verification', 'Business verification', 'Submit and track business verification'],
      ['onboarding/go-live', 'Payout destination', 'Review your destination and activation requirements'],
      ['team', 'Team and roles', 'Who can do what on this account'],
      ['exports', 'Exports', 'Download payment, settlement and payout reports'],
      ['notifications', 'Business alerts', 'Disputes, payouts and exports that need you'],
      ['approvals', 'Payout approvals', 'Payouts waiting for a second person'],
      ['pricing', 'Pricing and fees', 'What your account is charged'],
      ['limits', 'Limits and tier', 'How much of each limit is used'],
      ['payouts/new', 'Request a payout', 'Choose a settlement and send it for approval'],
      ['payouts/destinations', 'Payout destinations', 'Where your payouts are sent'],
      ['analytics', 'Analytics', 'Payment volume over time'],
      ['analytics/fees', 'Fees', 'What you paid in fees'],
      ['settings/security', 'Security', 'Sessions and sign-in protection'],
      ['activity', 'Activity', 'Who changed what on your account'],
      ['invoices/new', 'Create an invoice', 'Bill a customer for one amount'],
      ['developer/sandbox', 'Sandbox', 'Try payments with test money'],
      ['developer/docs', 'Developer docs', 'How to connect your systems'],
    ] as const
  ).map(([slug, title, description]) => ({
    path: `/pay/${slug}`,
    title,
    description,
    door: 'Pay' as const,
    area: 'pay' as const,
    business: true,
  })),
  {
    path: '/pay/invoices/:invoiceId',
    title: 'Invoice detail',
    description: 'One invoice reference',
    door: 'Pay',
    area: 'pay',
    business: true,
    hidden: true,
  },
  {
    path: '/pay/developer/webhooks/:endpointId',
    title: 'Endpoint detail',
    description: 'One merchant webhook endpoint',
    door: 'Pay',
    area: 'pay',
    business: true,
    hidden: true,
  },
  {
    path: '/pay/subscriptions/:subscriptionId',
    title: 'Subscription detail',
    description: 'One recurring schedule',
    door: 'Pay',
    area: 'pay',
    business: true,
    hidden: true,
  },
  {
    path: '/pay/conversion/:orderId',
    title: 'Conversion order',
    description: 'One conversion order',
    door: 'Pay',
    area: 'pay',
    business: true,
    hidden: true,
  },
  {
    path: '/pay/settings/profile',
    title: 'Business profile',
    description: 'Merchant account details and preferences',
    door: 'Pay',
    area: 'pay',
    business: true,
    hidden: true,
  },
  {
    path: '/pay/links/:linkId',
    title: 'Payment link',
    description: 'One checkout link',
    door: 'Pay',
    area: 'pay',
    business: true,
    hidden: true,
  },
  {
    path: '/pay/refunds/:refundId',
    title: 'Refund detail',
    description: 'One recorded refund',
    door: 'Pay',
    area: 'pay',
    business: true,
    hidden: true,
  },
  {
    path: '/pay/disputes/:disputeId',
    title: 'Dispute',
    description: 'One dispute',
    door: 'Pay',
    area: 'pay',
    business: true,
    hidden: true,
  },
  {
    path: '/pay/payments/:paymentId',
    title: 'Payment',
    description: 'One payment',
    door: 'Pay',
    area: 'pay',
    business: true,
    hidden: true,
  },
  {
    path: '/pay/settlements/:settlementId',
    title: 'Settlement statement',
    description: 'One settlement',
    door: 'Pay',
    area: 'pay',
    business: true,
    hidden: true,
  },
  {
    path: '/pay/payouts/:payoutId',
    title: 'Payout',
    description: 'One payout',
    door: 'Pay',
    area: 'pay',
    business: true,
    hidden: true,
  },
  {
    path: '/pay/customers/:customerRef',
    title: 'Customer',
    description: 'One customer',
    door: 'Pay',
    area: 'pay',
    business: true,
    hidden: true,
  },
  {
    path: '/pay/network/:childId',
    title: 'Business in your network',
    description: 'One business you manage',
    door: 'Pay',
    area: 'pay',
    business: true,
    hidden: true,
  },
  // Any other business address still opens the frame, which says "Page not found" with the way back to Overview.
  {
    path: '/pay/:page',
    title: 'Page not found',
    description: 'No such business page',
    door: 'Pay',
    area: 'pay',
    business: true,
    hidden: true,
  },
  {
    path: '/pay/:page/:child',
    title: 'Page not found',
    description: 'No such business page',
    door: 'Pay',
    area: 'pay',
    business: true,
    hidden: true,
  },
  { path: '/more', title: 'More', description: 'Explore the rest of Intafaced', door: 'More', area: 'more', screen: 'more' },
  { path: '/academy/:slug', title: 'Academy reader', description: 'Read a learning path', door: 'More', area: 'more', hidden: true },
  {
    path: '/market/strategy',
    title: 'Strategy listing',
    description: 'Publish a strategy subscription',
    door: 'More',
    area: 'more',
    hidden: true,
  },
  ...(
    [
      ['academy', 'Academy', 'Rooms, learning and certifications'],
      ['agents', 'Agents', 'Your agent fleet'],
      ['quant', 'Algo dev', 'Build, backtest and paper-run strategies'],
      ['quant/sandbox', 'Quant sandbox', 'Run strategy code on the paper book'],
      ['quant/studio', 'Quant Studio', 'Build and run strategies'],
      ['quant/backtest', 'Backtest', 'Review strategy results'],
      ['launch', 'Launch', 'Issue and list an asset'],
      ['market', 'Market catalogue', 'Browse available listings'],
      ['market/mine', 'My listings', 'Your market listings'],
      ['predict', 'Prediction markets', 'Browse and trade predictions'],
      ['mining', 'Mining', 'Pool activity and payouts'],
      ['token', 'Token', 'Access and staking'],
      ['blueprint', 'Identity Blueprint', 'Your profile and connected intelligence'],
      ['support', 'Support', 'Tickets and published answers'],
      ['campaigns', 'Activities', 'Signed-in campaigns'],
    ] as const
  ).map(([slug, title, description]) => ({
    path: `/${slug}`,
    title,
    description,
    door: 'More' as const,
    area: 'more' as const,
  })),
  // Sections and records of the six More rooms (MC-order-01). Never offered in search; `features/more/more-room-routes.ts` is the matching table.
  {
    path: '/predict/positions',
    title: 'Predict positions',
    description: 'Browse and trade predictions',
    door: 'More',
    area: 'more',
    hidden: true,
  },
  {
    path: '/predict/:marketId',
    title: 'Prediction market',
    description: 'Browse and trade predictions',
    door: 'More',
    area: 'more',
    hidden: true,
  },
  {
    path: '/market/purchases',
    title: 'Market purchases',
    description: 'Browse available listings',
    door: 'More',
    area: 'more',
    hidden: true,
  },
  {
    path: '/market/:listingId',
    title: 'Market listing',
    description: 'Browse available listings',
    door: 'More',
    area: 'more',
    hidden: true,
  },
  { path: '/launch/new', title: 'New launch', description: 'Issue and list an asset', door: 'More', area: 'more', hidden: true },
  { path: '/launch/check', title: 'Launch check', description: 'Issue and list an asset', door: 'More', area: 'more', hidden: true },
  {
    path: '/launch/requirements',
    title: 'Launch requirements',
    description: 'Issue and list an asset',
    door: 'More',
    area: 'more',
    hidden: true,
  },
  { path: '/launch/:projectId', title: 'Launch project', description: 'Issue and list an asset', door: 'More', area: 'more', hidden: true },
  { path: '/token/governance', title: 'Token governance', description: 'Access and staking', door: 'More', area: 'more', hidden: true },
  { path: '/token/economy', title: 'Token economy', description: 'Access and staking', door: 'More', area: 'more', hidden: true },
  {
    path: '/token/governance/:proposalId',
    title: 'Governance proposal',
    description: 'Access and staking',
    door: 'More',
    area: 'more',
    hidden: true,
  },
  { path: '/mining/workers', title: 'Mining workers', description: 'Pool activity and payouts', door: 'More', area: 'more', hidden: true },
  { path: '/mining/shares', title: 'Mining shares', description: 'Pool activity and payouts', door: 'More', area: 'more', hidden: true },
  { path: '/mining/rewards', title: 'Mining rewards', description: 'Pool activity and payouts', door: 'More', area: 'more', hidden: true },
  { path: '/mining/status', title: 'Mining status', description: 'Pool activity and payouts', door: 'More', area: 'more', hidden: true },
  {
    path: '/mining/workers/:workerId',
    title: 'Mining worker',
    description: 'Pool activity and payouts',
    door: 'More',
    area: 'more',
    hidden: true,
  },
  {
    path: '/blueprint/crew',
    title: 'Blueprint crew',
    description: 'Your profile and connected intelligence',
    door: 'More',
    area: 'more',
    hidden: true,
  },
  {
    path: '/blueprint/shared/:cardId',
    title: 'Shared card',
    description: 'Your profile and connected intelligence',
    door: 'More',
    area: 'more',
    hidden: true,
  },
  { path: '/uc/innovation/myorders', title: 'Launch orders', description: 'Your asset launch orders', door: 'More', area: 'more' },
  { path: '/uc', title: 'Account', description: 'Your account and security', area: 'person', alias: '/uc/account' },
  {
    path: '/oauth/authorize',
    title: 'Authorise an app',
    description: 'Allow or deny an app that asked to use your account',
    area: 'person',
    hidden: true,
  },
  { path: '/uc/account', title: 'Account', description: 'Your profile and account ID', area: 'person', screen: 'account' },
  { path: '/uc/safe', title: 'Security', description: 'Passkeys, sign-in checks and your devices', area: 'person', screen: 'account' },
  {
    path: '/uc/safe/api-keys',
    title: 'API keys',
    description: 'Keys for your own programs to read and trade',
    area: 'person',
    screen: 'account',
  },
  {
    path: '/uc/safe/api-keys/new',
    title: 'Create an API key',
    description: 'A new key with only the permissions it needs',
    area: 'person',
    screen: 'account',
  },
  { path: '/verification', title: 'Verification', description: 'Verification status and documents', area: 'person', screen: 'account' },
  { path: '/identbusiness', title: 'Business verification', description: 'Open a verified company account', area: 'person' },
  { path: '/view', title: 'Display', description: 'Theme, language and display preferences', area: 'person', screen: 'account' },
  { path: '/notifications', title: 'Notifications', description: 'Your account notifications', area: 'person', screen: 'notifications' },
  { path: '/uc/promotion', title: 'Promotions', description: 'Referral activity', area: 'person' },
  { path: '/uc/promotion/mycards', title: 'Promotion cards', description: 'Your promotion cards', area: 'person' },
  { path: '/uc/promotion/mypromotion', title: 'My promotions', description: 'Referral activity', area: 'person' },
  { path: '/uc/invitingmining', title: 'Invitations', description: 'Your invitation activity', area: 'person' },
  { path: '/uc/paydividends', title: 'Dividend records', description: 'Your dividend history', area: 'person' },
  { path: '/uc/trade', title: 'Trading settings', description: 'Personal trade settings', area: 'person', alias: '/view' },
  { path: '/ops', title: 'Team desk', description: 'Separate operator console', area: 'team', hidden: true },
  { path: '/platform', title: 'Team inspection', description: 'Operator module inspection', area: 'team', hidden: true },
  // The Web3 rooms (IA-SPEC 2.8). Every route comes from the Protocol route table; the room roots are searchable and the
  // detail routes are not. The network is Base Sepolia, which is not INTACHAIN and is not audited.
  ...WEB3_ROUTES.map((route): Room => ({
    path: route.path,
    title: route.room,
    description: WEB3_DESCRIPTION[route.room],
    area: 'web3',
    ...(route.path === `/${route.room}` ? {} : { hidden: true }),
  })),
  // Unknown sub-paths open the room, which answers them with its not-found page.
  ...(['chain', 'dex', 'protocol', 'wallet'] as const).map((slug): Room => ({
    path: `/${slug}/*`,
    title: slug,
    description: WEB3_DESCRIPTION[slug],
    area: 'web3',
    hidden: true,
  })),
];

export function findRoom(path: string): Room | undefined {
  return (
    rooms.find((room) => room.path === path) ??
    rooms.filter((room) => hasPattern(room.path)).find((room) => matchPath(room.path, path) !== undefined)
  );
}

/** `BTC_USDT`, `btc/usdt` and `BTC%2FUSDT` all become `BTC-USDT`, the shape the desk route uses. */
export function normalizePair(value: string): string {
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    /* keep the raw segment */
  }
  return decoded.replace(/[_/]/g, '-').toUpperCase();
}
const aliasParameter = /:([A-Za-z][A-Za-z0-9]*)/g;
/**
 * Where an alias row sends `path` (UI-SPEC 3.2), or undefined when `room` is not an alias.
 * `:param` names in `room.alias` are filled from the matching segments of `path`, a query
 * written on the alias wins over the same key in `search`, and every other query key is kept.
 */
export function resolveAlias(room: Room, path: string, search = ''): string | undefined {
  if (!room.alias) return undefined;
  const params = matchPath(room.path, path) ?? {};
  const fill = (text: string, encode: boolean) =>
    text.replace(aliasParameter, (whole, name: string) => {
      const value = params[name];
      if (value === undefined) return whole;
      const shaped = name === 'pair' ? normalizePair(value) : value;
      // A segment placed in a query is one value, whatever characters it carries.
      return encode ? encodeURIComponent(shaped) : shaped;
    });
  const [aliasPath = '/', aliasQuery = ''] = room.alias.split('?');
  const targetPath = fill(aliasPath, false);
  const query = new URLSearchParams(search);
  for (const [key, value] of new URLSearchParams(fill(aliasQuery, true))) query.set(key, value);
  const text = query.toString();
  return text ? `${targetPath}?${text}` : targetPath;
}
export function customerRoomHref(candidate: string | null | undefined): string | undefined {
  if (!candidate || !candidate.startsWith('/') || candidate.startsWith('//') || candidate.includes('\\')) return undefined;
  try {
    const url = new URL(candidate, 'https://intafaced.invalid');
    const room = findRoom(url.pathname);
    return room && !['team', 'web3'].includes(room.area) ? `${url.pathname}${url.search}` : undefined;
  } catch {
    return undefined;
  }
}
export function safeReturnTo(candidate: string | null | undefined): string {
  const href = customerRoomHref(candidate);
  const room = href ? findRoom(href.split('?')[0] ?? '') : undefined;
  if (!href || room?.area === 'public') return '/home';
  const url = new URL(candidate!, 'https://intafaced.invalid');
  return url.origin === 'https://intafaced.invalid' && !url.username && !url.password ? `${href}${url.hash}` : '/home';
}
export function roomTitle(room: Room, locale: UiLocale = currentPreferences().language): string {
  return navigationCopy.forLocale(locale).t(room.title);
}
export function roomDescription(room: Room, locale: UiLocale = currentPreferences().language): string {
  return navigationCopy.forLocale(locale).t(room.description);
}
/** Where a room lives, as search shows it: "Bank > Earn". Parked Web3 rooms sit under More; rooms outside every door have no path. */
export function roomPath(room: Room, locale: UiLocale = currentPreferences().language): string | undefined {
  const door = room.door ?? (room.area === 'web3' ? 'More' : undefined);
  return door ? `${doorLabel(door, locale)} > ${roomTitle(room, locale)}` : undefined;
}

export function doorLabel(door: Door | 'Money', locale: UiLocale = currentPreferences().language): string {
  return navigationCopy.forLocale(locale).t(door);
}
const publicSearchable = new Set(['/help', '/status', '/notice', '/lab', '/app', '/partner', '/developers', '/developers/hosts']);
/**
 * Pages offered by search: every room you can open. Aliases, detail routes (flagged `hidden`) and the separate Team desk
 * never appear; Web3 rooms do, so a search finds them and shows their blockers. Business rooms wait for Business
 * mode, except the Merchant home, which is how a Personal account finds the merchant set-up.
 */
export function searchRooms(query: string, mode: 'Personal' | 'Business', locale: UiLocale = currentPreferences().language): Room[] {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return rooms.filter(
    (room) =>
      !room.hidden &&
      !room.alias &&
      room.area !== 'team' &&
      // Public marketing pages are not part of the signed-in app; Help and the public extras customers once could not reach are.
      (room.area !== 'public' || publicSearchable.has(room.path)) &&
      !isHiddenPath(room.path) &&
      (!room.business || mode === 'Business' || room.path === '/pay/merchant') &&
      words.every((word) =>
        `${room.title} ${room.description} ${room.door ?? ''} ${roomTitle(room, locale)} ${roomDescription(room, locale)} ${room.door ? doorLabel(room.door, locale) : ''}`
          .toLowerCase()
          .includes(word),
      ),
  );
}

export const defaultDeskPair = 'BTC-USDT';
/** The pair of a desk path (`/trade/spot/ETH-USDT`, `/exchange/ETH_USDT`), as "ETH/USDT"; null for any other path. */
export function deskPairLabel(path: string): string | null {
  const match = /^\/(?:trade\/spot|exchange)\/([^/]+)$/.exec(path);
  return match ? normalizePair(match[1]!).replace('-', '/') : null;
}
/** The Trade tab: the markets list in Simple, the desk in Pro. A link to a specific page ignores the mode. */
export function tradeTabHref(layoutMode: 'simple' | 'pro', lastPair: string = defaultDeskPair): string {
  return layoutMode === 'pro' ? `/trade/spot/${normalizePair(lastPair)}` : '/trade';
}
/**
 * Where a coin link goes: the coin page in Simple, the desk in Pro. The coin page needs a session, so a signed-out visitor
 * in Simple gets the public Buy card instead of a sign-in wall.
 */
export function coinHref(asset: string, layoutMode: 'simple' | 'pro', symbol?: string | null, signedIn = true): string {
  if (layoutMode === 'pro') return `/trade/spot/${normalizePair(symbol ?? `${asset}-USDT`)}`;
  return signedIn ? `/coin/${encodeURIComponent(asset)}` : `/trade/buy?asset=${encodeURIComponent(asset)}`;
}
export const doors: ReadonlyArray<{ name: Door; path: string }> = [
  { name: 'Home', path: '/home' },
  { name: 'Assets', path: '/money' },
  { name: 'Bank', path: '/bank' },
  { name: 'Trade', path: '/trade' },
  { name: 'Pay', path: '/pay' },
  { name: 'More', path: '/more' },
];
import { navigationCopy, type NavigationCopyKey } from './navigation-copy';
import { currentPreferences } from '../shared/preferences';
import type { UiLocale } from '../shared/i18n';
import { isHiddenPath } from './feature-registry';
import { hasPattern, matchPath } from './path-match';
import type { ScreenId } from './screen-types';
import { WEB3_ROUTES } from '../features/protocol/routes';
