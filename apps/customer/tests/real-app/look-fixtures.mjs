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
  'ops:home.config': () => ({
    workListCap: 5,
    workListOrder: null,
    searchResultCap: null,
    noticeStripLimit: 3,
    recentActivityLimit: 3,
    revision: 1,
  }),
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
  // The TEST account's money is not held at a partner, so Withdraw shows no partner holds (J-wallet-01 #3).
  'bank:partnerHolds': () => ({ held: false }),
  // The bank pages its history, filters it by kind and direction and cuts it at the limit, as Home's one-line reads ask.
  'bank:activity.list': (input = {}) => {
    const page = input.cursor ? activityPage2() : activityPage1();
    const items = page.items.filter(
      (item) => (!input.kind || input.kind.includes(item.kind)) && (!input.direction || item.direction === input.direction),
    );
    return { ...page, items: input.limit ? items.slice(0, input.limit) : items };
  },
  // quant: a new developer, as J-algo-dev-01 #1 starts: none of the three quick start steps done, no strategy saved,
  // none shared with them; the sharing ID is the TEST account's own id.
  'quant:quickStart': () => ({ strategy: false, backtest: false, paperRun: false }),
  'quant:studio.list': () => ({ strategies: [], nextCursor: null }),
  'quant:team.shared': () => ({ accountId: owner, strategies: [] }),
  'quant:studio.listDeleted': () => ({ strategies: [], nextCursor: null }),
  // The TEST plan the new developer runs under, its usage and its sandbox limits, as J-algo-dev-12 #4 sets them.
  'quant:quota.get': () => ({
    profile: 'TEST developer',
    source: 'default',
    resources: [
      ['strategies', '0', '3'],
      ['versions', '0', null],
      ['concurrent_runs', '0', '2'],
      ['paper_runs', '0', null],
      ['runs', '0', '5'],
      ['log_lines', '0', null],
      ['storage', '0', '10000000'],
      ['collaborators', '0', '2'],
      ['notifications', '0', null],
    ].map(([resource, used, limit]) => ({ resource, used, limit })),
    asOf: new Date(Date.now()).toISOString(),
  }),
  'quant:limits.get': () => ({
    profile: 'TEST developer',
    source: 'default',
    sandbox: [
      { limit: 'wall_clock_ms', value: '5000' },
      { limit: 'memory_bytes', value: '1000000' },
      { limit: 'output_bytes', value: '200000' },
    ],
    ceilings: { maxOps: '50000', maxSource: '8000' },
    asOf: new Date(Date.now()).toISOString(),
  }),
  'quant:tier.list': () => ({ current: { profile: 'TEST developer', source: 'default' }, tiers: [] }),
  'quant:template.list': () => ({ templates: [], nextCursor: null }),
  'quant:library.browse': () => ({ entries: [], nextCursor: null }),
  // The sandbox runs strategies; no exchange access is set up for them.
  'quant:sandbox.capabilities': () => ({
    isolate: 'wired',
    languages: ['javascript', 'typescript', 'python'],
    venueVault: 'unset',
    refuse: null,
  }),
  // The data room: one TEST market recorded for the last hour, with one ten-minute gap in its prices.
  'quant:lake.catalogue': () => {
    const at = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
    const dataset = (kind, gap) => ({
      kind,
      rows: 120,
      first: at(60),
      last: at(0),
      coverage: gap
        ? [
            { from: at(60), to: at(30) },
            { from: at(20), to: at(0) },
          ]
        : [{ from: at(60), to: at(0) }],
      gaps: gap ? [{ from: at(30), to: at(20) }] : [],
      latest: [],
    });
    return {
      captureSeconds: 30,
      retentionDays: 30,
      keptFrom: at(30 * 24 * 60),
      asOf: at(0),
      symbols: [
        { symbol: 'TEST-BTC-USDT', capturing: true, datasets: [dataset('tick', true), dataset('book', false), dataset('fill', false)] },
      ],
      source: 'INTAFACED exchange public market data',
    };
  },
  // protocol: the one TEST wallet the account connected; the venue account it owns is its trading account (row d115).
  'protocol:venueWallet.status': () => ({ connections: [venueConnection()] }),
  // pay: a personal account with no business yet (matches `bank:business.list: () => []`), so business rooms show their
  // no-business state with one "Open a business account" menu entry and `/pay/onboarding` opens on the first setup step.
  'pay:merchant.myAccess': () => ({ memberships: [] }),
  'pay:merchant.me': () => null,
};

export const REST = {
  markets: () => markets,
  tickers: () => tickers(),
  'account/balance': () => balances(),
  'ohlcv/*': (symbol) => hourlyCandles(symbol),
  'account/trades': () => fills(),
  'orders/open': () => openOrders(),
  'orders/closed': () => closedOrders(),
  // TEST: what the venue reports in that trading account, so Home's Get started has its money step done.
  'venue/balances': () => ({
    venueId: 'test-venue',
    asOf: new Date(Date.now()).toISOString(),
    value: [{ asset: 'USDC', free: '25', locked: '0', total: '25' }],
  }),
};

/**
 * The REST reads the TEST account's deployment refuses, each with its typed answer: the venue door is off here, so the
 * venue's market states refuse as off and the Markets list and /status read their own markets (J-cex-spot-14 #1 #2).
 */
export const REST_REFUSED = {
  'venue/market-states': {
    status: 404,
    json: { code: 'NotFound', message: 'the user-venue door is off on this deployment', intafacedCode: 'trade.user_venue_off' },
  },
};

/** The TEST wallet's connection, as svc-protocol records it: live for a month from the frozen time, never holding a key. */
function venueConnection() {
  const now = Date.now();
  return {
    address: '0x00000000000000000000000000000000000000a1',
    chainId: 84532,
    connectedAt: new Date(now - 86_400_000).toISOString(),
    expiresAt: new Date(now + 30 * 86_400_000).toISOString(),
    status: 'live',
    holdsKey: false,
  };
}
