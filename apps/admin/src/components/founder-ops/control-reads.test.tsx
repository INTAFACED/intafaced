import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { founderCookie, sealFounderSession, type FounderSession } from '@/lib/founder-session';
import {
  APPROVAL_FIRST_FOUNDER,
  APPROVAL_ID,
  approvalsFixture,
  auditFixture,
  BIG,
  founderReadService,
  limitRequestsFixture,
  TEST_MERCHANT,
  tiersFixture,
} from '@/testing/founder-read-fixtures';

let incoming = new Headers();
vi.mock('next/headers', () => ({ headers: async () => incoming }));
vi.mock('next/navigation', async (original) => ({
  ...(await original<typeof import('next/navigation')>()),
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
import FounderOpsPage from '@/app/(console)/[...founderPath]/page';

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
const founder = (path: string, query: Record<string, string> = {}) =>
  FounderOpsPage({ params: Promise.resolve({ founderPath: path.slice(1).split('/') }), searchParams: Promise.resolve(query) }).then((el) =>
    renderToStaticMarkup(el as never),
  );
const fail503 = () => Response.json({ error: { message: 'down' } }, { status: 503 });
const notBuilt = () =>
  Response.json(
    { error: { message: 'pay.not_built', data: { code: 'NOT_IMPLEMENTED', httpStatus: 501, cause: { code: 'pay.not_built' } } } },
    { status: 501 },
  );
const wrongShape = () => ({ unexpected: true });
const calls = (seen: ReturnType<typeof serve>, procedure: string) => seen.filter((s) => s.procedure === procedure);

describe('F25 approval detail', () => {
  it('shows the payout, people, masked destination and hash, and never asks for the full destination', async () => {
    const seen = serve();
    const out = await founder(`/approvals/${APPROVAL_ID}`);
    expect(out).toContain('9,007,199,254,740,993.000000000000000001 USDT');
    expect(out).toContain('••••4821');
    expect(out).toContain('bank-test');
    expect(out).toContain('00000000-0000-4000-8000-000000000101');
    expect(out).toContain('No founder has signed yet');
    expect(out).toContain(`sha256:${'a'.repeat(64)}`);
    expect(out).toContain('href="/merchants/approvals"');
    expect(out).not.toContain('founderAdmin.');
    expect(seen.map((s) => s.procedure)).not.toContain('founderAdmin.approvals.destination');
    expect(calls(seen, 'founderAdmin.approvals.list')[0]!.input).toMatchObject({ limit: 200 });
  });
  it('names the first founder when one has already signed', async () => {
    serve();
    const out = await founder(`/approvals/${approvalsFixture.approvals[1]!.approvalId}`);
    expect(out).toContain(APPROVAL_FIRST_FOUNDER);
    expect(out).toContain('••••9917');
    expect(out).toContain('100.00 EUR');
  });
  it('an approval that is not on the queue says so and infers nothing', async () => {
    serve();
    const out = await founder('/approvals/00000000-0000-4000-8000-0000000009ff');
    expect(out).toContain('This approval is not waiting for founders');
    expect(out).not.toContain('••••');
  });
  it('error and not-switched-on states are named, with Try again', async () => {
    serve({ 'founderAdmin.approvals.list': fail503 });
    const bad = await founder(`/approvals/${APPROVAL_ID}`);
    expect(bad).toContain('could not be loaded');
    expect(bad).toContain('Try again');
    serve({ 'founderAdmin.approvals.list': notBuilt });
    const off = await founder(`/approvals/${APPROVAL_ID}`);
    expect(off).toContain('Not switched on in this deployment');
    expect(off).not.toContain('founderAdmin.');
    serve({ 'founderAdmin.approvals.list': wrongShape });
    expect(await founder(`/approvals/${APPROVAL_ID}`)).toContain('could not be read');
  });
  it('the decision-history gap is stated as a fact', async () => {
    serve();
    const out = await founder(`/approvals/${APPROVAL_ID}`);
    expect(out).toContain('no single read of one approval');
  });
});

describe('F35 settlements', () => {
  it('lists settlement windows with gross, fees and net, and pages by cursor', async () => {
    const seen = serve();
    const out = await founder('/settlements');
    expect(out).toContain('Settlements across merchants');
    expect(out).toContain('693.00');
    expect(out).toContain('99.00');
    expect(out).toContain('cursor=cursor-payouts-2');
    expect(out).toContain('Export CSV (2)');
    expect(out).not.toContain('founderAdmin.');
    expect(calls(seen, 'founderAdmin.payouts.list')[0]!.input).toEqual({ limit: 25 });
  });
  it('the failed filter and the cursor reach the service; an unknown status does not', async () => {
    const seen = serve();
    const out = await founder('/settlements', { status: 'failed', cursor: 'cursor-payouts-2' });
    expect(calls(seen, 'founderAdmin.payouts.list')[0]!.input).toEqual({ limit: 25, status: 'failed', cursor: 'cursor-payouts-2' });
    expect(out).toContain('href="/settlements?status=failed"');
    await founder('/settlements', { status: 'bogus' });
    expect(calls(seen, 'founderAdmin.payouts.list')[1]!.input.status).toBeUndefined();
  });
  it('empty, filtered-empty, error and not-switched-on states', async () => {
    serve({ 'founderAdmin.payouts.list': { items: [], nextCursor: null } });
    expect(await founder('/settlements')).toContain('No settlement yet');
    expect(await founder('/settlements', { status: 'failed' })).toContain('No settlement matches this status');
    serve({ 'founderAdmin.payouts.list': fail503 });
    const bad = await founder('/settlements');
    expect(bad).toContain('settlement list could not be loaded');
    expect(bad).toContain('Try again');
    serve({ 'founderAdmin.payouts.list': notBuilt });
    const off = await founder('/settlements');
    expect(off).toContain('Not switched on in this deployment');
    expect(off).not.toContain('founderAdmin.');
  });
});

describe('F54 merchant tiers', () => {
  it('shows every tier with exact caps, reserve, thresholds, lifetime and the merchant count', async () => {
    const seen = serve();
    const out = await founder('/pricing/tiers');
    expect(out).toContain('TEST DATA Standard');
    expect(out).toContain('standard_test');
    expect(out).toContain('9,007,199,254,740,993.000000000000000001 USDT');
    expect(out).toContain('New payout destinations per day: 20');
    expect(out).toContain('5.00% (500 bps) held 7 days');
    expect(out).toContain('No rolling reserve');
    expect(out).toContain('10,000.00 USDT or more');
    expect(out).toContain('1 day');
    expect(out).toContain('1 hour');
    expect(out).toContain('>12<');
    expect(out).toContain('Export CSV (2)');
    expect(out).not.toContain('founderAdmin.');
    expect(out).not.toContain("aren't available");
    expect(calls(seen, 'founderAdmin.control.tiers.list')).toHaveLength(1);
  });
  it('empty, error, wrong-shape and not-switched-on states', async () => {
    serve({ 'founderAdmin.control.tiers.list': [] });
    expect(await founder('/pricing/tiers')).toContain('No tier is defined');
    serve({ 'founderAdmin.control.tiers.list': fail503 });
    const bad = await founder('/pricing/tiers');
    expect(bad).toContain('tier list could not be loaded');
    expect(bad).toContain('Try again');
    serve({ 'founderAdmin.control.tiers.list': [{ ...tiersFixture[0], id: undefined }] });
    expect(await founder('/pricing/tiers')).toContain('could not be read');
    serve({ 'founderAdmin.control.tiers.list': notBuilt });
    expect(await founder('/pricing/tiers')).toContain('Not switched on in this deployment');
  });
});

describe('F58 limit requests', () => {
  it('lists open asks with exact caps, an unreadable-caps row, and a next-page link', async () => {
    const seen = serve();
    const out = await founder('/limits');
    expect(out).toContain('Payouts per day: 9,007,199,254,740,993.000000000000000001 USDT');
    expect(out).toContain('New payout destinations per day: 40');
    expect(out).toContain('TEST DATA: seasonal volume');
    expect(out).toContain('The stored caps could not be read');
    expect(out).toContain('cursor=402');
    expect(out).toContain(`href="/merchants/${TEST_MERCHANT}?tab=controls"`);
    expect(out).not.toContain('capsReadable');
    expect(out).not.toContain('founderAdmin.');
    expect(calls(seen, 'founderAdmin.control.limitRequests.list')[0]!.input).toEqual({ limit: 25 });
  });
  it('passes a numeric cursor and drops one the service would refuse', async () => {
    const seen = serve();
    const out = await founder('/limits', { cursor: '402' });
    expect(calls(seen, 'founderAdmin.control.limitRequests.list')[0]!.input).toEqual({ limit: 25, cursor: '402' });
    expect(out).toContain('First page');
    await founder('/limits', { cursor: '0; drop' });
    expect(calls(seen, 'founderAdmin.control.limitRequests.list')[1]!.input).toEqual({ limit: 25 });
  });
  it('empty, error and not-switched-on states', async () => {
    serve({ 'founderAdmin.control.limitRequests.list': { requests: [], nextCursor: null } });
    expect(await founder('/limits')).toContain('No merchant is asking for higher limits');
    serve({ 'founderAdmin.control.limitRequests.list': fail503 });
    const bad = await founder('/limits');
    expect(bad).toContain('limit requests could not be loaded');
    expect(bad).toContain('Try again');
    serve({ 'founderAdmin.control.limitRequests.list': notBuilt });
    expect(await founder('/limits')).toContain('Not switched on in this deployment');
  });
});

describe('F64 activity and audit', () => {
  it('shows actor, second approver, before/after and hides anything shaped like a destination', async () => {
    const seen = serve();
    const out = await founder('/audit');
    expect(out).toContain('set_caps');
    expect(out).toContain('00000000-0000-4000-8000-000000000102');
    expect(out).toContain('None');
    expect(out).toContain('payout.approval_voided');
    expect(out).toContain('system:payout_guard');
    expect(out).toContain('TEST DATA: raise payout cap');
    expect(out).toContain(`${BIG}`);
    expect(out).toContain('[hidden]');
    expect(out).not.toContain('DE00SECRETIBAN');
    expect(out).toContain('cursor=9007199254740992');
    expect(out).not.toContain('founderAdmin.');
    expect(calls(seen, 'founderAdmin.control.audit.list')[0]!.input).toEqual({ limit: 25 });
  });
  it('merchant, action and date filters reach the service as exact, inclusive values', async () => {
    const seen = serve();
    const out = await founder('/audit', {
      merchant: TEST_MERCHANT.toUpperCase(),
      kind: 'set_caps',
      from: '2026-10-01',
      to: '2026-10-17',
      cursor: '5',
    });
    expect(calls(seen, 'founderAdmin.control.audit.list')[0]!.input).toEqual({
      limit: 25,
      cursor: '5',
      merchantId: TEST_MERCHANT,
      kind: 'set_caps',
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-17T23:59:59.999Z',
    });
    expect(out).toContain('value="2026-10-01"');
    expect(out).toContain('Clear');
  });
  it('a bad filter is explained and nothing is read', async () => {
    const seen = serve();
    const bad = await founder('/audit', { merchant: 'not-an-id' });
    expect(bad).toContain('These filters cannot be applied');
    expect(bad).toContain('full id');
    const reversed = await founder('/audit', { from: '2026-10-17', to: '2026-10-01' });
    expect(reversed).toContain('after the “to” date');
    const fake = await founder('/audit', { from: '2026-02-31' });
    expect(fake).toContain('real date');
    expect(calls(seen, 'founderAdmin.control.audit.list')).toHaveLength(0);
  });
  it('empty, filtered-empty, error and not-switched-on states keep the filter form', async () => {
    serve({ 'founderAdmin.control.audit.list': { entries: [], nextCursor: null } });
    expect(await founder('/audit')).toContain('No control change has been recorded');
    expect(await founder('/audit', { kind: 'nothing' })).toContain('No entry matches these filters');
    serve({ 'founderAdmin.control.audit.list': fail503 });
    const bad = await founder('/audit');
    expect(bad).toContain('audit list could not be loaded');
    expect(bad).toContain('Try again');
    expect(bad).toContain('Audit filters');
    serve({ 'founderAdmin.control.audit.list': notBuilt });
    const off = await founder('/audit');
    expect(off).toContain('Not switched on in this deployment');
    expect(off).not.toContain('founderAdmin.');
  });
});

it('fixtures stay exact decimal strings, never numbers', () => {
  expect(typeof approvalsFixture.approvals[0]!.amount).toBe('string');
  expect(typeof limitRequestsFixture.requests[0]!.caps).toBe('object');
  expect(typeof auditFixture.entries[0]!.seq).toBe('string');
});
