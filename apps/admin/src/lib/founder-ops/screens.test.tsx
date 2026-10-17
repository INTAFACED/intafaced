import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { founderCookie, sealFounderSession, type FounderSession } from '@/lib/founder-session';
import { moduleForPage } from '@/lib/modules';
import { SCREENS, DRILLDOWN, drilldownScreen, resolveScreen } from './screens';
import { SCREEN_SECTIONS } from './read-model';
import { parseFraud } from './loaders';
import { FounderScreenView } from '@/components/founder-ops/screens';
let incoming = new Headers();
vi.mock('next/headers', () => ({ headers: async () => incoming }));
vi.mock('next/navigation', async (original) => ({
  ...(await original<typeof import('next/navigation')>()),
  useRouter: () => ({ refresh: vi.fn() }),
}));
import FounderOpsPage from '@/app/(console)/[...founderPath]/page';
import DrilldownPage from '@/app/(console)/merchants/[id]/[...section]/page';
const KEY = Buffer.alloc(32, 9);
const USER = '11111111-1111-4111-8111-111111111111';
const MID = '22222222-2222-4222-8222-222222222222';
const now = new Date();
const session: FounderSession = {
  userId: USER,
  accessToken: 'TEST-token',
  refreshToken: 'TEST-refresh',
  issuedAt: now.toISOString(),
  expiresAt: new Date(now.getTime() + 3600000).toISOString(),
  csrf: Buffer.alloc(32, 3).toString('base64url'),
};
const sample = {
  id: 'review-1',
  merchantId: MID,
  paymentId: 'p-1',
  amount: '9007199254740993.000000000000000001',
  assetId: 'USDT',
  status: 'open',
  createdAt: now.toISOString(),
  reasons: [{ ruleId: 'velocity', detail: 'Review requested' }],
};
/** Pages whose lists now come from the founder reads (#4870). With the reads off they show a named failure, never "arrives". */
const WIRED = new Set(['F02', 'F03', 'F05', 'F32']);
/** Pages on the control-room reads: with the read off they say so in plain words, with no internal name. */
const CONTROL_WIRED = new Set(['F25', 'F35', 'F37', 'F54', 'F58', 'F64']);
const pathOf = (route: string) => route.replace(':id', 'review-1');
const run = (route: string) =>
  FounderOpsPage({ params: Promise.resolve({ founderPath: pathOf(route).slice(1).split('/') }), searchParams: Promise.resolve({}) });
function cookie() {
  incoming.set(
    'cookie',
    founderCookie(sealFounderSession(session, { origin: 'https://admin.example', edgeUrl: 'http://edge', key: KEY }, now), 3600).split(
      ';',
    )[0]!,
  );
}
function services(enabled: boolean) {
  const seen: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      seen.push(url);
      if (url.includes('accountControls.operatorStatus'))
        return Response.json({
          result: { data: { status: enabled ? 'enabled' : 'disabled', userId: USER, version: '1', changedAt: now.toISOString() } },
        });
      if (url.includes('fraud.listOpenReviews')) return Response.json({ result: { data: [sample] } });
      if (url.includes('founderEnrolmentStatus')) return Response.json({ result: { data: { open: false } } });
      return Response.json({ error: { data: { cause: { code: 'pay.not_built' } } } }, { status: 501 });
    }),
  );
  return seen;
}
beforeEach(() => {
  vi.stubEnv('APP_ENV', 'test');
  vi.stubEnv('ADMIN_ORIGIN', 'https://admin.example');
  vi.stubEnv('ADMIN_SESSION_SECRET', KEY.toString('base64url'));
  vi.stubEnv('EDGE_URL', 'http://edge');
  vi.stubEnv('ADMIN_MODULES', 'merchants');
  incoming = new Headers({ host: 'admin.example' });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
describe('new founder route inventory', () => {
  it.each(SCREENS)('$id refuses a signed-out request before a backend read', async (s) => {
    const seen = services(true);
    await expect(run(s.route)).rejects.toThrow();
    expect(seen).toEqual([]);
  });
  it.each(SCREENS)('$id refuses revoked founder authority before reading product data', async (s) => {
    cookie();
    const seen = services(false);
    await expect(run(s.route)).rejects.toThrow();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('accountControls.operatorStatus');
  });
  it.each(SCREENS)('$id renders the declared page without inventing missing backend values', async (s) => {
    cookie();
    services(true);
    const html = renderToStaticMarkup(await run(s.route));
    expect(html).toContain(s.title);
    if (WIRED.has(s.id)) {
      expect(html).not.toContain('Not connected');
      expect(html).toContain('Not built yet');
    } else if (CONTROL_WIRED.has(s.id)) {
      expect(html).not.toContain('Not connected');
      expect(html).toContain('Not switched on in this deployment');
      expect(html).not.toContain('founderAdmin.');
    } else expect(html).toContain('Not connected');
    expect(html).not.toContain('NaN');
    expect(moduleForPage(pathOf(s.route))).toBe('merchants');
  });
  it.each(SCREENS)('$id respects the disabled merchants module', async (s) => {
    vi.stubEnv('ADMIN_MODULES', 'crm');
    cookie();
    const seen = services(true);
    await expect(run(s.route)).rejects.toThrow();
    expect(seen).toEqual([]);
  });
  it.each(DRILLDOWN)('%s drilldown is guarded and honest', async (id, section) => {
    services(true);
    const call = () => DrilldownPage({ params: Promise.resolve({ id: MID, section: [section] }) });
    await expect(call()).rejects.toThrow();
    cookie();
    const html = renderToStaticMarkup(await call());
    expect(html).toContain(`data-screen="${id}"`);
    expect(html).toContain('not visible to merchant');
    expect(html).not.toContain('Not connected');
    expect(html).not.toContain('merchant drilldown procedure is still unimplemented');
    if (SCREEN_SECTIONS[section]) {
      // Reads are off in this stub, so every list says so by name instead of showing an empty table.
      expect(html).toContain('Not built yet');
      expect(html).toContain('founderAdmin.merchants.section');
    }
  });
  it('no screen blocker promises a later arrival', () => {
    for (const s of SCREENS) expect(s.gap, s.id).not.toMatch(/\b(yet|soon|coming|will arrive|arrives|next backend)\b|founderAdmin\./i);
  });
  it('rejects unregistered paths, malformed merchant ids and nested drilldown paths', async () => {
    cookie();
    services(true);
    await expect(run('/system/no-such-page')).rejects.toThrow();
    await expect(DrilldownPage({ params: Promise.resolve({ id: 'bad', section: ['team'] }) })).rejects.toThrow();
    await expect(DrilldownPage({ params: Promise.resolve({ id: MID, section: ['team', 'bad'] }) })).rejects.toThrow();
  });
  it('covers all drilldown metadata and exact routes before variable ids', () => {
    for (const r of DRILLDOWN) expect(drilldownScreen(r[1])?.id).toBe(r[0]);
    expect(resolveScreen('/pricing/rules/form')?.screen.id).toBe('F53');
    expect(resolveScreen('/fraud/a/b')).toBeNull();
    expect(resolveScreen('/fraud/')).toBeNull();
  });
});
describe('fraud read validation and rendering', () => {
  it('preserves decimal strings beyond Number precision', () => {
    expect(parseFraud([sample])?.[0]?.amount).toBe(sample.amount);
    const screen = SCREENS.find((s) => s.id === 'F30')!;
    const html = renderToStaticMarkup(
      <FounderScreenView
        screen={screen}
        data={{ readAt: now.toISOString(), userId: USER, expiresAt: session.expiresAt, fraud: { kind: 'ok', data: parseFraud([sample])! } }}
        path="/fraud"
      />,
    );
    expect(html).toContain('9,007,199,254,740,993');
    expect(html).toContain('SLA unset');
    expect(html).toContain('1 open reviews loaded');
  });
  it.each([{ amount: 1 }, { createdAt: 'invalid' }, { reasons: [{ ruleId: 2, detail: 'x' }] }, { status: 'made-up' }, { amount: 'NaN' }])(
    'refuses malformed result %j',
    (change) => {
      expect(parseFraud([{ ...sample, ...change }])).toBeNull();
    },
  );
  it('does not turn unavailable into zero or empty', () => {
    const screen = SCREENS.find((s) => s.id === 'F30')!;
    const html = renderToStaticMarkup(
      <FounderScreenView
        screen={screen}
        data={{
          readAt: now.toISOString(),
          userId: USER,
          expiresAt: session.expiresAt,
          fraud: { kind: 'unavailable', requestId: 'request-test' },
        }}
        path="/fraud"
      />,
    );
    expect(html).toContain('This is an error, not an empty list');
    expect(html).toContain('request-test');
    expect(html).not.toContain('0 open reviews loaded');
  });
  it('explains a successful empty read', () => {
    const screen = SCREENS.find((s) => s.id === 'F30')!;
    const html = renderToStaticMarkup(
      <FounderScreenView
        screen={screen}
        data={{ readAt: now.toISOString(), userId: USER, expiresAt: session.expiresAt, fraud: { kind: 'ok', data: [] } }}
        path="/fraud"
      />,
    );
    expect(html).toContain('No open reviews returned');
  });
});
