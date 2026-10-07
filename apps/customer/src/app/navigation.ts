export type Door = 'Money' | 'Trade' | 'Pay' | 'More';
export type Room = { path: string; title: string; description: string; door?: Door; area: 'money' | 'trade' | 'pay' | 'more' | 'person' | 'public' | 'parked' | 'team'; business?: boolean; alias?: string; hidden?: boolean };

export const rooms: readonly Room[] = [
  { path: '/', title: 'Home', description: 'Intafaced', area: 'public', hidden: true },
  { path: '/index', title: 'Home', description: 'Intafaced', area: 'public', alias: '/' },
  { path: '/login', title: 'Sign in', description: 'Access your account', area: 'public', hidden: true },
  { path: '/login/returnUrl/:returnUrl', title: 'Sign in', description: 'Return to your room', area: 'public', hidden: true },
  { path: '/register', title: 'Create account', description: 'Your personal account', area: 'public', hidden: true },
  { path: '/reg', title: 'Create account', description: 'Your personal account', area: 'public', alias: '/register' },
  { path: '/findPwd', title: 'Password recovery', description: 'Recover account access', area: 'public', hidden: true },
  { path: '/help', title: 'Help centre', description: 'Find answers and contact support', area: 'public' },
  { path: '/helplist', title: 'Help centre', description: 'Published help', area: 'public', alias: '/help' },
  { path: '/helpdetail', title: 'Help article', description: 'Published guidance', area: 'public', hidden: true },
  { path: '/notice', title: 'Notices', description: 'Product announcements', area: 'public' },
  { path: '/notice/:id', title: 'Notice', description: 'Product announcement', area: 'public', hidden: true },
  { path: '/announcement', title: 'Notices', description: 'Product announcements', area: 'public', alias: '/notice' },
  { path: '/announcement/:id', title: 'Notice', description: 'Product announcement', area: 'public', hidden: true },
  { path: '/about-us', title: 'About Intafaced', description: 'One account, connected experiences', area: 'public' },
  { path: '/invite', title: 'Invite', description: 'Invite someone to Intafaced', area: 'public' },
  { path: '/app', title: 'Get the app', description: 'Mobile availability', area: 'public' },
  { path: '/partner', title: 'Partners', description: 'Work with Intafaced', area: 'public' },
  { path: '/lab', title: 'Campaigns', description: 'Public activities', area: 'public' },
  { path: '/lab/detail/:id', title: 'Campaign', description: 'Activity details', area: 'public', hidden: true },
  { path: '/bzb', title: 'Campaigns', description: 'Public activities', area: 'public', alias: '/lab' },
  { path: '/money', title: 'Money', description: 'Holdings and available funds', door: 'Money', area: 'money' },
  { path: '/portfolio', title: 'Holdings', description: 'Your assets in one ledger', door: 'Money', area: 'money' },
  { path: '/money/asset/:asset', title: 'Holding', description: 'Asset details and actions', door: 'Money', area: 'money', hidden: true },
  { path: '/uc/money', title: 'Money', description: 'Your holdings', door: 'Money', area: 'money', alias: '/money' },
  { path: '/uc/recharge', title: 'Deposit', description: 'Add funds', door: 'Money', area: 'money' },
  { path: '/uc/withdraw', title: 'Withdraw', description: 'Withdraw available funds', door: 'Money', area: 'money' },
  { path: '/uc/withdraw/address', title: 'Addresses', description: 'Withdrawal destinations', door: 'Money', area: 'money' },
  { path: '/uc/record', title: 'Activity', description: 'Money moving in and out', door: 'Money', area: 'money' },
  { path: '/bank', title: 'Bank', description: 'The bank behind your balance', door: 'Money', area: 'money' },
  { path: '/bank/spaces', title: 'Spaces', description: 'Organise funds for your goals', door: 'Money', area: 'money' },
  { path: '/bank/transfers', title: 'Transfers', description: 'Move funds between your spaces', door: 'Money', area: 'money' },
  { path: '/bank/earn', title: 'Earn', description: 'Available earning products', door: 'Money', area: 'money' },
  { path: '/bank/loans', title: 'Loans', description: 'Applications and repayments', door: 'Money', area: 'money' },
  { path: '/bank/cards', title: 'Cards', description: 'Card issuer availability and controls', door: 'Money', area: 'money' },
  { path: '/bank/ramps', title: 'Cash and crypto', description: 'Onramps and offramps', door: 'Money', area: 'money' },
  { path: '/bank/analytics', title: 'Spending', description: 'Understand your activity', door: 'Money', area: 'money' },
  { path: '/bank/business', title: 'Business bank', description: 'Company cash accounts', door: 'Money', area: 'money', business: true },
  { path: '/exchange', title: 'Trade', description: 'Spot trading terminal', door: 'Trade', area: 'trade' },
  { path: '/exchange/:pair', title: 'Market', description: 'Linked chart, book and order ticket', door: 'Trade', area: 'trade', hidden: true },
  { path: '/trade/margin', title: 'Margin', description: 'Cross or isolated trading', door: 'Trade', area: 'trade' },
  { path: '/trade/futures', title: 'Futures', description: 'Perpetual and dated contracts', door: 'Trade', area: 'trade' },
  { path: '/trade/options', title: 'Options', description: 'Calls, strikes and puts', door: 'Trade', area: 'trade' },
  { path: '/trade/copy', title: 'Copy', description: 'Follow a trading strategy', door: 'Trade', area: 'trade' },
  { path: '/trade/bots', title: 'Trading bots', description: 'Automated strategies', door: 'Trade', area: 'trade' },
  { path: '/trade/convert', title: 'Convert', description: 'Convert between available assets', door: 'Trade', area: 'trade' },
  { path: '/execution', title: 'Execution', description: 'Cross-venue execution', door: 'Trade', area: 'trade' },
  { path: '/otc', title: 'Quote desk', description: 'Request a quoted trade', door: 'Trade', area: 'trade' },
  { path: '/otc/tradeInfo', title: 'Quoted order', description: 'Review a quoted trade', door: 'Trade', area: 'trade', hidden: true },
  { path: '/otc/trade/*', title: 'Quoted order', description: 'Your trade context', door: 'Trade', area: 'trade', hidden: true },
  { path: '/uc/entrust/current', title: 'Open orders', description: 'Manage working orders', door: 'Trade', area: 'trade' },
  { path: '/uc/entrust/history', title: 'Order history', description: 'Past trading orders', door: 'Trade', area: 'trade' },
  { path: '/pay', title: 'Pay', description: 'Send, receive and request', door: 'Pay', area: 'pay' },
  { path: '/pay/send', title: 'Send', description: 'Pay a person', door: 'Pay', area: 'pay' },
  { path: '/pay/request', title: 'Request', description: 'Request a payment', door: 'Pay', area: 'pay' },
  { path: '/pay/receive', title: 'Receive', description: 'Receive into your account', door: 'Pay', area: 'pay' },
  { path: '/pay/bills', title: 'Bill pay', description: 'Pay a bill', door: 'Pay', area: 'pay' },
  { path: '/pay/global', title: 'Send globally', description: 'Send to a bank account abroad', door: 'Pay', area: 'pay' },
  { path: '/p2p', title: 'Person-to-person', description: 'Offers, orders and counterparties', door: 'Pay', area: 'pay' },
  { path: '/ctc', title: 'Person-to-person', description: 'Offers and orders', door: 'Pay', area: 'pay', alias: '/p2p' },
  { path: '/uc/ad', title: 'My offers', description: 'Manage your person-to-person offers', door: 'Pay', area: 'pay' },
  { path: '/uc/ad/create', title: 'Create offer', description: 'Publish a person-to-person offer', door: 'Pay', area: 'pay', hidden: true },
  { path: '/uc/ad/update', title: 'Edit offer', description: 'Review a person-to-person offer', door: 'Pay', area: 'pay', hidden: true },
  { path: '/uc/order', title: 'Person-to-person orders', description: 'Your active and past trades', door: 'Pay', area: 'pay' },
  { path: '/chat', title: 'Order conversation', description: 'Communicate about your order', door: 'Pay', area: 'pay', hidden: true },
  { path: '/checkuser', title: 'Counterparty', description: 'Check trade context', door: 'Pay', area: 'pay', hidden: true },
  ...[['merchant','Merchant home','Manage your business payments'],['money','Merchant balance','Funds belonging to your merchant account'],['links','Payment links','Share a payment link'],['checkout','Checkout','Hosted payment checkout'],['payments','Payments','Customer payment activity'],['customers','Customers','Business customer records'],['payouts','Payouts','Review outgoing business payments'],['settlements','Settlements','Settlement activity'],['disputes','Disputes','Manage payment disputes'],['network','Sub-merchants','Your merchant network'],['permissions','Permissions','Merchant access controls'],['invoices','Invoices','Issue and manage invoices'],['subscriptions','Subscriptions','Recurring billing'],['reports','Reports','Export business activity'],['developer','Developer','Test keys and webhooks']].map(([slug,title,description]) => ({ path:`/pay/${slug}`, title:title!, description:description!, door:'Pay' as const, area:'pay' as const, business:true })),
  { path: '/more', title: 'More', description: 'Explore the rest of Intafaced', door: 'More', area: 'more' },
  ...[['academy','Academy','Rooms, learning and certifications'],['agents','Agents','Your agent fleet'],['quant','Quant','Research and strategy sandbox'],['quant/studio','Quant Studio','Build and run strategies'],['quant/backtest','Backtest','Review strategy results'],['launch','Launch','Issue and list an asset'],['market','Market catalogue','Browse available listings'],['market/mine','My listings','Your market listings'],['predict','Prediction markets','Browse and trade predictions'],['mining','Mining','Pool activity and payouts'],['token','Token','Access and staking'],['blueprint','Identity Blueprint','Your profile and connected intelligence'],['support','Support','Tickets and published answers'],['campaigns','Activities','Signed-in campaigns']].map(([slug,title,description]) => ({ path:`/${slug}`,title:title!,description:description!,door:'More' as const,area:'more' as const })),
  { path: '/uc/innovation/myorders', title: 'Launch orders', description: 'Your asset launch orders', door: 'More', area: 'more' },
  { path: '/uc', title: 'Account', description: 'Your account and security', area: 'person', alias: '/uc/account' },
  { path: '/uc/account', title: 'Account', description: 'Identity and strategy subaccounts', area: 'person' },
  { path: '/uc/safe', title: 'Security', description: 'Passkeys, two-factor and sessions', area: 'person' },
  { path: '/verification', title: 'Verification', description: 'Verification status and documents', area: 'person' },
  { path: '/identbusiness', title: 'Business verification', description: 'Open a verified company account', area: 'person' },
  { path: '/view', title: 'View', description: 'Theme, language and display preferences', area: 'person' },
  { path: '/notifications', title: 'Inbox', description: 'Your account notifications', area: 'person' },
  { path: '/uc/promotion', title: 'Promotions', description: 'Referral activity', area: 'person' },
  { path: '/uc/promotion/mycards', title: 'Promotion cards', description: 'Your promotion cards', area: 'person' },
  { path: '/uc/promotion/mypromotion', title: 'My promotions', description: 'Referral activity', area: 'person' },
  { path: '/uc/invitingmining', title: 'Invitations', description: 'Your invitation activity', area: 'person' },
  { path: '/uc/paydividends', title: 'Dividend records', description: 'Your dividend history', area: 'person' },
  { path: '/uc/trade', title: 'Trading settings', description: 'Personal trade settings', area: 'person', alias: '/view' },
  { path: '/ops', title: 'Team desk', description: 'Separate operator console', area: 'team', hidden: true },
  { path: '/platform', title: 'Team inspection', description: 'Operator module inspection', area: 'team', hidden: true },
  ...['chain','dex','protocol'].map((slug) => ({ path:`/${slug}`, title:slug, description:'Parked until owner activation', area:'parked' as const, hidden:true })),
];

function matches(pattern: string, path: string) {
  const expected = pattern.split('/'); const actual = path.split('/');
  if (!pattern.endsWith('*') && expected.length !== actual.length) return false;
  return expected.every((part,index) => part === '*' || part.startsWith(':') && Boolean(actual[index]) || part === actual[index]);
}
export function findRoom(path: string): Room | undefined {
  return rooms.find((room) => room.path === path) ?? rooms.filter((room) => room.path.includes(':') || room.path.includes('*')).find((room) => matches(room.path,path));
}
export function safeReturnTo(candidate: string | null | undefined): string {
  if (!candidate || !candidate.startsWith('/') || candidate.startsWith('//') || candidate.includes('\\')) return '/money';
  try {
    const url = new URL(candidate,'https://intafaced.invalid');
    const room = findRoom(url.pathname);
    return room && !['public','team','parked'].includes(room.area) ? `${url.pathname}${url.search}` : '/money';
  } catch { return '/money'; }
}
export function searchRooms(query: string, mode: 'Personal' | 'Business'): Room[] {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return rooms.filter((room) => !room.hidden && !room.alias && !['team','parked'].includes(room.area) && (!room.business || mode === 'Business') && words.every((word) => `${room.title} ${room.description} ${room.door ?? ''}`.toLowerCase().includes(word)));
}
export const doors: ReadonlyArray<{ name: Door; path: string; icon: 'money' | 'trade' | 'pay' | 'more' }> = [{name:'Money',path:'/money',icon:'money'},{name:'Trade',path:'/exchange',icon:'trade'},{name:'Pay',path:'/pay',icon:'pay'},{name:'More',path:'/more',icon:'more'}];
