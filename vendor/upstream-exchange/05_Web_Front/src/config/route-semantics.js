'use strict';

/*
 * The member router's presentation contract.
 *
 * Vue Router 3 does not set document titles or page headings. Keeping this
 * small, explicit catalog beside routes.js gives every address an honest name
 * without making individual screens compete to mutate document.title. Dynamic
 * routes deliberately use stable screen names; user/API data is not trusted as
 * document chrome.
 */
var ROUTE_SEMANTICS = [
  ['/', 'Home'],
  ['/join', 'Join INTAFACED'],
  ['/join/:journey', 'Join INTAFACED'],
  ['/invest', 'Investor enquiry'],
  ['/trade', 'Trader enquiry'],
  ['/merchant', 'Merchant enquiry'],
  ['/index', 'Home'],
  ['/login', 'Sign in'],
  ['/login/returnUrl/:returnUrl', 'Sign in'],
  ['/register', 'Create account'],
  ['/reg', 'Create account on mobile'],
  ['/app', 'Mobile app'],
  ['/findPwd', 'Recover account'],
  ['/exchange', 'Exchange desk'],
  ['/exchange/:pair', 'Exchange desk'],
  ['/predict', 'Prediction markets'],
  ['/mining', 'Mining'],
  ['/help', 'Help centre'],
  ['/helplist', 'Help topics'],
  ['/helpdetail', 'Help article'],
  ['/notice', 'Announcements'],
  ['/announcement', 'Announcements'],
  ['/invite', 'Invitations'],
  ['/lab', 'Lab'],
  ['/ctc', 'Peer-to-peer trading'],
  ['/lab/detail/:id', 'Lab activity'],
  ['/announcement/:id', 'Announcement'],
  ['/partner', 'Partner programme'],
  ['/bzb', 'Token information'],
  ['/platform', 'Platform'],
  ['/bank', 'Bank'],
  ['/bank/spaces', 'Bank spaces'],
  ['/bank/transfers', 'Bank transfers'],
  ['/bank/earn', 'Bank earn'],
  ['/bank/loans', 'Bank loans'],
  ['/bank/cards', 'Bank cards'],
  ['/bank/ramps', 'Bank ramps'],
  ['/bank/analytics', 'Bank analytics'],
  ['/bank/business', 'Business banking'],
  ['/pay', 'Payments'],
  ['/pay/money', 'Payment balances'],
  ['/pay/merchant', 'Merchant payments'],
  ['/pay/network', 'Payment network'],
  ['/pay/permissions', 'Payment permissions'],
  ['/pay/links', 'Payment links'],
  ['/pay/payments', 'Payment activity'],
  ['/pay/settlements', 'Payment settlements'],
  ['/pay/checkout', 'Checkout'],
  ['/market', 'Market intelligence'],
  ['/market/mine', 'My market research'],
  ['/support', 'Support'],
  ['/ops', 'Operations'],
  ['/portfolio', 'Portfolio'],
  ['/p2p', 'Peer-to-peer trading'],
  ['/token', 'Token'],
  ['/agents', 'Agents'],
  ['/blueprint', 'Blueprint'],
  ['/protocol', 'Protocol'],
  ['/dex', 'Decentralized exchange'],
  ['/quant', 'Quant'],
  ['/quant/studio', 'Quant studio'],
  ['/quant/backtest', 'Quant backtest'],
  ['/execution', 'Execution'],
  ['/chain', 'Chain'],
  ['/academy', 'Academy'],
  ['/launch', 'Launch'],
  ['/otc', 'Peer-to-peer trading'],
  ['/otc/trade/*', 'Peer-to-peer market'],
  ['/uc', 'Account'],
  ['/uc/safe', 'Account security'],
  ['/uc/account', 'Account verification'],
  ['/uc/money', 'Balances'],
  ['/uc/record', 'Transaction records'],
  ['/uc/recharge', 'Deposit'],
  ['/uc/withdraw', 'Withdraw'],
  ['/uc/withdraw/address', 'Withdrawal addresses'],
  ['/uc/ad', 'My advertisements'],
  ['/uc/ad/create', 'Create advertisement'],
  ['/uc/ad/update', 'Update advertisement'],
  ['/uc/order', 'Peer-to-peer orders'],
  ['/uc/entrust/current', 'Open orders'],
  ['/uc/entrust/history', 'Order history'],
  ['/uc/trade', 'Trade history'],
  ['/uc/invitingmining', 'Invitation rewards'],
  ['/uc/paydividends', 'Dividend records'],
  ['/uc/promotion/mycards', 'Promotion cards'],
  ['/uc/promotion/mypromotion', 'My promotions'],
  ['/uc/innovation/myorders', 'Innovation orders'],
  ['/otc/tradeInfo', 'Peer-to-peer order details'],
  ['/checkuser', 'Counterparty verification'],
  ['/chat', 'Order chat'],
  ['/identbusiness', 'Merchant verification'],
  ['/about-us', 'About INTAFACED'],
  ['*', 'Page not found']
].map(function(entry) {
  return { path: entry[0], title: entry[1], heading: entry[1] };
});

function pathMatches(pattern, path) {
  if (pattern === '*') return true;
  var expected = pattern.split('/');
  var actual = path.split('/');
  for (var i = 0; i < expected.length; i += 1) {
    if (expected[i] === '*') return true;
    if (expected[i] && expected[i][0] === ':') {
      if (!actual[i]) return false;
    } else if (expected[i] !== actual[i]) {
      return false;
    }
  }
  return expected.length === actual.length;
}

function semanticsForPath(path) {
  var safePath = typeof path === 'string' && path ? path : '/';
  if (safePath.length > 1) safePath = safePath.replace(/\/+$/, '');
  for (var i = 0; i < ROUTE_SEMANTICS.length; i += 1) {
    if (pathMatches(ROUTE_SEMANTICS[i].path, safePath)) return ROUTE_SEMANTICS[i];
  }
  return ROUTE_SEMANTICS[ROUTE_SEMANTICS.length - 1];
}

module.exports = {
  ROUTE_SEMANTICS: ROUTE_SEMANTICS,
  semanticsForPath: semanticsForPath
};
