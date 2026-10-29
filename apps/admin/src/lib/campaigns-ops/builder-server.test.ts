import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkCreate, checkMove, loadCampaignDetail, loadCampaignsDesk, moveCampaign } from './builder-server';

const ctx = {
  session: {
    userId: '11111111-1111-4111-8111-111111111111',
    accessToken: 'founder-access-token',
    refreshToken: 'r',
    expiresAt: '2030-01-01T00:00:00.000Z',
    issuedAt: '2026-01-01T00:00:00.000Z',
    csrf: 'c'.repeat(43),
  },
  config: { origin: 'https://admin.example', edgeUrl: 'http://edge:4000', key: Buffer.alloc(32, 1) },
};
const campaign = {
  id: 'cmp_1',
  name: 'TEST',
  type: 'task',
  state: 'pending_approval',
  revision: 3,
  rules: 'r',
  startsAt: '2026-10-25T00:00:00.000Z',
  endsAt: '2026-11-25T00:00:00.000Z',
  timeZone: 'UTC',
  timeZoneBlank: false,
  windows: { weekdays: null, hours: null },
  participation: { exclusions: [], regionScope: 'platform', restrictedRegions: null },
  budget: { asset: 'USDT', limit: '1000', left: '1000' },
  reward: { asset: 'USDT', amount: '10' },
  tasks: null,
  createdBy: 'a',
  submittedBy: 'a',
  approvedBy: null,
  createdAt: '2026-10-25T00:00:00.000Z',
  updatedAt: '2026-10-25T00:00:00.000Z',
  pendingChange: null,
  earning: [],
};
const ok = (data: unknown) => Response.json({ result: { data } });
const err = (status: number, message: string, code: string) =>
  Response.json({ error: { message, code: -32603, data: { code, httpStatus: status } } }, { status });

afterEach(() => vi.unstubAllGlobals());

describe('campaigns desk', () => {
  it('reads the list and the calendar as the founder', async () => {
    const fn = vi.fn(async (url: string, _i?: RequestInit) =>
      url.includes('calendar') ? ok({ timeZone: 'UTC', entries: [] }) : ok([campaign]),
    );
    vi.stubGlobal('fetch', fn);
    const view = await loadCampaignsDesk(ctx);
    expect(fn.mock.calls.map((c) => c[0]).sort()).toEqual([
      'http://edge:4000/api/campaigns/trpc/ops.campaigns.calendar',
      'http://edge:4000/api/campaigns/trpc/ops.campaigns.list',
    ]);
    expect((fn.mock.calls[0]![1]!.headers as Record<string, string>).authorization).toBe('Bearer founder-access-token');
    expect(view.campaigns).toEqual({ kind: 'ok', data: [campaign] });
    expect(view.calendar).toEqual({ kind: 'ok', data: { timeZone: 'UTC', entries: [] } });
  });

  it('a malformed list is a failed part, never an empty desk', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok([{ ...campaign, budget: { asset: 'USDT', limit: 1000, left: '1' } }])),
    );
    expect((await loadCampaignsDesk(ctx)).campaigns.kind).toBe('failed');
  });

  it('one campaign by id comes with the gate for its stored revision and the platform zone; an unknown id has no gate', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('validate')) return ok({ missing: [{ code: 'campaigns.budget_unset', field: 'budget' }] });
        if (url.includes('calendar')) return ok({ timeZone: 'UTC', entries: [] });
        if (url.includes('cmp_other')) return err(404, 'No such campaign [campaign.unknown]', 'NOT_FOUND');
        return ok(campaign);
      }),
    );
    const view = await loadCampaignDetail(ctx, 'cmp_1');
    expect(view.campaign).toEqual({ kind: 'ok', data: campaign });
    expect(view.gate).toEqual({ kind: 'ok', data: { missing: [{ code: 'campaigns.budget_unset', field: 'budget' }] } });
    expect(view.platformTimeZone).toBe('UTC');
    const other = await loadCampaignDetail(ctx, 'cmp_other');
    expect(other.campaign).toEqual({ kind: 'ok', data: null });
    expect(other.gate).toBeNull();
  });

  it('a refused move carries the service sentence and its code; the forbidden self-approval included', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        err(403, 'A second person approves; the one who wrote or asked for it cannot [campaigns.second_person_required]', 'FORBIDDEN'),
      ),
    );
    const out = await moveCampaign(ctx, { id: 'cmp_1', action: 'approve', revision: 3 });
    expect(out.status).toBe(403);
    expect(out.reply).toMatchObject({
      ok: false,
      code: 'campaigns.second_person_required',
      body: 'A second person approves; the one who wrote or asked for it cannot',
      changed: 'no',
    });
  });

  it('a move that may have arrived is an unknown outcome', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('reset'))),
    );
    expect((await moveCampaign(ctx, { id: 'cmp_1', action: 'activate', revision: 3 })).reply).toMatchObject({
      ok: false,
      changed: 'unknown',
    });
  });

  it('a done move returns the campaign as stored', async () => {
    const fn = vi.fn(async (_u: string, _i?: RequestInit) => ok({ ...campaign, state: 'approved', approvedBy: 'b' }));
    vi.stubGlobal('fetch', fn);
    const out = await moveCampaign(ctx, { id: 'cmp_1', action: 'approve', revision: 3 });
    expect(JSON.parse(String(fn.mock.calls[0]![1]!.body))).toEqual({ id: 'cmp_1', action: 'approve', revision: 3 });
    expect(out).toMatchObject({ status: 200, reply: { ok: true, what: 'approve', campaign: { state: 'approved' } } });
  });

  it('checks shapes as svc-campaigns does before sending', () => {
    expect(checkCreate({ name: '', type: 'task' }).ok).toBe(false);
    expect(checkCreate({ name: 'TEST', type: 'task', rules: 'r' }).ok).toBe(true);
    expect(checkMove({ id: 'cmp_1', action: 'launch', revision: 1 }).ok).toBe(false);
    expect(checkMove({ id: 'cmp_1', action: 'submit', revision: 0 }).ok).toBe(false);
  });
});
