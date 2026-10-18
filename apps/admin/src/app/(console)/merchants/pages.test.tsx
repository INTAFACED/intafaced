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
import Approvals from './approvals/page';
import MerchantsLayout from './layout';
import { notesFixture, pendingClearsFixture } from '@/testing/founder-read-fixtures';

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
function services(map: Record<string, unknown | ((url: string) => Response)>) {
  const seen: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.includes('accountControls.operatorStatus')) return enabled();
      seen.push(url);
      const proc = decodeURIComponent(url.split('/trpc/')[1] ?? '').split('?')[0]!;
      const handler = Object.entries(map).find(([k]) => proc === k)?.[1];
      if (handler === undefined) return notBuilt(proc);
      return typeof handler === 'function' ? (handler as (u: string) => Response)(url) : ok(handler);
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
    { railId: 'crypto-native', ok: false, detail: null },
    { railId: 'card-sandbox', ok: false, detail: '' },
    { railId: 'bank-payout', ok: false, detail: 'bank-payout has nothing configured.' },
    { railId: 'crypto-stale', ok: false, detail: 'rail.health_stale ageMs=45000' },
    { railId: 'card-test', ok: true, detail: 'rail.sandbox_only' },
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
  ['/merchants/approvals', () => Approvals({ searchParams: sp() })],
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
    expect(out).toContain('Crypto transfers');
    expect(out).toContain('Cards');
    expect(out).not.toMatch(/TEST sandbox/);
    expect(out).toContain('Bank payouts');
    expect(out).toContain('bank-payout has nothing configured.');
    // Both down rails that sent no reason say so, in words, instead of a dash.
    expect(out.match(/The rail did not report a reason\./g)?.length).toBe(2);
    expect(out).toContain('timeout');
    // The service's typed reasons read as words, never as the raw code.
    expect(out).toContain('No health report in the last 30 seconds (the last one was 45 seconds ago)');
    expect(out).toContain('Test acquirer only: it does not move real money');
    expect(out).not.toContain('rail.health_stale');
    expect(out).not.toContain('rail.sandbox_only');
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
    expect(out).toContain('Not switched on here');
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
    expect(out).toContain('The tier filter is not connected');
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
    expect(html(await AllMerchants({ searchParams: sp() }))).toContain('Not switched on here');
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
    expect(out).toContain('Not available'); // conversion volume
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
        status: 'active',
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
        halts: { readable: true, autoTrip: { enabled: false, consecutiveFailures: null }, states: [] },
        pendingApprovals: [],
        pendingLimitRequests: [],
        recentAudit: [],
        auditTruncated: false,
        operator: { kybStatus: 'approved', openFraudReviews: 0, parentMerchantId: null },
      },
    });
    const out = html(await page());
    expect(out).toContain('Acme Shop');
    expect(out).not.toContain('Stale Name');
    expect(out).toContain('Legal name');
    expect(out).toContain('Acme Trading Ltd');
  });

  describe('fee story', () => {
    const rule = (layer: 'global' | 'tier' | 'merchant', feeBps: number, flatFee: string | null = null) => ({
      layer,
      scopeId: layer === 'global' ? null : 'x',
      assetCode: 'USDT',
      bands: [{ fromAmount: '0', feeBps, flatFee }],
      spreadBps: null,
      roundingBeneficiary: 'platform',
    });
    const drilldown = (pricing: unknown) => ({
      'founderAdmin.merchants.drilldown': {
        merchantId: MID,
        displayName: 'Acme Shop',
        legalName: 'Acme Trading Ltd',
        status: 'active',
        metrics: snapshot,
        control: { merchantId: MID, tierId: null, archetypeId: null, caps: null, pricing, reserve: null, version: '1', updatedAt: null },
        halts: { readable: true, autoTrip: { enabled: false, consecutiveFailures: null }, states: [] },
        pendingApprovals: [],
        pendingLimitRequests: [],
        recentAudit: [],
        auditTruncated: false,
        operator: { kybStatus: 'approved', openFraudReviews: 0, parentMerchantId: null },
      },
    });

    it('shows the rule in force as a percent with a TEST chip, never as basis points, and says the settlement fee is the account rate', async () => {
      services({ ...base, ...drilldown([rule('global', 250), rule('merchant', 150)]) });
      const out = html(await page());
      expect(out).toContain('1.5%');
      expect(out).not.toContain('2.5%');
      expect(out).toContain('this merchant’s own rule');
      expect(out).toContain('>TEST<');
      expect(out).not.toMatch(/bps|No snapshot/);
      expect(out).toContain('Pricing rule');
      expect(out).not.toContain('The fee this merchant pays');
      expect(out).toContain('The fee taken at settlement is the rate on the merchant’s account, which this console does not read.');
    });

    it('keeps the account-rate line when a payment has settled', async () => {
      services({
        'founderAdmin.metrics.merchant': { ...snapshot, statusMix: [{ status: 'settled', count: 2 }] },
        'founderAdmin.metrics.merchantSeries': series,
        ...drilldown([rule('global', 250)]),
      });
      const out = html(await page());
      expect(out).toContain('2.5%');
      expect(out).toContain('rate on the merchant’s account');
    });

    it('says the account fee is outside the pricing rules rather than inventing a fee', async () => {
      services({ ...base, ...drilldown(null) });
      const out = html(await page());
      expect(out).toContain('The merchant’s own fee is set on its account; this console’s pricing rules do not include it.');
      expect(out).toContain('rate on the merchant’s account');
    });
  });

  it('shows caps unreadable for a pending ask whose caps are not a cap, and still shows the merchant', async () => {
    services({
      ...base,
      'founderAdmin.merchants.list': listRow('Stale Name'),
      'founderAdmin.merchants.drilldown': {
        merchantId: MID,
        displayName: 'Acme Shop',
        legalName: 'Acme Trading Ltd',
        status: 'active',
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
        halts: { readable: true, autoTrip: { enabled: false, consecutiveFailures: null }, states: [] },
        pendingApprovals: [],
        pendingLimitRequests: [
          {
            requestId: '33333333-3333-4333-8333-333333333333',
            merchantId: MID,
            caps: { raw: [{ kind: 'not-a-cap', marker: 'raw-cap-marker' }], capsReadable: false },
            reason: 'stored ask',
            status: 'pending',
            requestedBy: USER,
            createdAt: '2026-10-16T00:00:00.000Z',
          },
        ],
        recentAudit: [],
        auditTruncated: false,
        operator: { kybStatus: 'approved', openFraudReviews: 0, parentMerchantId: null },
      },
    });
    const out = html(await page());
    expect(out).toContain('caps unreadable');
    expect(out).toContain('Acme Trading Ltd');
    expect(out).not.toContain('raw-cap-marker');
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
    const notes = html(await page({ tab: 'notes' }));
    expect(notes).toContain('founderAdmin.ops.notes.list');
    expect(notes).toContain('Not switched on here');
    expect(notes).not.toContain('Notes are not built yet');
    const controls = html(await page({ tab: 'controls' }));
    expect(controls).toContain('founderAdmin.control.merchant.get');
    expect(controls).toContain('Not switched on here');
    expect(html(await page({ tab: 'approvals' }))).toContain('founderAdmin.approvals.list');
    expect(html(await page({ tab: 'halts' }))).toContain('payHalts.operatorStatus');
  });

  it('the Notes tab lists the operator notes from founderAdmin.ops.notes.list, filters included', async () => {
    const seen = services({ ...base, 'founderAdmin.ops.notes.list': notesFixture });
    const out = html(await MerchantDetail({ params: Promise.resolve({ id: MID }), searchParams: sp({ tab: 'notes', flagged: '1' }) }));
    expect(out).toContain('Asked for a higher cap; hold until KYB refresh (TEST DATA)');
    expect(out).toContain('Add note');
    expect(out).toContain('Retract');
    expect(seen.some((u) => u.includes('ops.notes.list') && decodeURIComponent(u).includes('"flaggedOnly":true'))).toBe(true);
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
    expect(out).toContain('Not switched on here');
  });
});

// ── W4b: controls, approvals and halts ─────────────────────────────────────

const OTHER = '99999999-9999-4999-8999-999999999999';
const HASH = `sha256:${'d'.repeat(64)}`;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const ahead = (ms: number) => new Date(Date.now() + ms).toISOString();
const HOUR = 3_600_000;

const tierRow = {
  id: 'standard',
  name: 'Standard',
  archetype: 'standard',
  caps: [{ kind: 'daily_intake', assetCode: 'USDT', limit: '1000' }],
  reserve: null,
  approvalThresholds: [{ assetCode: 'USDT', amount: '100' }],
  founderThresholds: [{ assetCode: 'USDT', amount: '1000' }],
  approvalTtlSeconds: 86_400,
  version: '2',
  merchants: 3,
};
const merchantRule = {
  layer: 'merchant',
  scopeId: MID,
  assetCode: 'USDT',
  bands: [{ fromAmount: '0', feeBps: 150, flatFee: '0.3' }],
  spreadBps: null,
  roundingBeneficiary: 'platform',
};
const profile = {
  merchantId: MID,
  tierId: 'standard',
  archetypeId: 'standard',
  caps: [
    { kind: 'daily_intake', assetCode: 'USDT', limit: '1000' },
    { kind: 'per_payment', assetCode: 'USDT', limit: '50' },
    { kind: 'beneficiaries_per_day', limit: 3 },
  ],
  pricing: [merchantRule],
  reserve: { rollingReserveBps: 500, holdDays: 7 },
  version: '4',
  updatedAt: '2026-10-14T10:00:00.000Z',
};
const unconfiguredProfile = {
  merchantId: MID,
  tierId: null,
  archetypeId: null,
  caps: null,
  pricing: null,
  reserve: null,
  version: '0',
  updatedAt: null,
};
const usageView = {
  merchantId: MID,
  tierId: 'standard',
  asOf: '2026-10-15T10:00:00.000Z',
  rows: [
    { kind: 'daily_intake', assetCode: 'USDT', limit: '1000', used: '850', remaining: '150', resetsAt: '2026-10-16T00:00:00.000Z' },
    { kind: 'per_payment', assetCode: 'USDT', limit: '50', used: null, remaining: null, resetsAt: null },
    { kind: 'beneficiaries_per_day', assetCode: null, limit: '3', used: '1', remaining: '2', resetsAt: '2026-10-16T00:00:00.000Z' },
  ],
};
const ruleView = (layer: string, scopeId: string | null, bps: number) => ({
  ruleId: '77777777-7777-4777-8777-777777777777',
  layer,
  scopeId,
  assetCode: 'USDT',
  bands: [{ fromAmount: '0', feeBps: bps, flatFee: null }],
  spreadBps: null,
  roundingBeneficiary: layer === 'global' ? 'merchant' : 'platform',
  minFee: null,
  maxFee: null,
  version: '1',
  createdAt: '2026-10-13T10:00:00.000Z',
});
const rulesByLayer = (url: string) => {
  const input = JSON.parse(decodeURIComponent(new URL(url).searchParams.get('input') ?? '{}')) as { layer?: string };
  const rows =
    input.layer === 'global'
      ? [ruleView('global', null, 200)]
      : input.layer === 'tier'
        ? [ruleView('tier', 'standard', 175)]
        : [ruleView('merchant', MID, 150)];
  return ok(rows);
};
const controlsBase = {
  'founderAdmin.metrics.merchant': snapshot,
  'founderAdmin.metrics.merchantSeries': series,
  'founderAdmin.control.merchant.get': profile,
  'founderAdmin.control.merchant.usage': usageView,
  'founderAdmin.control.tiers.list': [tierRow],
  'founderAdmin.control.pricing.rules': rulesByLayer,
};

const approvalRow = (n: number, over: Record<string, unknown> = {}) => ({
  approvalId: `0000000${n}-0000-4000-8000-000000000000`,
  merchantId: n === 2 ? 'a0000002-0000-4000-8000-000000000002' : MID,
  settlementId: `5000000${n}-0000-4000-8000-000000000000`,
  amount: '1200.5',
  assetCode: 'USDT',
  payloadHash: HASH,
  status: 'pending',
  makerUserId: OTHER,
  checkerUserId: OTHER,
  railId: 'crypto-native',
  destinationKind: 'crypto',
  destinationMasked: '0x0000…0f01',
  founderFirstUserId: null,
  createdAt: ago(3 * HOUR),
  decidedAt: null,
  expiresAt: ahead(9 * HOUR + 30 * 60_000),
  ...over,
});
const queue = (approvals: unknown[], nextCursor: string | null = null) => ({ approvals, nextCursor });
const namesFor = (url: string) => {
  const input = JSON.parse(decodeURIComponent(new URL(url).searchParams.get('input') ?? '{}')) as { filter?: { merchantId?: string } };
  const id = input.filter?.merchantId ?? '';
  const named: Record<string, string | null> = { [MID]: 'Acme Shop', 'a0000002-0000-4000-8000-000000000002': null };
  return ok({
    freshness: fresh,
    rows:
      id in named
        ? [
            {
              merchantId: id,
              displayName: named[id],
              status: 'active',
              tierId: null,
              kybStatus: 'approved',
              volume: [],
              revenue: [],
              openFlags: 0,
            },
          ]
        : [],
    nextCursor: null,
  });
};

const haltState = (over: Record<string, unknown> = {}) => ({
  scope: 'payout',
  target: { level: 'global' },
  halted: false,
  reason: null,
  source: null,
  actorUserId: null,
  version: '0',
  changedAt: null,
  ...over,
});
const haltEvent = (over: Record<string, unknown> = {}) => ({ ...haltState(), confirmedByUserId: null, ...over });
const operatorStatus = (over: Record<string, unknown> = {}) => ({
  readable: true,
  autoTrip: { enabled: false, consecutiveFailures: null },
  states: [
    haltState({ scope: 'intake' }),
    haltState({ scope: 'conversion' }),
    haltState({ scope: 'payout' }),
    haltState({ scope: 'settlement' }),
  ],
  ...over,
});

describe('merchant drill-down: Controls tab', () => {
  beforeEach(signIn);
  const page = (q: Record<string, string> = {}) =>
    MerchantDetail({ params: Promise.resolve({ id: MID }), searchParams: sp({ tab: 'controls', ...q }) });

  it('shows tier, caps with usage, layered pricing, reserve and the approval rules, each with an as-of time', async () => {
    services(controlsBase);
    const out = html(await page());
    expect(out).toContain('Standard');
    expect(out).toContain('Controls as of');
    expect(out).toContain('Usage as of 2026-10-15 10:00:00 UTC');
    // caps with usage
    expect(out).toContain('Money in per day');
    expect(out).toContain('850.00');
    expect(out).toContain('near the cap');
    expect(out).toContain('checked per payment');
    expect(out).toContain('New payout destinations per day');
    expect(out).toContain('2026-10-16 00:00:00 UTC');
    // layered pricing: merchant wins, tier and global are shown as overridden
    expect(out).toContain('1.50% (150 bps)');
    expect(out).toContain('1.75% (175 bps)');
    expect(out).toContain('2.00% (200 bps)');
    expect(out).toContain('in force');
    expect(out).toContain('overridden');
    expect(out).toContain('The most specific layer wins');
    // reserve and approval rules
    expect(out).toContain('5.00% (500 bps) held for 7 days');
    expect(out).toContain('Also needs two founders from');
    expect(out).toContain('1,000.00 USDT');
    expect(out).toContain('1 day');
    expect(out).not.toMatch(/NaN|undefined|\[object/);
  });

  it('asks for exactly this merchant, reads the tier layer only because a tier exists, and only reads', async () => {
    const seen = services(controlsBase);
    await page();
    const control = seen.filter((u) => u.includes('founderAdmin.control.'));
    expect(control.some((u) => u.includes('merchant.get') && u.includes(MID))).toBe(true);
    expect(control.some((u) => u.includes('merchant.usage') && u.includes(MID))).toBe(true);
    const layers = control
      .filter((u) => u.includes('pricing.rules'))
      .map((u) => JSON.parse(decodeURIComponent(new URL(u).searchParams.get('input')!)));
    expect(layers).toEqual(
      expect.arrayContaining([{ layer: 'global' }, { layer: 'merchant', scopeId: MID }, { layer: 'tier', scopeId: 'standard' }]),
    );
    expect(seen.every((u) => !u.includes('changes.submit') && !u.includes('changes.confirm') && !u.includes('approvals.decide'))).toBe(
      true,
    );
    services({ ...controlsBase, 'founderAdmin.control.merchant.get': unconfiguredProfile });
    const none = services({ ...controlsBase, 'founderAdmin.control.merchant.get': unconfiguredProfile });
    await page();
    expect(none.some((u) => u.includes('pricing.rules') && u.includes('tier'))).toBe(false);
  });

  it('a merchant nobody configured says "not configured: payments refuse" everywhere and shows no number', async () => {
    services({
      ...controlsBase,
      'founderAdmin.control.merchant.get': unconfiguredProfile,
      'founderAdmin.control.merchant.usage': { ...usageView, tierId: null, rows: [] },
      'founderAdmin.control.tiers.list': [],
      'founderAdmin.control.pricing.rules': [],
    });
    const out = html(await page());
    expect(out).toContain('Not set: payments refuse');
    expect(out).toContain('Not configured: payments refuse');
    expect(out).toContain('Caps are not configured: payments refuse');
    expect(out).toContain('Pricing is not configured: payments refuse');
    expect(out).toContain('No tier, so no approval rules: payouts refuse');
    expect(out).toContain('not fully configured');
    expect(out).not.toMatch(/\d+\.\d\d (USDT|USD)/);
  });

  it('says what this tab does not list instead of inventing it: history, pending changes and over-cap captures', async () => {
    services(controlsBase);
    const out = html(await page());
    expect(out).toContain('Who changed what is on the Activity and audit page');
    expect(out).toContain('Pending changes are not listed on this tab');
    expect(out).toContain('Captures over a cap');
    expect(out).toContain('Captures over a cap are not listed on this tab');
    expect(out).toContain('Version of this merchant’s controls');
  });

  it('puts the two-founder change form and the second-founder confirm panel on the page', async () => {
    services(controlsBase);
    const out = html(await page());
    expect(out).toContain('Every change needs two different founders');
    expect(out).toContain('Review change');
    expect(out).toContain('Confirm a change from another founder');
    expect(out).toContain('Version 4 of this merchant');
  });

  it('turns the change form off, with a reason, when the controls cannot be read', async () => {
    services({ ...controlsBase, 'founderAdmin.control.merchant.get': 'nonsense' });
    const out = html(await page());
    expect(out).toContain('could not be read');
    expect(out).toContain('Changes are off while the controls cannot be read');
    expect(out).not.toContain('Review change');
  });

  it('a service that does not answer is an error with a retry, not an empty tab', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('operatorStatus')) return enabled();
        if (url.includes('founderAdmin.metrics')) return ok(url.includes('merchantSeries') ? series : snapshot);
        throw new Error('ECONNREFUSED');
      }),
    );
    const out = html(await page());
    expect(out).toContain('role="alert"');
    expect(out).toContain('could not be loaded');
    expect(out).toContain('Try again');
  });

  it('a procedure that is not switched on is "not built yet" with its name, and the rest of the tab still renders', async () => {
    services({ ...controlsBase, 'founderAdmin.control.merchant.usage': () => notBuilt('founderAdmin.control.merchant.usage') });
    const out = html(await page());
    expect(out).toContain('founderAdmin.control.merchant.usage');
    expect(out).toContain('Standard');
  });

  it('keeps the Test data badge and the merchant name in the page', async () => {
    services({
      ...controlsBase,
      'founderAdmin.merchants.list': {
        freshness: fresh,
        rows: [
          {
            merchantId: MID,
            displayName: 'Acme Shop',
            status: 'active',
            tierId: null,
            kybStatus: 'approved',
            volume: [],
            revenue: [],
            openFlags: 0,
          },
        ],
        nextCursor: null,
      },
    });
    const out = html(await page());
    expect(out).toContain('Acme Shop');
    const layout = html(await MerchantsLayout({ children: null }));
    expect(layout).toContain('Test data');
  });
});

describe('merchant drill-down: Approvals tab', () => {
  beforeEach(signIn);
  const base = { 'founderAdmin.metrics.merchant': snapshot, 'founderAdmin.metrics.merchantSeries': series };
  const page = () => MerchantDetail({ params: Promise.resolve({ id: MID }), searchParams: sp({ tab: 'approvals' }) });

  it('lists only this merchant’s payouts that wait for two founders, with age, time left and the decision button', async () => {
    services({ ...base, 'founderAdmin.approvals.list': queue([approvalRow(1), approvalRow(2)]) });
    const out = html(await page());
    expect(out).toContain('1,200.50 USDT');
    expect(out).toContain('waiting 3 h');
    expect(out).toContain('expires in 9 h');
    expect(out).toContain('Review and decide');
    expect(out.match(/Review and decide/g)).toHaveLength(1);
    expect(out).toContain('Approvals as of');
    expect(out).toContain('Open the full queue');
  });

  it('says nothing is waiting, and what is not listed, when the queue has nothing for this merchant', async () => {
    services({ ...base, 'founderAdmin.approvals.list': queue([approvalRow(2)]) });
    const out = html(await page());
    expect(out).toContain('Nothing waiting for founders');
    expect(out).toContain('no founder-readable list for that earlier step');
  });

  it('follows the queue’s pages but stops, and says so, when it is longer than one read covers', async () => {
    const seen = services({ ...base, 'founderAdmin.approvals.list': () => ok(queue([approvalRow(2)], '99')) });
    const out = html(await page());
    expect(seen.filter((u) => u.includes('approvals.list'))).toHaveLength(5);
    expect(out).toContain('may have more waiting');
  });

  it('an error is an error, a stub is "not built yet", a refusal is plain English', async () => {
    services(base);
    expect(html(await page())).toContain('founderAdmin.approvals.list');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('operatorStatus')
          ? enabled()
          : url.includes('founderAdmin.metrics')
            ? ok(url.includes('merchantSeries') ? series : snapshot)
            : Response.json(
                { error: { message: 'x', data: { code: 'FORBIDDEN', httpStatus: 403, cause: { code: 'pay.approval_forbidden' } } } },
                { status: 403 },
              ),
      ),
    );
    const out = html(await page());
    expect(out).toContain('You cannot decide this approval');
    expect(out).not.toContain('pay.approval_forbidden');
  });
});

describe('merchant drill-down: Halts tab', () => {
  beforeEach(signIn);
  const base = { 'founderAdmin.metrics.merchant': snapshot, 'founderAdmin.metrics.merchantSeries': series };
  const page = () => MerchantDetail({ params: Promise.resolve({ id: MID }), searchParams: sp({ tab: 'halts' }) });
  const other = 'a0000002-0000-4000-8000-000000000002';

  it('shows the switches that apply to this merchant (global and its own, not another merchant’s), the auto-trip setting and the history', async () => {
    const seen = services({
      ...base,
      'payHalts.operatorStatus': operatorStatus({
        states: [
          haltState({
            scope: 'payout',
            halted: true,
            reason: 'Venue failing',
            source: 'operator',
            actorUserId: USER,
            version: '2',
            changedAt: '2026-10-15T09:00:00.000Z',
          }),
          haltState({
            scope: 'intake',
            target: { level: 'merchant', merchantId: MID },
            halted: true,
            reason: 'Review',
            source: 'operator',
            actorUserId: USER,
            version: '1',
            changedAt: '2026-10-15T08:00:00.000Z',
          }),
          haltState({
            scope: 'settlement',
            target: { level: 'merchant', merchantId: other },
            halted: true,
            reason: 'Someone else',
            source: 'operator',
            actorUserId: USER,
            version: '1',
          }),
        ],
      }),
      'payHalts.history': [
        haltEvent({
          scope: 'intake',
          target: { level: 'merchant', merchantId: MID },
          halted: true,
          reason: 'Review',
          source: 'operator',
          actorUserId: USER,
          version: '1',
          changedAt: '2026-10-15T08:00:00.000Z',
        }),
      ],
    });
    const out = html(await page());
    expect(out).toContain('Venue failing');
    expect(out).toContain('Review');
    expect(out).not.toContain('Someone else');
    expect(out).toContain('Automatic trip is off');
    expect(out).toContain('Clears waiting for a second founder');
    expect(out).toContain('Switches as of');
    const history = seen.find((u) => u.includes('payHalts.history'))!;
    expect(JSON.parse(decodeURIComponent(new URL(history).searchParams.get('input')!))).toEqual({
      target: { level: 'merchant', merchantId: MID },
      limit: 50,
    });
  });

  it('an unreadable halt store counts as halted, and no history is an empty state that says how it fills', async () => {
    services({ ...base, 'payHalts.operatorStatus': operatorStatus({ readable: false, states: [] }), 'payHalts.history': [] });
    const out = html(await page());
    expect(out).toContain('The halt store could not be read');
    expect(out).toContain('counts as halted');
    expect(out).toContain('No halts recorded for this merchant');
  });

  it('a stub is "not built yet" for both reads', async () => {
    services(base);
    const out = html(await page());
    expect(out).toContain('payHalts.operatorStatus');
    expect(out).toContain('payHalts.history');
    expect(out).toContain('payHalts.pendingClears');
  });
});

describe('founder approvals queue', () => {
  beforeEach(signIn);
  const listed = (approvals: unknown[]) => ({ 'founderAdmin.approvals.list': queue(approvals), 'founderAdmin.merchants.list': namesFor });
  const page = (q: Record<string, string> = {}) => Approvals({ searchParams: sp(q) });

  it('shows the KPI strip, merchant names, age and time-left chips, and one decision button per row', async () => {
    services(listed([approvalRow(1), approvalRow(2, { createdAt: ago(8 * HOUR), expiresAt: ahead(1 * HOUR) })]));
    const out = html(await page());
    expect(out).toContain('Founder approvals');
    expect(out).toContain('Waiting for founders');
    expect(out).toContain('Oldest request');
    expect(out).toContain('Running out of time');
    expect(out).toContain('You took part in');
    expect(out).toContain('Acme Shop');
    expect(out).toContain('Unnamed merchant');
    expect(out).toMatch(/waiting 3 h \d+ min/);
    expect(out).toMatch(/expires in 9 h \d+ min/);
    expect(out).toMatch(/expires in (0 h )?\d+ min|expires in 1 h/);
    expect(out).toContain('Queue as of');
    expect(out).toContain('Showing 2 of 2 waiting');
    expect(out.match(/Review and decide/g)).toHaveLength(2);
    expect(out).toContain('Export CSV (2)');
    expect(out).toContain('href="/merchants/22222222-2222-4222-8222-222222222222?tab=approvals"');
  });

  it('works out “running out of time” from each request’s own window, so the second row is flagged and the first is not', async () => {
    services(listed([approvalRow(1), approvalRow(2, { createdAt: ago(8 * HOUR), expiresAt: ahead(1 * HOUR) })]));
    const out = html(await page({ urgent: '1' }));
    expect(out).toContain('Showing 1 of 2 waiting');
    expect(out).not.toContain('Acme Shop');
  });

  it('filters by name, by asset, and says when nothing matches with a way back', async () => {
    services(listed([approvalRow(1), approvalRow(2, { assetCode: 'EUR' })]));
    expect(html(await page({ q: 'acme' }))).toContain('Showing 1 of 2 waiting');
    expect(html(await page({ asset: 'EUR' }))).toContain('Showing 1 of 2 waiting');
    const none = html(await page({ q: 'zzz-nobody' }));
    expect(none).toContain('Nothing matches these filters');
    expect(none).toContain('Clear filters');
    expect(none).toContain('href="/merchants/approvals"');
  });

  it('a payout you asked for or approved cannot be signed by you, and the row says why', async () => {
    services(listed([approvalRow(1, { makerUserId: USER })]));
    const out = html(await page());
    expect(out).toContain('A different founder must sign it');
    expect(out).toMatch(/<button[^>]*disabled[^>]*>Review and decide/);
  });

  it('an empty queue explains how it fills', async () => {
    services(listed([]));
    const out = html(await page());
    expect(out).toContain('No payouts are waiting for founders');
    expect(out).toContain('Showing 0 of 0 waiting');
    expect(out).toContain('None waiting');
  });

  it('an expired request cannot be decided', async () => {
    services(listed([approvalRow(1, { createdAt: ago(5 * HOUR), expiresAt: ago(1 * HOUR) })]));
    const out = html(await page());
    expect(out).toContain('>expired<');
    expect(out).toContain('ran out of time');
  });

  it('keeps working without names: the id identifies the row', async () => {
    services({ 'founderAdmin.approvals.list': queue([approvalRow(1)]) });
    const out = html(await page());
    expect(out).toContain('Unnamed merchant');
    expect(out).toContain('22222222…2222');
  });

  it('a stub is "not built yet", a dead service is an error with a retry, an unknown shape is "could not be read"', async () => {
    services({});
    const stub = html(await page());
    expect(stub).toContain('Not switched on here');
    expect(stub).toContain('founderAdmin.approvals.list');
    expect(stub).not.toContain('Waiting for founders');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('operatorStatus')) return enabled();
        throw new Error('ECONNREFUSED');
      }),
    );
    const down = html(await page());
    expect(down).toContain('role="alert"');
    expect(down).toContain('href="/merchants/approvals"');
    services({ 'founderAdmin.approvals.list': { approvals: 'many' } });
    expect(html(await page())).toContain('could not be read');
  });

  it('reads whole pages of the queue and says so when it is longer than it reads', async () => {
    const seen = services({
      'founderAdmin.approvals.list': () => ok(queue([approvalRow(1)], '7')),
      'founderAdmin.merchants.list': namesFor,
    });
    const out = html(await page());
    expect(seen.filter((u) => u.includes('approvals.list'))).toHaveLength(5);
    expect(out).toContain('Showing the oldest part of a longer queue');
  });

  it('is in the Merchants section navigation', async () => {
    services({});
    const layout = html(await MerchantsLayout({ children: null }));
    expect(layout).toContain('href="/merchants/approvals"');
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
    expect(html(await list('wallet-routes'))).toContain('Not switched on here');
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
    expect(out).toContain('Live (not allowed)');
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
    expect(out.match(/Not switched on here/g)?.length).toBe(5);
    expect(out).toContain('founderAdmin.treasury.exposure');
    expect(out).toContain('payHalts.history');
    expect(out).toContain('payHalts.operatorStatus');
    expect(out).not.toContain('Pending halt clears are not available yet');
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
    expect(out).toContain('Not measured');
    expect(out).toContain('confirmed by a second founder');
    expect(out).toContain('Rail repaired');
    expect(out).toContain('Not set: conversions refuse');
    expect(out).toContain('Automatic trip');
    expect(out).toContain('Venue failing');
  });

  const exposure = {
    freshness: fresh,
    perAsset: [
      { assetCode: 'USDT', openConversionInventory: '1000', pendingPayouts: '50.5', limit: null },
      { assetCode: 'EUR', openConversionInventory: null, pendingPayouts: '2', limit: '10' },
    ],
  };

  it('summarises limits and halts in a KPI strip, each with an as-of time', async () => {
    services({
      'founderAdmin.treasury.exposure': exposure,
      'payHalts.history': [],
      'payHalts.operatorStatus': operatorStatus({
        states: [
          haltState({
            scope: 'payout',
            halted: true,
            reason: 'x',
            source: 'operator',
            actorUserId: USER,
            version: '1',
            changedAt: '2026-10-15T09:00:00.000Z',
          }),
          haltState({ scope: 'intake' }),
        ],
      }),
    });
    const out = html(await Treasury());
    expect(out).toContain('Assets with an exposure limit');
    expect(out).toContain('1 of 2');
    expect(out).toContain('Assets with no limit');
    expect(out).toContain('Operations halted');
    expect(out).toMatch(/As of 2026-10-15 10:00:00 UTC/);
    expect(out).toContain('Conversions refuse for these');
  });

  it('shows the auto-trip posture: off means nothing pauses by itself, on states the count of failures', async () => {
    services({ 'founderAdmin.treasury.exposure': exposure, 'payHalts.history': [], 'payHalts.operatorStatus': operatorStatus() });
    const off = html(await Treasury());
    expect(off).toContain('Automatic trip is off');
    expect(off).toContain('no default one');
    services({
      'founderAdmin.treasury.exposure': exposure,
      'payHalts.history': [],
      'payHalts.operatorStatus': operatorStatus({ autoTrip: { enabled: true, consecutiveFailures: 4 } }),
    });
    const on = html(await Treasury());
    expect(on).toContain('4 failures in a row');
    expect(on).toContain('After 4 failures');
  });

  it('lists the halt switches now, and reads an unreadable store as halted', async () => {
    services({ 'founderAdmin.treasury.exposure': exposure, 'payHalts.history': [], 'payHalts.operatorStatus': operatorStatus() });
    const out = html(await Treasury());
    expect(out).toContain('Halt switches now');
    for (const label of ['Taking payments', 'Converting currency', 'Paying out', 'Settling to merchants']) expect(out).toContain(label);
    services({
      'founderAdmin.treasury.exposure': exposure,
      'payHalts.history': [],
      'payHalts.operatorStatus': operatorStatus({ readable: false, states: [] }),
    });
    const bad = html(await Treasury());
    expect(bad).toContain('The halt store could not be read');
    expect(bad).toContain('counts as halted');
  });

  it('lists the clears waiting for a second founder from payHalts.pendingClears and says the halt is still on', async () => {
    const seen = services({
      'founderAdmin.treasury.exposure': exposure,
      'payHalts.history': [],
      'payHalts.operatorStatus': operatorStatus(),
      'payHalts.pendingClears': pendingClearsFixture,
    });
    const out = html(await Treasury());
    expect(out).toContain('Halt clears waiting for a second founder');
    expect(out).toContain('Rail repaired, retesting (TEST DATA)');
    expect(out).toContain('The halt is still on for every row above');
    expect(out).not.toContain('not available yet');
    expect(out).not.toContain('no read for it');
    expect(seen.some((u) => u.includes('payHalts.pendingClears'))).toBe(true);
  });

  it('a failed pending-clears read is a named error with Try again, not an empty list', async () => {
    services({
      'founderAdmin.treasury.exposure': exposure,
      'payHalts.history': [],
      'payHalts.operatorStatus': operatorStatus(),
      'payHalts.pendingClears': () => Response.json({ error: { message: 'down' } }, { status: 503 }),
    });
    const out = html(await Treasury());
    expect(out).toContain('Clears waiting for a second founder could not be loaded');
    expect(out).toContain('Try again');
  });

  it('history names the second founder on a clear, says "(you)" for the signed-in founder and flags a clear with no second founder', async () => {
    services({
      'founderAdmin.treasury.exposure': exposure,
      'payHalts.operatorStatus': operatorStatus(),
      'payHalts.history': [
        haltEvent({
          scope: 'payout',
          halted: false,
          reason: 'Rail repaired',
          source: 'operator',
          actorUserId: USER,
          confirmedByUserId: OTHER,
          version: '5',
          changedAt: '2026-10-15T10:00:00.000Z',
        }),
        haltEvent({
          scope: 'intake',
          halted: false,
          reason: 'Odd clear',
          source: 'operator',
          actorUserId: OTHER,
          confirmedByUserId: null,
          version: '4',
          changedAt: '2026-10-15T09:00:00.000Z',
        }),
        haltEvent({
          scope: 'conversion',
          halted: true,
          reason: 'Venue failing',
          source: 'auto_trip',
          version: '3',
          changedAt: '2026-10-15T08:00:00.000Z',
        }),
      ],
    });
    const out = html(await Treasury());
    expect(out).toContain('confirmed by a second founder');
    expect(out).toContain('(you)');
    expect(out).toContain('no second founder recorded');
    expect(out).toContain('Automatic trip');
    expect(out).toContain('History as of');
  });

  it('a dead service shows errors with retries, never an empty page', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('operatorStatus')) return enabled();
        throw new Error('ECONNREFUSED');
      }),
    );
    const out = html(await Treasury());
    expect(out).toContain('role="alert"');
    expect(out.match(/Try again/g)!.length).toBeGreaterThanOrEqual(4);
    expect(out).not.toContain('0.00');
  });

  it('is read only: the page does not call any write procedure', async () => {
    const seen = services({
      'founderAdmin.treasury.exposure': exposure,
      'payHalts.history': [],
      'payHalts.operatorStatus': operatorStatus(),
    });
    await Treasury();
    expect(seen.every((u) => /treasury\.exposure|payHalts\.(history|operatorStatus|pendingClears)/.test(u))).toBe(true);
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
