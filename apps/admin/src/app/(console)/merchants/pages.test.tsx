import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { founderCookie, sealFounderSession, type FounderSession } from '@/lib/founder-session';

/**
 * The Merchants pages, rendered the way a founder's browser would get them.
 * `next/headers` is the only seam mocked; redirects and not-found are Next's own.
 */
let incoming = new Headers();
vi.mock('next/headers', () => ({ headers: async () => incoming }));
// The real reader runs the production-posture guard, which refuses on CI's dev material when APP_ENV=prod.
// The badge's own rule is what these tests pin, so they can force the reader's answer.
const operatorEnvOverride = vi.hoisted(() => ({ mode: 'real' as 'real' | 'prod' | 'throws' }));
vi.mock('@/lib/operator-env', async (original) => {
  const actual = await original<typeof import('@/lib/operator-env')>();
  return {
    ...actual,
    readOperatorEnv: () => {
      if (operatorEnvOverride.mode === 'throws') throw new Error('environment refused');
      if (operatorEnvOverride.mode === 'prod') return { ...actual.readOperatorEnv(), appEnv: 'prod' };
      return actual.readOperatorEnv();
    },
  };
});
// The merchant table is a client component; a static render has no mounted app router.
vi.mock('next/navigation', async (original) => ({
  ...(await original<typeof import('next/navigation')>()),
  useRouter: () => ({ push: () => undefined }),
}));

import MerchantsHome from './page';
import AllMerchants from './all/page';
import MerchantDetail from './[id]/page';
import RegistriesIndex from './registries/page';
import RegistryList from './registries/[kind]/page';
import RegistryNew from './registries/[kind]/new/page';
import RegistryEntry from './registries/[kind]/[key]/page';
import Treasury from './treasury/page';
import MerchantsLayout from './layout';

const ORIGINAL_ENV = { ...process.env };
const ORIGIN = 'https://admin.example';
const EDGE = 'http://edge:4000';
const KEY = Buffer.alloc(32, 4);
const USER = '11111111-1111-4111-8111-111111111111';
const MID = '22222222-2222-4222-8222-222222222222';
const NOW = new Date();

function configure(extra: Record<string, string> = {}) {
  vi.stubEnv('ADMIN_ORIGIN', ORIGIN);
  vi.stubEnv('EDGE_URL', EDGE);
  vi.stubEnv('ADMIN_SESSION_SECRET', KEY.toString('base64url'));
  vi.stubEnv('APP_ENV', 'test');
  for (const [k, v] of Object.entries(extra)) vi.stubEnv(k, v);
}
function signIn() {
  const s: FounderSession = {
    userId: USER,
    accessToken: 'founder-access-token',
    refreshToken: 'r',
    issuedAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
    csrf: Buffer.alloc(32, 5).toString('base64url'),
  };
  incoming = new Headers({
    host: 'admin.example',
    cookie: founderCookie(sealFounderSession(s, { origin: ORIGIN, edgeUrl: EDGE, key: KEY }, NOW), 3600).split(';')[0]!,
  });
}
const signedOut = () => {
  incoming = new Headers({ host: 'admin.example' });
};

const enabled = () =>
  Response.json({ result: { data: { json: { status: 'enabled', userId: USER, version: '1', changedAt: NOW.toISOString() } } } });
const ok = (data: unknown) => Response.json({ result: { data } });
const notBuilt = (proc: string) =>
  Response.json(
    {
      error: {
        message: `pay.not_built: ${proc} is not built yet`,
        data: { code: 'NOT_IMPLEMENTED', httpStatus: 501, cause: { code: 'pay.not_built' } },
      },
    },
    { status: 501 },
  );

/** Route a service call by the procedure name in its URL. `null` handler means "not built". */
function services(map: Record<string, unknown | (() => Response)>) {
  const seen: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.includes('accountControls.operatorStatus')) return enabled();
      seen.push(url);
      const proc = decodeURIComponent(url.split('/trpc/')[1] ?? '').split('?')[0]!;
      const handler = Object.entries(map).find(([k]) => proc === k)?.[1];
      if (handler === undefined) return notBuilt(proc);
      return typeof handler === 'function' ? (handler as () => Response)() : ok(handler);
    }),
  );
  return seen;
}

const fresh = { asOf: '2026-10-15T10:00:00.000Z', lagSeconds: 4 };
const globalMetrics = {
  freshness: fresh,
  volume: [{ assetCode: 'USDT', amount: '1234.5' }],
  revenue: [{ assetCode: 'USDT', amount: '12.34' }],
  activeMerchants: 3,
  pendingSettlement: [{ assetCode: 'USDT', amount: '99.99' }],
  openFraudReviews: 2,
  pendingKyb: 5,
  onboardingFunnel: [
    { step: 'status.pending', count: 1 },
    { step: 'status.active', count: 3 },
    { step: 'status.suspended', count: 0 },
    { step: 'status.closed', count: 0 },
    { step: 'kyb.none', count: 0 },
    { step: 'kyb.pending', count: 5 },
    { step: 'kyb.approved', count: 3 },
    { step: 'kyb.rejected', count: 0 },
  ],
  railHealth: [
    { railId: 'card', ok: true, detail: null },
    { railId: 'sepa', ok: false, detail: 'timeout' },
  ],
};
const snapshot = {
  merchantId: MID,
  window: { kind: 'preset', preset: 'rolling_30d' },
  freshness: fresh,
  balances: [{ assetCode: 'USDT', clearing: '10', available: '2500.75' }],
  paymentCount: 7,
  statusMix: [{ status: 'captured', count: 7 }],
  captured: [{ assetCode: 'USDT', amount: '700' }],
  refunded: [{ assetCode: 'USDT', amount: '5' }],
  net: [{ assetCode: 'USDT', amount: '695' }],
  settlements: [{ assetCode: 'USDT', gross: '700', fees: '7', net: '693' }],
  averagePayment: [{ assetCode: 'USDT', amount: '100' }],
  largestPayment: [{ assetCode: 'USDT', amount: '300' }],
  linkUsage: { linksUsed: 2, paymentsViaLinks: 4 },
  feeRevenue: [{ assetCode: 'USDT', amount: '7' }],
  conversionVolume: null,
};
const series = {
  merchantId: MID,
  freshness: fresh,
  points: [{ day: NOW.toISOString().slice(0, 10), assetCode: 'USDT', volume: '700', feeRevenue: '7' }],
};
const venue = {
  venueId: 'binance-testnet',
  displayName: 'Binance (testnet)',
  mode: 'testnet',
  priority: 10,
  enabled: false,
  minOrder: '10',
  maxOrder: '5000',
  supportedPairs: ['USDT/USD'],
  health: null,
  version: 2,
  updatedAt: '2026-10-14T10:00:00.000Z',
  updatedBy: USER,
  routable: false,
  missing: [],
};

const html = (element: unknown) => renderToStaticMarkup(element as never);
const sp = (v: Record<string, string> = {}) => Promise.resolve(v);

beforeEach(() => {
  configure();
});
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** Next's redirect() and notFound() throw; this reads where they point. */
async function outcome(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'rendered';
  } catch (e) {
    const digest = String((e as { digest?: string }).digest ?? '');
    if (digest.startsWith('NEXT_REDIRECT')) return `redirect:${digest.split(';')[2]}`;
    if (digest === 'NEXT_HTTP_ERROR_FALLBACK;404' || digest === 'NEXT_NOT_FOUND') return 'not-found';
    throw e;
  }
}

const PAGES: [string, () => Promise<unknown>][] = [
  ['/merchants', () => MerchantsHome({ searchParams: sp() })],
  ['/merchants/all', () => AllMerchants({ searchParams: sp() })],
  ['/merchants/[id]', () => MerchantDetail({ params: Promise.resolve({ id: MID }), searchParams: sp() })],
  ['/merchants/registries', () => RegistriesIndex()],
  ['/merchants/registries/[kind]', () => RegistryList({ params: Promise.resolve({ kind: 'venues' }) })],
  ['/merchants/registries/[kind]/new', () => RegistryNew({ params: Promise.resolve({ kind: 'venues' }) })],
  ['/merchants/registries/[kind]/[key]', () => RegistryEntry({ params: Promise.resolve({ kind: 'venues', key: 'binance-testnet' }) })],
  ['/merchants/treasury', () => Treasury()],
  ['layout', () => MerchantsLayout({ children: null })],
];

describe('G6: every Merchants page is founder-gated before it reads anything', () => {
  it.each(PAGES)('%s with no founder cookie redirects to /login and calls no service', async (_n, run) => {
    signedOut();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await outcome(run)).toBe('redirect:/login');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(PAGES)('%s with a forged cookie redirects to /login', async (_n, run) => {
    incoming = new Headers({ host: 'admin.example', cookie: '__Host-intafaced-admin=forged' });
    vi.stubGlobal('fetch', vi.fn());
    expect(await outcome(run)).toBe('redirect:/login');
  });

  it.each(PAGES)('%s for a signed-in user who is not a founder redirects to /login and reads no merchant data', async (_n, run) => {
    signIn();
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        seen.push(url);
        return Response.json({ result: { data: { json: { status: 'not_operator', userId: USER } } } });
      }),
    );
    expect(await outcome(run)).toBe('redirect:/login');
    expect(seen.every((u) => u.includes('accountControls.operatorStatus'))).toBe(true);
  });

  it.each(PAGES)('%s with the merchants module switched off redirects away without touching a service', async (_n, run) => {
    signIn();
    configure({ ADMIN_MODULES: 'crm' });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await outcome(run)).toBe('redirect:/crm');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a request that arrives on the wrong host is not served', async () => {
    signIn();
    incoming.set('host', 'evil.example');
    vi.stubGlobal('fetch', vi.fn());
    expect(await outcome(PAGES[0]![1])).toBe('redirect:/login');
  });
});

describe('dashboard', () => {
  beforeEach(signIn);

  it('shows real figures from decimal strings, per asset, with as-of and lag', async () => {
    services({ 'founderAdmin.metrics.global': globalMetrics });
    const out = html(await MerchantsHome({ searchParams: sp() }));
    expect(out).toContain('1,234.50');
    expect(out).toContain('USDT');
    expect(out).toContain('2026-10-15 10:00:00 UTC');
    expect(out).toContain('lag 4 s');
    expect(out).toContain('Pending KYB');
    expect(out).toContain('href="/merchants/all?kyb=pending"');
    expect(out).toContain('Onboarding funnel');
    expect(out).toContain('rail down');
    expect(out).toContain('Show as a table');
    expect(out).not.toMatch(/NaN|undefined|\[object/);
  });

  it('calls the service once per day for the chart and once for today, all as the founder', async () => {
    const seen = services({ 'founderAdmin.metrics.global': globalMetrics });
    await MerchantsHome({ searchParams: sp() });
    expect(seen).toHaveLength(7);
    expect(seen.every((u) => u.startsWith(`${EDGE}/api/pay/trpc/founderAdmin.metrics.global?input=`))).toBe(true);
  });

  it('says "not built yet" when the procedure is a stub, and invents no number', async () => {
    services({});
    const out = html(await MerchantsHome({ searchParams: sp() }));
    expect(out).toContain('Not built yet');
    expect(out).toContain('founderAdmin.metrics.global');
    expect(out).not.toContain('0.00');
  });

  it('shows an error, not an empty dashboard, when the service does not answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('operatorStatus')) return enabled();
        throw new Error('ECONNREFUSED');
      }),
    );
    const out = html(await MerchantsHome({ searchParams: sp() }));
    expect(out).toContain('role="alert"');
    expect(out).toContain('could not be loaded');
    expect(out).toContain('href="/merchants"');
  });

  it('an empty platform explains how the page fills in', async () => {
    services({
      'founderAdmin.metrics.global': {
        ...globalMetrics,
        volume: [],
        revenue: [],
        pendingSettlement: [],
        activeMerchants: 0,
        onboardingFunnel: [],
        railHealth: [],
      },
    });
    const out = html(await MerchantsHome({ searchParams: sp() }));
    expect(out).toContain('No payments in the last 7 days');
    expect(out).toContain('No merchants yet');
    expect(out).toContain('No rails reported');
  });

  it('a stale or unmeasured freshness is flagged, never shown as live', async () => {
    services({ 'founderAdmin.metrics.global': { ...globalMetrics, freshness: { asOf: null, lagSeconds: null } } });
    const out = html(await MerchantsHome({ searchParams: sp() }));
    expect(out).toContain('data-state="unknown"');
    expect(out).toContain('not shown as live');
    services({ 'founderAdmin.metrics.global': { ...globalMetrics, freshness: { asOf: '2026-10-15T09:00:00.000Z', lagSeconds: 3600 } } });
    expect(html(await MerchantsHome({ searchParams: sp() }))).toContain('data-state="stale"');
  });
});

describe('all merchants', () => {
  beforeEach(signIn);
  const row = {
    merchantId: MID,
    displayName: 'Acme Shop',
    status: 'active',
    tierId: null,
    kybStatus: 'approved',
    volume: [{ assetCode: 'USDT', amount: '1234.5' }],
    revenue: [],
    openFlags: 1,
  };

  it('lists merchants with chips, links, exact money, filters, pager and an accessible table', async () => {
    const seen = services({
      'founderAdmin.merchants.list': { freshness: fresh, rows: [row], nextCursor: 'NEXTC' },
      'founderAdmin.metrics.global': globalMetrics,
    });
    const out = html(await AllMerchants({ searchParams: sp({ status: 'active' }) }));
    expect(out).toContain(`href="/merchants/${MID}"`);
    expect(out).toContain('1,234.50');
    expect(out).toContain('title="Can take payments within its limits."');
    expect(out).toContain('KYB approved');
    expect(out).toContain('<caption');
    expect(out).toContain('aria-sort="ascending"');
    expect(out).toContain('Export CSV (1)');
    expect(out).toContain('href="/merchants/all?status=active&amp;cursor=NEXTC"');
    expect(out).toContain('The tier filter arrives with the control room');
    expect(decodeURIComponent(seen.find((u) => u.includes('merchants.list'))!)).toContain('"filter":{"status":"active"}');
    expect(decodeURIComponent(seen.find((u) => u.includes('merchants.list'))!)).toContain('"limit":50');
  });

  it('shows the merchant name first and the id second, and says "Unnamed merchant" in a muted style when there is no name', async () => {
    const other = '33333333-3333-4333-8333-333333333333';
    services({
      'founderAdmin.merchants.list': {
        freshness: fresh,
        rows: [row, { ...row, merchantId: other, displayName: null }],
        nextCursor: null,
      },
      'founderAdmin.metrics.global': globalMetrics,
    });
    const out = html(await AllMerchants({ searchParams: sp() }));
    expect(out).toMatch(
      new RegExp(
        `<a class="mp-id" href="/merchants/${MID}" title="${MID}"><bdi>Acme Shop</bdi></a><code[^>]*title="${MID}"[^>]*>${MID.slice(0, 8)}`,
      ),
    );
    expect(out).toContain(`<span class="mp-muted">Unnamed merchant</span>`);
    expect(out).toContain(`href="/merchants/${other}"`);
    expect(out).toContain(other.slice(0, 8));
  });

  it('renders a name that looks like markup as text, never as markup', async () => {
    services({
      'founderAdmin.merchants.list': {
        freshness: fresh,
        rows: [{ ...row, displayName: '<img src=x onerror=alert(1)> & Co' }],
        nextCursor: null,
      },
      'founderAdmin.metrics.global': globalMetrics,
    });
    const out = html(await AllMerchants({ searchParams: sp() }));
    expect(out).not.toContain('<img');
    expect(out).toContain('<bdi>&lt;img src=x onerror=alert(1)&gt; &amp; Co</bdi>');
  });

  it('isolates a right-to-left or override name inside <bdi>, so it cannot reorder the id beside it', async () => {
    const rtl = '\u202Edcba \u05D0\u05D1\u05D2';
    services({
      'founderAdmin.merchants.list': { freshness: fresh, rows: [{ ...row, displayName: rtl }], nextCursor: null },
      'founderAdmin.metrics.global': globalMetrics,
    });
    const out = html(await AllMerchants({ searchParams: sp() }));
    expect(out).toContain(`<bdi>${rtl}</bdi>`);
  });

  it('refuses a list row from the service that has no displayName field (strict contract)', async () => {
    const { displayName: _omitted, ...legacy } = row;
    services({
      'founderAdmin.merchants.list': { freshness: fresh, rows: [legacy], nextCursor: null },
      'founderAdmin.metrics.global': globalMetrics,
    });
    const out = html(await AllMerchants({ searchParams: sp() }));
    expect(out).not.toContain('Acme Shop');
    expect(out).toContain('role="alert"');
  });

  it('explains an empty list, differently with and without filters', async () => {
    services({
      'founderAdmin.merchants.list': { freshness: fresh, rows: [], nextCursor: null },
      'founderAdmin.metrics.global': globalMetrics,
    });
    expect(html(await AllMerchants({ searchParams: sp() }))).toContain('No merchant has been created yet');
    expect(html(await AllMerchants({ searchParams: sp({ kyb: 'rejected' }) }))).toContain('No merchant fits these filters');
  });

  it('keeps the page up when only the KPI counts fail', async () => {
    services({ 'founderAdmin.merchants.list': { freshness: fresh, rows: [row], nextCursor: null } });
    const out = html(await AllMerchants({ searchParams: sp() }));
    expect(out).toContain(MID.slice(0, 8));
    expect(out).not.toContain('Merchant counts');
  });

  it('shows not-built and a refused filter in words', async () => {
    services({});
    expect(html(await AllMerchants({ searchParams: sp() }))).toContain('Not built yet');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('operatorStatus')
          ? enabled()
          : Response.json(
              {
                error: { message: 'x', data: { code: 'BAD_REQUEST', httpStatus: 400, cause: { code: 'pay.metrics_filter_unsupported' } } },
              },
              { status: 400 },
            ),
      ),
    );
    const out = html(await AllMerchants({ searchParams: sp({ tier: 'gold' }) }));
    expect(out).toContain('role="alert"');
    expect(out).not.toContain('pay.metrics_filter_unsupported');
  });
});

describe('merchant drill-down', () => {
  beforeEach(signIn);
  const base = { 'founderAdmin.metrics.merchant': snapshot, 'founderAdmin.metrics.merchantSeries': series };
  const page = (q: Record<string, string> = {}) => MerchantDetail({ params: Promise.resolve({ id: MID }), searchParams: sp(q) });

  it('overview shows metrics, balances and the series chart, with the id copyable', async () => {
    services(base);
    const out = html(await page());
    expect(out).toContain(MID);
    expect(out).toContain('Copy id');
    expect(out).toContain('2,500.75');
    expect(out).toContain('Volume and fee revenue, last 30 days');
    expect(out).toContain('Not built yet'); // conversion volume
    expect(out).toContain('aria-current="page"');
  });

  const listRow = (displayName: string | null) => ({
    freshness: fresh,
    rows: [{ merchantId: MID, displayName, status: 'active', tierId: null, kybStatus: 'approved', volume: [], revenue: [], openFlags: 0 }],
    nextCursor: null,
  });

  it('puts the merchant name in the heading with the id as secondary text, and asks the service for exactly this merchant', async () => {
    const seen = services({ ...base, 'founderAdmin.merchants.list': listRow('Acme Shop') });
    const out = html(await page());
    expect(out).toMatch(
      /<h1><bdi>Acme Shop<\/bdi> <code[^>]*title="22222222-2222-4222-8222-222222222222"[^>]*>22222222…2222<\/code><\/h1>/,
    );
    expect(out).toContain(MID); // the full id stays in the identity facts, copyable
    expect(out).toContain('Copy id');
    const call = decodeURIComponent(seen.find((u) => u.includes('merchants.list'))!);
    expect(call).toContain(`"filter":{"merchantId":"${MID}"}`);
    expect(call).toContain('"limit":1');
  });

  it('says "Unnamed merchant" in a muted style when the merchant has no name', async () => {
    services({ ...base, 'founderAdmin.merchants.list': listRow(null) });
    const out = html(await page());
    expect(out).toContain('<h1><span class="mp-muted">Unnamed merchant</span>');
    expect(out).toContain('22222222…2222');
  });

  it('falls back to the id alone, without claiming "unnamed", when the name could not be read', async () => {
    services(base);
    const out = html(await page());
    expect(out).toContain('<h1>Merchant 22222222…2222');
    expect(out).not.toContain('Unnamed merchant');
  });

  it('shows the legal name from the drill-down once that procedure answers', async () => {
    services({
      ...base,
      'founderAdmin.merchants.list': listRow('Stale Name'),
      'founderAdmin.merchants.drilldown': {
        merchantId: MID,
        displayName: 'Acme Shop',
        legalName: 'Acme Trading Ltd',
        metrics: snapshot,
        control: {
          merchantId: MID,
          tierId: null,
          archetypeId: null,
          caps: null,
          pricing: null,
          reserve: null,
          version: '1',
          updatedAt: null,
        },
        halts: { readable: true, states: [] },
        pendingApprovals: [],
        operator: { kybStatus: 'approved', openFraudReviews: 0, parentMerchantId: null },
      },
    });
    const out = html(await page());
    expect(out).toContain('Acme Shop');
    expect(out).not.toContain('Stale Name');
    expect(out).toContain('Legal name');
    expect(out).toContain('Acme Trading Ltd');
  });

  it('payments and settlements tabs summarise from the same snapshot', async () => {
    services(base);
    const payments = html(await page({ tab: 'payments' }));
    expect(payments).toContain('Payments by status');
    expect(payments).toContain('captured');
    expect(payments).toContain('300.00');
    const settlements = html(await page({ tab: 'settlements' }));
    expect(settlements).toContain('693.00');
    expect(settlements).toContain('Settlements');
  });

  it('notes, controls, approvals and halts show an honest not-built state until the procedures exist', async () => {
    services(base);
    expect(html(await page({ tab: 'notes' }))).toContain('Notes are not built yet');
    for (const tab of ['controls', 'approvals', 'halts']) {
      const out = html(await page({ tab }));
      expect(out).toContain('arrives with W1 and W5');
    }
  });

  it('controls, approvals and halts render real data once the drilldown procedure answers', async () => {
    services({
      ...base,
      'founderAdmin.merchants.drilldown': {
        merchantId: MID,
        displayName: null,
        legalName: null,
        metrics: snapshot,
        control: {
          merchantId: MID,
          tierId: 'standard',
          archetypeId: null,
          caps: null,
          pricing: null,
          reserve: null,
          version: '3',
          updatedAt: null,
        },
        halts: {
          readable: true,
          autoTrip: { enabled: false, consecutiveFailures: null },
          states: [
            {
              scope: 'payout',
              target: { level: 'merchant', merchantId: MID },
              halted: true,
              reason: 'Review',
              source: 'operator',
              actorUserId: USER,
              version: '1',
              changedAt: null,
            },
          ],
        },
        pendingApprovals: [],
        operator: { kybStatus: 'approved', openFraudReviews: 0, parentMerchantId: null },
      },
    });
    expect(html(await page({ tab: 'controls' }))).toContain('Not configured (payments refuse)');
    expect(html(await page({ tab: 'approvals' }))).toContain('No payout for this merchant is waiting for approval');
    const halts = html(await page({ tab: 'halts' }));
    expect(halts).toContain('halted');
    expect(halts).toContain('This merchant');
  });

  it('an unknown merchant and a malformed id are the same not-found (no existence leak)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('operatorStatus')
          ? enabled()
          : Response.json(
              { error: { message: 'x', data: { code: 'NOT_FOUND', httpStatus: 404, cause: { code: 'pay.merchant_not_found' } } } },
              { status: 404 },
            ),
      ),
    );
    expect(await outcome(() => page())).toBe('not-found');
    expect(await outcome(() => MerchantDetail({ params: Promise.resolve({ id: 'not-a-uuid' }), searchParams: sp() }))).toBe('not-found');
  });

  it('a tab whose figures are not built shows that, even when another read succeeded', async () => {
    services({ 'founderAdmin.metrics.merchantSeries': series });
    const out = html(await page({ tab: 'payments' }));
    expect(out).toContain('Not built yet');
  });
});

describe('registries', () => {
  beforeEach(signIn);
  const list = (kind: string) => RegistryList({ params: Promise.resolve({ kind }) });

  it('lists entries with chips and a clear add action', async () => {
    services({ 'founderAdmin.registries.venues.list': [venue] });
    const out = html(await list('venues'));
    expect(out).toContain('Binance (testnet)');
    expect(out).toContain('href="/merchants/registries/venues/binance-testnet"');
    expect(out).toContain('href="/merchants/registries/venues/new"');
    expect(out).toContain('Approve a change from another founder');
    expect(out).toContain('10.00 to 5,000.00');
  });

  it('empty registries explain themselves and offer the first add', async () => {
    services({ 'founderAdmin.registries.networks.list': [] });
    const out = html(await list('networks'));
    expect(out).toContain('No networks yet');
    expect(out).toContain('Add the first network');
    expect(out).toContain('New entries start switched off');
  });

  it('a registry that is not mounted says so', async () => {
    services({});
    expect(html(await list('wallet-routes'))).toContain('Not built yet');
  });

  it('an unknown registry kind is not found', async () => {
    services({});
    expect(await outcome(() => list('secrets'))).toBe('not-found');
    expect(await outcome(() => RegistryNew({ params: Promise.resolve({ kind: 'x' }) }))).toBe('not-found');
  });

  it('the add form has labelled, described fields, required markers and no credential field', async () => {
    services({});
    const out = html(await RegistryNew({ params: Promise.resolve({ kind: 'venues' }) }));
    expect(out).toContain('<label for="rf-venueId">');
    expect(out).toContain('aria-describedby="rf-venueId-hint"');
    expect(out).toContain('Live (not allowed yet)');
    expect(out).toContain('Review change');
    expect(out).toContain('never stored here');
    const fieldIds = [...out.matchAll(/id="rf-([A-Za-z]+)"/g)].map((m) => m[1]!);
    expect(fieldIds.length).toBeGreaterThan(8);
    expect(fieldIds.filter((id) => /key|secret|password|token|credential/i.test(id))).toEqual([]);
  });

  it('the detail page loads the entry, locks its id, shows history and refuses a missing key', async () => {
    services({
      'founderAdmin.registries.venues.list': [venue],
      'founderAdmin.registries.history': [
        {
          id: '33333333-3333-4333-8333-333333333333',
          seq: '1',
          registry: 'venue',
          entryKey: 'binance-testnet',
          action: 'create',
          actorId: USER,
          approverId: null,
          dualControl: false,
          reason: 'First entry',
          createdAt: '2026-10-14T10:00:00.000Z',
        },
      ],
    });
    const out = html(await RegistryEntry({ params: Promise.resolve({ kind: 'venues', key: 'binance-testnet' }) }));
    expect(out).toContain('Version 2');
    expect(out).toContain('value="binance-testnet"');
    expect(out).toContain('First entry');
    expect(out).toContain('Created');
    expect(await outcome(() => RegistryEntry({ params: Promise.resolve({ kind: 'venues', key: 'nope' }) }))).toBe('not-found');
  });
});

describe('treasury and halts', () => {
  beforeEach(signIn);

  it('shows the not-built state for both reads while the procedures are stubs', async () => {
    services({});
    const out = html(await Treasury());
    expect(out.match(/Not built yet/g)?.length).toBe(2);
    expect(out).toContain('founderAdmin.treasury.exposure');
    expect(out).toContain('payHalts.history');
  });

  it('renders exposure and halts when the procedures answer, never reading a missing limit as unlimited', async () => {
    services({
      'founderAdmin.treasury.exposure': {
        freshness: fresh,
        perAsset: [
          { assetCode: 'USDT', openConversionInventory: '1000', pendingPayouts: '50.5', limit: null },
          { assetCode: 'EUR', openConversionInventory: null, pendingPayouts: '2', limit: '10' },
        ],
      },
      'payHalts.history': [
        {
          scope: 'conversion',
          target: { level: 'global' },
          halted: true,
          reason: 'Venue failing',
          source: 'auto_trip',
          actorUserId: null,
          confirmedByUserId: null,
          version: '4',
          changedAt: '2026-10-15T09:00:00.000Z',
        },
        {
          scope: 'payout',
          target: { level: 'global' },
          halted: false,
          reason: 'Rail repaired',
          source: 'operator',
          actorUserId: '11111111-1111-4111-8111-111111111111',
          confirmedByUserId: '22222222-2222-4222-8222-222222222222',
          version: '5',
          changedAt: '2026-10-15T10:00:00.000Z',
        },
      ],
    });
    const out = html(await Treasury());
    expect(out).toContain('1,000.00');
    expect(out).toContain('Not measured yet');
    expect(out).toContain('confirmed by a second founder');
    expect(out).toContain('Rail repaired');
    expect(out).toContain('Not set: conversions refuse');
    expect(out).toContain('Automatic trip');
    expect(out).toContain('Venue failing');
  });
});

describe('test-data label', () => {
  beforeEach(signIn);

  it.each(['dev', 'test', 'staging'])('the module header says "Test data" when APP_ENV is %s', async (appEnv) => {
    services({});
    configure({ APP_ENV: appEnv });
    const out = html(await MerchantsLayout({ children: null }));
    expect(out).toContain('data-testid="test-data-badge"');
    expect(out).toContain('Test data');
    expect(out).toContain('Not real money');
  });

  afterEach(() => {
    operatorEnvOverride.mode = 'real';
  });

  it('is absent in production', async () => {
    services({});
    configure();
    operatorEnvOverride.mode = 'prod';
    const out = html(await MerchantsLayout({ children: null }));
    expect(out).not.toContain('Test data');
    expect(out).not.toContain('test-data-badge');
    expect(out).toContain('Merchants sections');
  });

  it('shows the label when the environment cannot be read (the safe answer to "is this real?" is no)', async () => {
    services({});
    configure();
    operatorEnvOverride.mode = 'throws';
    const out = html(await MerchantsLayout({ children: null }));
    expect(out).toContain('data-testid="test-data-badge"');
  });
});
