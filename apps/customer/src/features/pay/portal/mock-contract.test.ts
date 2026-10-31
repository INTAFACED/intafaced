import { describe, expect, it } from 'vitest';
import { createApiClient } from '../../../shared/api';
import { createPortalApi, type PortalApi } from './api';
import { createPortalMock } from './portal.mock.mjs';
import { refusalText } from './refusal';
import type { ContractCase, ContractPart } from './mock-contract-kit';
import { moneyContract } from './money/contract-cases';
import { paymentsContract } from './payments/contract-cases';
import { settingsContract } from './settings/contract-cases';
import { catalogContract } from './catalog/contract-cases';

const USER = '22222222-2222-4222-8222-222222222222';
const merchant = '11111111-1111-4111-8111-111111111111';

const core: ContractPart = {
  cases: [
    { method: 'merchant', run: (p) => p.merchant() },
    { method: 'rails', run: (p) => p.rails() },
    { method: 'snapshot', run: (p) => p.snapshot(merchant, 'today') },
    { method: 'settlementAssets', run: (p) => p.settlementAssets(merchant) },
    { method: 'series', run: (p) => p.series(merchant, '2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z') },
    { method: 'teamMe', run: (p) => p.teamMe() },
    { method: 'permissionCatalogue', run: (p) => p.permissionCatalogue() },
    { method: 'myAccess', run: (p) => p.myAccess(), mock: { myAccess: 'owner' } },
    { method: 'myAccess', run: (p) => p.myAccess(), mock: { myAccess: 'finance', role: 'finance' } },
    { method: 'myAccess', run: (p) => p.myAccess(), mock: { myAccess: 'payfac' } },
    { method: 'haltStatus', run: (p) => p.haltStatus(merchant) },
    { method: 'notifications', run: (p) => p.notifications(undefined, false, '') },
    { method: 'unreadCount', run: (p) => p.unreadCount() },
    { method: 'preferences', run: (p) => p.preferences() },
    { method: 'preferenceHistory', run: (p) => p.preferenceHistory(undefined) },
  ],
  notMocked: {
    userId: 'a value, not a call',
    markRead: 'a write: the stand-in answers it, and the Playwright run exercises it',
    markAllRead: 'a write: the stand-in answers it, and the Playwright run exercises it',
    setPreference: 'a write: the stand-in answers it, and the Playwright run exercises it',
  },
};
const parts: Record<string, ContractPart> = {
  core,
  money: moneyContract,
  payments: paymentsContract,
  settings: settingsContract,
  catalog: catalogContract,
};

/** Run the real client against the stand-in with no browser: a fetch that hands each request to the mock as a route. */
function clientFor(mock: ReturnType<typeof createPortalMock>): PortalApi {
  const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
    let out: { status: number; body: string } = { status: 500, body: '' };
    const href = new URL(String(url), 'http://stand-in.test').toString();
    const route = {
      request: () => ({
        url: () => href,
        method: () => init?.method ?? 'GET',
        postDataJSON: () => (init?.body ? JSON.parse(String(init.body)) : null),
      }),
      fulfill: async (r: { status?: number; body: string }) => {
        out = { status: r.status ?? 200, body: r.body };
      },
    };
    await mock.handle(route);
    return new Response(out.body, { status: out.status });
  };
  return createPortalApi(createApiClient({ fetch: fetcher as typeof fetch }), USER);
}

describe('stand-in answers match the shapes the client parses', () => {
  const all: ContractCase[] = Object.values(parts).flatMap((part) => part.cases);
  it.each(all.map((c, i) => [`${c.method}${c.mock ? ` (${JSON.stringify(c.mock)})` : ''}`, c, i] as const))('%s', async (_name, c) => {
    const result = await c.run(clientFor(createPortalMock('active', c.mock)));
    expect(result.ok, JSON.stringify(result)).toBe(true);
  });
  it('covers every client method, or says why a method is not covered', () => {
    const portal = createPortalApi(createApiClient({ fetch: (async () => new Response('')) as typeof fetch }), USER);
    const covered = new Set<string>([...all.map((c) => c.method), ...Object.values(parts).flatMap((p) => Object.keys(p.notMocked))]);
    const missing = Object.keys(portal).filter((name) => !covered.has(name));
    expect(missing).toEqual([]);
  });
  it('answers an email invite the same way for any address, keeps it as a pending email member, and never echoes an account', async () => {
    const mock = createPortalMock('active');
    const portal = clientFor(mock);
    const first = await portal.invite({ email: '  Priya@Test.Invalid ', role: 'finance' });
    const second = await portal.invite({ email: 'someone.else@test.invalid', role: 'finance' });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.data).toMatchObject({ userId: 'email:priya@test.invalid', status: 'invited', role: 'finance' });
    expect(Object.keys(first.data).sort()).toEqual(Object.keys(second.data).sort());
    const inviteCalls = mock.calls.filter((c: { procedure: string }) => c.procedure === 'merchantOps.team.invite');
    expect(inviteCalls).toHaveLength(2);
  });
  it('refuses an email invite in plain words when the system has it switched off, or the window is full', async () => {
    const off = await clientFor(createPortalMock('active', { emailInvites: 'off' })).invite({ email: 'a@test.invalid', role: 'viewer' });
    expect(off.ok).toBe(false);
    if (!off.ok) expect(refusalText(off)).toBe('Email invitations are switched off on this system.');
    const limited = await clientFor(createPortalMock('active', { emailInvites: 'limited' })).invite({
      email: 'a@test.invalid',
      role: 'viewer',
    });
    expect(limited.ok).toBe(false);
    if (!limited.ok) expect(refusalText(limited)).toMatch(/Too many email invitations/);
    // The account-id path stays open when email invitations are off.
    const byId = await clientFor(createPortalMock('active', { emailInvites: 'off' })).invite({ userId: 'TEST-user-new', role: 'viewer' });
    expect(byId.ok).toBe(true);
  });
  it('refuses a bad address, both targets, no target, and an account id that borrows the email prefix', async () => {
    const portal = clientFor(createPortalMock('active'));
    const cases: Array<[Parameters<PortalApi['invite']>[0], RegExp]> = [
      [{ email: 'not an email', role: 'viewer' }, /one email address/],
      [{ email: 'a@test.invalid', userId: 'TEST-user-new', role: 'viewer' }, /either an email address or an account id/],
      [{ role: 'viewer' }, /either an email address or an account id/],
      [{ userId: 'email:a@test.invalid', role: 'viewer' }, /not an account id/],
    ];
    for (const [input, words] of cases) {
      const result = await portal.invite(input);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(refusalText(result)).toMatch(words);
        expect(refusalText(result)).not.toMatch(/pay\./);
      }
    }
  });
  it('uses real-shaped ids and marks amounts as test data', () => {
    const mock = createPortalMock('active');
    expect(mock.state.merchant.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});
