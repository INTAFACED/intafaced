/**
 * The TEST account the look gate (tooling/ci/look-gate) renders every Customer room for, so a judge sees a signed-in
 * room with data instead of its sign-in or refuse state. Every answer is a wire fixture the screen tests already pin
 * (src/screens/<screen>/*.fixtures.mjs); nothing here is a live figure. A call this world does not answer is refused
 * as before (503 look_gate.no_services), so a room whose data has no fixture yet shows its own honest refuse state.
 *
 * To fill another room, add its calls below, from that screen's fixtures file:
 *   TRPC   `module:procedure` (`workItems.list` alone: every owner mounts it) -> (input) => wire data (the gate wraps it
 *          as tRPC's result)
 *   REST   a GET path under /api/v1/ (`ohlcv/*` takes the symbol) -> (arg) => wire JSON body
 * The gate calls each one with Date.now() at its frozen time; read the time only through Date.now(), never `new Date()`.
 * Then dispatch the look gate on the branch and add the changed rooms' baselines in their own commit.
 */
import { activityPage1, activityPage2, closedOrders, fills, openOrders, spaces, summary } from '../../src/screens/money/money.fixtures.mjs';
import { alertList, balances, hourlyCandles, markets, tickers } from '../../src/screens/home/home.fixtures.mjs';
import { apiKeys, kyc, kycRecord, owner, passkeys, perks, rank, sessions } from '../../src/screens/account/account.fixtures.mjs';

/** Rooms a signed-in person never sees as themselves (they redirect or sign in), so they render signed out. */
export const SIGNED_OUT = ['/', '/login', '/register', '/reg', '/cannot-sign-in', '/recover-account', '/confirm-email'];

/** The view a first visit lands on (shared/preferences.ts), stated so a change of default is a visible baseline change. */
export const VIEW = { layoutMode: 'simple' };

/** The TEST session `auth.refresh` answers at boot; it never reaches a service. */
export const session = (now) => ({
  userId: owner,
  accessToken: 'look-gate-test-token',
  expiresAt: new Date(now + 30 * 86_400_000).toISOString(),
});

export const TRPC = {
  // identity
  'identity:kyc.status': () => kyc('basic', [kycRecord()]),
  'identity:webauthn.list': () => passkeys(),
  'identity:rank.get': () => rank(),
  'identity:rank.perks': () => perks(),
  'identity:subAccounts.list': () => [],
  'identity:me': () => ({ userId: owner, handle: 'test_friend' }),
  'identity:listSessions': () => sessions(),
  'identity:apiKeys.list': () => apiKeys(),
  // Home's owner values and every owner's work list: an established account owes nothing.
  'ops:home.config': () => ({ workListCap: 5, workListOrder: null, searchResultCap: null, noticeStripLimit: 3, revision: 1 }),
  'workItems.list': () => ({ items: [] }),
  'notify:notify.alerts': () => alertList(),
  // bank
  'bank:portfolio.summary': () => summary(),
  // TEST: what the fixture person held a week ago and now (src/screens/money/money.pw.mjs, J-portfolio-06 #3).
  'bank:portfolio.holdingsChange': (input = {}) => ({
    from: input.from,
    to: '2026-10-20T12:00:00.000Z',
    rows: [
      {
        assetId: 'BTC',
        startAmount: '0.05',
        endAmount: '0.1',
        change: '0.05',
        startPriceUsd: '65000',
        endPriceUsd: '67812.4',
        startValueUsd: '3250',
        endValueUsd: '6781.24',
      },
    ],
  }),
  'bank:spaces.list': () => spaces(),
  'bank:business.list': () => [],
  // The bank pages its history, filters it by kind and direction and cuts it at the limit, as Home's one-line reads ask.
  'bank:activity.list': (input = {}) => {
    const page = input.cursor ? activityPage2() : activityPage1();
    const items = page.items.filter(
      (item) => (!input.kind || input.kind.includes(item.kind)) && (!input.direction || item.direction === input.direction),
    );
    return { ...page, items: input.limit ? items.slice(0, input.limit) : items };
  },
};

export const REST = {
  markets: () => markets,
  tickers: () => tickers(),
  'account/balance': () => balances(),
  'ohlcv/*': (symbol) => hourlyCandles(symbol),
  'account/trades': () => fills(),
  'orders/open': () => openOrders(),
  'orders/closed': () => closedOrders(),
};
