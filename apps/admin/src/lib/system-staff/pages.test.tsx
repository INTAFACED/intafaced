import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { founderCookie, sealFounderSession, type FounderSession } from '@/lib/founder-session';
import { moduleForApi, moduleForPage } from '@/lib/modules';
import { resolveScreen } from '@/lib/founder-ops/screens';
import { T_STAFF_ID, noProcedure, trpcOk } from '@/testing/staff-fixtures';

let incoming = new Headers();
vi.mock('next/headers', () => ({ headers: async () => incoming }));
vi.mock('next/navigation', async (original) => ({
  ...(await original<typeof import('next/navigation')>()),
  usePathname: () => '/system/users',
  useRouter: () => ({ refresh: vi.fn() }),
}));
import UsersPage from '@/app/(console)/system/users/page';
import MemberPage from '@/app/(console)/system/users/[userId]/page';
import RolesPage from '@/app/(console)/system/roles/page';

/**
 * The staff pages behind the founder gate. `/system/users` was the generic founder screen F73 under the catch-all; these
 * are the guards that screen's inventory tests gave it, now on the real pages, plus the two new ones.
 */
const KEY = Buffer.alloc(32, 9);
const USER = '11111111-1111-4111-8111-111111111111';
const now = new Date();
const session: FounderSession = {
  userId: USER,
  accessToken: 'TEST-token',
  refreshToken: 'TEST-refresh',
  issuedAt: now.toISOString(),
  expiresAt: new Date(now.getTime() + 3600000).toISOString(),
  csrf: Buffer.alloc(32, 3).toString('base64url'),
};
function cookie() {
  incoming.set(
    'cookie',
    founderCookie(sealFounderSession(session, { origin: 'https://admin.example', edgeUrl: 'http://edge', key: KEY }, now), 3600).split(
      ';',
    )[0]!,
  );
}
/** The founder entitlement answers `enabled`; identity has no staff procedures (step 2 not built), only the enrolment door. */
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
      if (url.includes('founderEnrolmentStatus')) return trpcOk({ open: false });
      const path = url.split('/trpc/')[1]?.split('?')[0] ?? '';
      return noProcedure(path);
    }),
  );
  return seen;
}
const PAGES = [
  ['/system/users', () => UsersPage({ searchParams: Promise.resolve({}) })],
  ['/system/users/:userId', () => MemberPage({ params: Promise.resolve({ userId: T_STAFF_ID }) })],
  ['/system/roles', () => RolesPage()],
] as const;

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

describe('staff pages', () => {
  it('/system/users is a real page now, not the catch-all founder screen', () => {
    expect(resolveScreen('/system/users')).toBeNull();
    expect(moduleForPage('/system/users')).toBe('merchants');
    expect(moduleForPage('/system/roles')).toBe('merchants');
    expect(moduleForApi('/api/system/staff')).toBe('merchants');
  });

  it.each(PAGES)('%s refuses a signed-out request before a backend read', async (_route, run) => {
    const seen = services(true);
    await expect(run()).rejects.toThrow();
    expect(seen).toEqual([]);
  });

  it.each(PAGES)('%s refuses revoked founder authority before reading staff data', async (_route, run) => {
    cookie();
    const seen = services(false);
    await expect(run()).rejects.toThrow();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('accountControls.operatorStatus');
  });

  it.each(PAGES)('%s respects the disabled merchants module', async (_route, run) => {
    vi.stubEnv('ADMIN_MODULES', 'crm');
    cookie();
    const seen = services(true);
    await expect(run()).rejects.toThrow();
    expect(seen).toEqual([]);
  });

  it.each(PAGES)('%s renders the refusal that svc-identity has no staff roster yet, inventing nothing', async (_route, run) => {
    cookie();
    const seen = services(true);
    const html = renderToStaticMarkup(await run());
    expect(html).toContain('svc-identity has no staff roster yet (OPS-admin-access-03 step 2)');
    expect(html).toContain('admin.staff_roster_not_built');
    expect(html).not.toContain('NaN');
    expect(seen.some((u) => u.includes('/api/identity/trpc/staff.') || u.includes('/api/identity/trpc/roles.list'))).toBe(true);
  });

  it('a staff id that is not one is a 404, before any staff read', async () => {
    cookie();
    const seen = services(true);
    await expect(MemberPage({ params: Promise.resolve({ userId: 'has%20space' }) })).rejects.toThrow();
    expect(seen.filter((u) => u.includes('staff.'))).toEqual([]);
  });
});
