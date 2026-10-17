import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { founderCookie, sealFounderSession, type FounderSession } from '@/lib/founder-session';
import { DRILLDOWN } from '@/lib/founder-ops/screens';
import { SCREEN_SECTIONS } from '@/lib/founder-ops/read-model';
import { BIG, founderReadService, notesFixture, sectionFixture, TEST_MERCHANT, TEST_OTHER_MERCHANT } from '@/testing/founder-read-fixtures';

let incoming = new Headers();
vi.mock('next/headers', () => ({ headers: async () => incoming }));
vi.mock('next/navigation', async (original) => ({
  ...(await original<typeof import('next/navigation')>()),
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
import FounderOpsPage from '@/app/(console)/[...founderPath]/page';
import { AddNoteForm } from './note-forms';
import DrilldownPage from '@/app/(console)/merchants/[id]/[...section]/page';

const KEY = Buffer.alloc(32, 9);
const now = new Date();
const session: FounderSession = {
  userId: '00000000-0000-4000-8000-000000000100',
  accessToken: 'TEST-token',
  refreshToken: 'TEST-refresh',
  issuedAt: now.toISOString(),
  expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
  csrf: Buffer.alloc(32, 3).toString('base64url'),
};

beforeEach(() => {
  vi.stubEnv('APP_ENV', 'test');
  vi.stubEnv('ADMIN_ORIGIN', 'https://admin.example');
  vi.stubEnv('ADMIN_SESSION_SECRET', KEY.toString('base64url'));
  vi.stubEnv('EDGE_URL', 'http://edge');
  vi.stubEnv('ADMIN_MODULES', 'merchants');
  incoming = new Headers({
    host: 'admin.example',
    cookie: founderCookie(
      sealFounderSession(session, { origin: 'https://admin.example', edgeUrl: 'http://edge', key: KEY }, now),
      3600,
    ).split(';')[0]!,
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function serve(overrides: Record<string, unknown> = {}) {
  const service = founderReadService(overrides);
  vi.stubGlobal('fetch', vi.fn(service.fetchImpl));
  return service.seen;
}
const html = (element: unknown) => renderToStaticMarkup(element as never);
const drill = (slug: string, query: Record<string, string> = {}) =>
  DrilldownPage({ params: Promise.resolve({ id: TEST_MERCHANT, section: [slug] }), searchParams: Promise.resolve(query) }).then(html);
const founder = (path: string, query: Record<string, string> = {}) =>
  FounderOpsPage({ params: Promise.resolve({ founderPath: path.slice(1).split('/') }), searchParams: Promise.resolve(query) }).then(html);
const fail503 = () => Response.json({ error: { message: 'down' } }, { status: 503 });

describe('merchant drilldown F07-F23 reads every section of the contract', () => {
  it('asks for every contract section somewhere in the F07-F23 pages', async () => {
    const asked = new Set<string>();
    for (const row of DRILLDOWN) {
      const seen = serve();
      await drill(row[1]);
      for (const s of seen) if (s.procedure === 'founderAdmin.merchants.section') asked.add(String(s.input.section));
    }
    expect([...asked].sort()).toEqual(
      [
        'activity',
        'apiKeys',
        'customers',
        'deliveries',
        'destinations',
        'disputes',
        'exports',
        'invoices',
        'links',
        'payments',
        'payouts',
        'profile',
        'refunds',
        'settlements',
        'subscriptions',
        'team',
        'webhooks',
      ].sort(),
    );
  });

  it.each(Object.entries(SCREEN_SECTIONS))(
    '%s renders its real rows with no "arrives" or "unavailable" placeholder',
    async (slug, sections) => {
      const seen = serve();
      const out = await drill(slug);
      expect(out).not.toContain('Not connected');
      expect(out).not.toContain('Records cannot be read yet');
      expect(out).not.toContain('Not available from the current backend');
      for (const section of sections) {
        expect(seen.some((s) => s.procedure === 'founderAdmin.merchants.section' && s.input.section === section)).toBe(true);
      }
      expect(out).toContain('not visible to merchant');
    },
  );

  it('F07 payments and refunds keep decimal strings exactly and show the fee snapshot and failure code', async () => {
    serve();
    const out = await drill('payments');
    expect(out).toContain('9,007,199,254,740,993');
    expect(out).toContain('rail.declined');
    expect(out).toContain('refund-TEST-1');
    expect(out).toContain('No snapshot');
    expect(out).toContain('1.25 USDT');
    // Digits beyond a float's reach survive: the trailing 1 of the 18th decimal is not rounded away.
    expect(out).toContain('9,007,199,254,740,993.000000000000000001');
  });

  it('F10 destinations stay masked and are never unmasked', async () => {
    serve();
    const out = await drill('payouts');
    expect(out).toContain('••••4821');
    expect(out).toContain('Not recorded');
    expect(out).not.toMatch(/\bDE\d{2}[0-9A-Z]{10,}/);
  });

  it('F19 names the API key blocker, still lists webhooks and deliveries, and shows no key', async () => {
    serve();
    const out = await drill('developers');
    expect(out).toContain('API key catalog not in pay service yet');
    expect(out).toContain('https://merchant.example.test/hooks');
    expect(out).toContain('payment.captured');
    expect(out).toContain('503');
    expect(out).not.toMatch(/sk_(live|test)/);
  });

  it('F20 shows the current KYB profile and its append-only history', async () => {
    serve();
    const out = await drill('compliance');
    expect(out).toContain('TEST DATA Merchant Ltd');
    expect(out).toContain('Documents checked (TEST DATA)');
    expect(out).toContain('KYB-TEST-1');
  });

  it('F11 shows balances from the merchant snapshot and the statement exports, each failing on its own', async () => {
    serve({
      'founderAdmin.metrics.merchant': {
        merchantId: TEST_MERCHANT,
        window: { kind: 'preset', preset: 'rolling_30d' },
        freshness: { asOf: '2026-10-17T07:00:00.000Z', lagSeconds: 3 },
        balances: [{ assetCode: 'USDT', clearing: '10', available: BIG }],
        paymentCount: 0,
        statusMix: [],
        captured: [],
        refunded: [],
        net: [],
        settlements: [],
        averagePayment: [],
        largestPayment: [],
        linkUsage: { linksUsed: 0, paymentsViaLinks: 0 },
        feeRevenue: [],
        conversionVolume: null,
      },
    });
    const out = await drill('balances');
    expect(out).toContain('9,007,199,254,740,993');
    expect(out).toContain('statement-TEST.csv');
  });

  it('F12 names its blocker and F13/F14 point to Controls; none says "unimplemented"', async () => {
    serve();
    const conversion = await drill('conversion');
    expect(conversion).toContain('Conversion orders reader not built yet');
    for (const slug of ['pricing', 'limits']) {
      const out = await drill(slug);
      expect(out).toContain('Open Controls');
      expect(out).not.toContain('Not connected');
    }
    expect(conversion).not.toContain('still unimplemented');
  });

  it('F22 lists operator notes with a retracted one kept in the history, plus the add form', async () => {
    serve();
    const out = await drill('operator');
    expect(out).toContain('Asked for a higher cap; hold until KYB refresh (TEST DATA)');
    expect(out).toContain('Wrong merchant (TEST DATA)');
    expect(out).toContain('Written on the wrong merchant');
    expect(out).toContain('Add note');
    expect(out).not.toContain('Notes are not built yet');
  });

  it('F23 shows the current profile and sends changes to Controls', async () => {
    serve();
    const out = await drill('edit');
    expect(out).toContain('TEST DATA Merchant');
    expect(out).toContain('Open Controls');
  });
});

describe('lists: paging, filters, empty and error states', () => {
  it('a section with a next cursor links to it, and a request carrying the cursor sends it to the service', async () => {
    serve({
      'founderAdmin.merchants.section': (i: Record<string, unknown>) => sectionFixture(i.section as 'payments', { nextCursor: 'CURSOR-A' }),
    });
    const first = await drill('payments');
    expect(first).toContain('cursor_payments=CURSOR-A');
    expect(first).toContain('Next page');
    const seen = serve();
    const later = await drill('payments', { cursor_payments: 'CURSOR-A' });
    expect(seen.find((s) => s.input.section === 'payments')?.input.cursor).toBe('CURSOR-A');
    expect(later).toContain('First page');
    expect(later).toContain('End of list');
  });

  it('the page size is fixed and the status filter reaches the service only when it is one the service accepts', async () => {
    const seen = serve();
    await drill('payments', { status_payments: 'failed', status_refunds: 'not-a-status', q_payments: 'abc' });
    const pay = seen.find((s) => s.input.section === 'payments')!.input;
    const ref = seen.find((s) => s.input.section === 'refunds')!.input;
    expect(pay.limit).toBe(25);
    expect(pay.filters).toEqual({ status: 'failed', search: 'abc' });
    expect(ref.filters).toBeUndefined();
  });

  it('an empty list is a successful empty state, with a filter-aware message', async () => {
    serve({ 'founderAdmin.merchants.section': (i: Record<string, unknown>) => sectionFixture(i.section as 'payments', { items: [] }) });
    const plain = await drill('payments');
    expect(plain).toContain('No payments yet');
    expect(plain).toContain('successful read, not an error');
    const filtered = await drill('payments', { status_payments: 'failed' });
    expect(filtered).toContain('match these filters');
  });

  it('one failing section shows an error with Try again while the others still render', async () => {
    serve({
      'founderAdmin.merchants.section': (i: Record<string, unknown>) =>
        i.section === 'refunds' ? fail503() : sectionFixture(i.section as 'payments'),
    });
    const out = await drill('payments');
    expect(out).toContain('Refunds could not be loaded');
    expect(out).toContain('Try again');
    expect(out).toContain('9,007,199,254,740,993');
    expect(out).not.toContain('No refunds yet');
  });

  it('a section answer for the wrong section is unreadable, never shown as that section', async () => {
    serve({ 'founderAdmin.merchants.section': () => sectionFixture('refunds') });
    const out = await drill('customers');
    expect(out).toContain('could not be read');
    expect(out).not.toContain('refund-TEST-1');
  });

  it('a stubbed service names the procedure instead of showing an empty list', async () => {
    serve({
      'founderAdmin.merchants.section': () => Response.json({ error: { data: { cause: { code: 'pay.not_built' } } } }, { status: 501 }),
    });
    const out = await drill('customers');
    expect(out).toContain('Not built yet');
    expect(out).toContain('founderAdmin.merchants.section');
  });
});

describe('F05 recent merchants', () => {
  it('lists merchants newest first and names the creation blocker', async () => {
    serve();
    const out = await founder('/merchants/new');
    expect(out).toContain('TEST DATA Merchant');
    expect(out).toContain('Unnamed merchant');
    expect(out).toContain('Creating a merchant is not in the pay service yet');
    expect(out).not.toContain('Not connected');
  });
  it('follows the cursor', async () => {
    const seen = serve({
      'founderAdmin.merchants.recent': (i: Record<string, unknown>) => ({ items: [], nextCursor: i.cursor ? null : 'C2' }),
    });
    const first = await founder('/merchants/new');
    expect(first).toContain('cursor=C2');
    await founder('/merchants/new', { cursor: 'C2' });
    expect(seen.filter((s) => s.procedure === 'founderAdmin.merchants.recent').at(-1)?.input.cursor).toBe('C2');
  });
  it('a failed read is an error, not an empty list', async () => {
    serve({ 'founderAdmin.merchants.recent': fail503 });
    const out = await founder('/merchants/new');
    expect(out).toContain('could not be loaded');
    expect(out).toContain('Try again');
    expect(out).not.toContain('No merchant has been created yet');
  });
});

describe('F37 payouts and F32 disputes across merchants', () => {
  it('payouts: rows, cursor link, per-asset net that never mixes assets, and the status filter', async () => {
    const seen = serve();
    const out = await founder('/payouts');
    expect(out).toContain('PAYOUT-REF-TEST');
    expect(out).toContain('cursor=cursor-payouts-2');
    expect(out).toContain('693.00');
    expect(out).toContain('99.00');
    expect(out).not.toContain('792.00');
    expect(out).toContain('Export CSV (2)');
    await founder('/payouts', { status: 'failed', cursor: 'cursor-payouts-2' });
    const input = seen.filter((s) => s.procedure === 'founderAdmin.payouts.list').at(-1)!.input;
    expect(input).toMatchObject({ limit: 25, status: 'failed', cursor: 'cursor-payouts-2' });
  });
  it('payouts: an unknown status is dropped before it reaches the service', async () => {
    const seen = serve();
    await founder('/payouts', { status: 'bogus' });
    expect(seen.find((s) => s.procedure === 'founderAdmin.payouts.list')!.input.status).toBeUndefined();
  });
  it('payouts: empty and error states', async () => {
    serve({ 'founderAdmin.payouts.list': { items: [], nextCursor: null } });
    expect(await founder('/payouts')).toContain('No payout yet');
    serve({ 'founderAdmin.payouts.list': fail503 });
    const bad = await founder('/payouts');
    expect(bad).toContain('payout list could not be loaded');
    expect(bad).toContain('Try again');
  });
  it('disputes: deadline, ledger refusal and the amount at risk per asset', async () => {
    const seen = serve();
    const out = await founder('/disputes');
    expect(out).toContain('dispute-TEST-1');
    expect(out).toContain('from the rail');
    expect(out).toContain('No deadline from the rail');
    expect(out).toContain('ledger.chargeback_unbuilt');
    expect(out).toContain('40.00');
    await founder('/disputes', { status: 'open', deadline: 'set' });
    expect(seen.filter((s) => s.procedure === 'founderAdmin.disputes.list').at(-1)!.input).toMatchObject({
      status: 'open',
      deadline: 'set',
      limit: 25,
    });
  });
  it('disputes: empty and error states', async () => {
    serve({ 'founderAdmin.disputes.list': { items: [], nextCursor: null } });
    expect(await founder('/disputes')).toContain('No dispute has been opened');
    serve({ 'founderAdmin.disputes.list': fail503 });
    expect(await founder('/disputes')).toContain('Try again');
  });
});

describe('F02 live counters and F03 risk', () => {
  it('live: counts by state, queue ages, and the named gap for the event stream', async () => {
    serve();
    const out = await founder('/merchants/live');
    expect(out).toContain('Live counters as of');
    expect(out).toContain('2 h 0 min');
    expect(out).toContain('Nothing waiting');
    expect(out).toContain('Event stream and pipeline counters not in the live summary yet');
    expect(out).not.toContain('Not connected');
  });
  it('live: an error is not zero', async () => {
    serve({ 'founderAdmin.live.summary': fail503 });
    const out = await founder('/merchants/live');
    expect(out).toContain('live counters could not be loaded');
    expect(out).toContain('Try again');
  });
  it('risk: concentration is labelled as possibly lagging, with the projected-through date and exact shares', async () => {
    const seen = serve();
    const out = await founder('/merchants/risk');
    expect(out).toContain('projected through 2026-10-16');
    expect(out).toContain('can lag');
    expect(out).toContain('possibly lagging');
    expect(out).toContain('75%');
    expect(out).toContain('0.75');
    expect(out).toContain('Failed workflows');
    const input = seen.find((s) => s.procedure === 'founderAdmin.risk.summary')!.input;
    expect(input.topN).toBe(10);
    expect(input.window).toBeUndefined();
  });
  it('risk: the window pills choose a preset, and the caller always supplies the cutoff', async () => {
    const seen = serve();
    await founder('/merchants/risk', { window: '7d' });
    expect(seen.find((s) => s.procedure === 'founderAdmin.risk.summary')!.input).toEqual({
      topN: 10,
      window: { kind: 'preset', preset: 'rolling_7d' },
    });
  });
  it('risk: no projection yet is stated, and an error is not an empty board', async () => {
    serve({
      'founderAdmin.risk.summary': {
        ...({} as object),
        window: null,
        projectedThrough: null,
        concentration: [],
        failedWorkflows: {
          paymentsFailed: 0,
          payoutsFailed: 0,
          refundsReversed: 0,
          webhookDeliveriesFailed: 0,
          webhookDeliveriesDead: 0,
          exportsFailed: 0,
        },
      },
    });
    const none = await founder('/merchants/risk');
    expect(none).toContain('has no projected days');
    expect(none).toContain('No captured volume in the projection');
    serve({ 'founderAdmin.risk.summary': fail503 });
    const bad = await founder('/merchants/risk');
    expect(bad).toContain('risk summary could not be loaded');
    expect(bad).not.toContain('No captured volume');
  });
});

describe('notes list reads', () => {
  it('passes the flagged and retracted filters to the service', async () => {
    const seen = serve();
    await drill('operator', { flagged: '1', retracted: '1' });
    expect(seen.find((s) => s.procedure === 'founderAdmin.ops.notes.list')!.input).toMatchObject({
      merchantId: TEST_MERCHANT,
      flaggedOnly: true,
      includeRetracted: true,
    });
    expect(notesFixture.items).toHaveLength(2);
  });
  it('an unbuilt notes service names its procedure', async () => {
    serve({
      'founderAdmin.ops.notes.list': () => Response.json({ error: { data: { cause: { code: 'pay.not_built' } } } }, { status: 501 }),
    });
    const out = await drill('operator');
    expect(out).toContain('founderAdmin.ops.notes.list');
  });
});

it('the other fixture merchant is a different id from the one on the page', () => {
  expect(TEST_OTHER_MERCHANT).not.toBe(TEST_MERCHANT);
});

describe('add-note form', () => {
  it('cannot save an empty note and says why on hover', () => {
    const out = html(<AddNoteForm merchantId={TEST_MERCHANT} />);
    expect(out).toContain('Write the note first.');
    expect(out).toContain('disabled');
    expect(out).toContain('never shown to the merchant');
  });
});
