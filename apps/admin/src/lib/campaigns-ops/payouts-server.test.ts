import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkBoard, checkPlan, checkRun, loadPayoutBoard, runDistribution } from './payouts-server';

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
const ok = (data: unknown) => Response.json({ result: { data } });
const board = {
  counts: { owed: 1, pending_funding: 0, sending: 0, paid: 0, failed: 0, other: 0 },
  rows: [],
  asOf: '2026-11-17T00:00:00.000Z',
};

afterEach(() => vi.unstubAllGlobals());

describe('payout board', () => {
  it('checks each input before any call: a run needs a campaign and a reason of 3 or more characters', () => {
    expect(checkBoard({}).ok).toBe(true);
    expect(checkBoard({ campaignId: 'cmp_1' }).ok).toBe(true);
    expect(checkPlan({}).ok).toBe(false);
    expect(checkRun({ campaignId: 'cmp_1', reason: 'no' }).ok).toBe(false);
    expect(checkRun({ campaignId: 'cmp_1', reason: 'snapshot due', extra: 1 }).ok).toBe(false);
    expect(checkRun({ campaignId: 'cmp_1', reason: 'snapshot due' })).toEqual({
      ok: true,
      input: { campaignId: 'cmp_1', reason: 'snapshot due' },
    });
  });

  it('reads the board as the founder, and a malformed board is never shown as an empty one', async () => {
    const fn = vi.fn(async (_u: string, _i?: RequestInit) => ok(board));
    vi.stubGlobal('fetch', fn);
    const out = await loadPayoutBoard(ctx, { campaignId: 'cmp_1' });
    expect(fn.mock.calls[0]![0]).toContain('http://edge:4000/api/campaigns/trpc/ops.payouts.board');
    expect((fn.mock.calls[0]![1]!.headers as Record<string, string>).authorization).toBe('Bearer founder-access-token');
    expect(out.reply).toMatchObject({ ok: true, data: board });
    // The whole board is asked for with an explicit empty input: the procedure's object input refuses a missing one.
    await loadPayoutBoard(ctx, {});
    expect(fn.mock.calls[1]![0]).toContain(`ops.payouts.board?input=${encodeURIComponent('{}')}`);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok({ ...board, counts: { owed: '1' } })),
    );
    expect((await loadPayoutBoard(ctx, {})).reply).toMatchObject({ ok: false });
  });

  it('a run posts the campaign and reason to the service', async () => {
    const fn = vi.fn(async (_u: string, _i?: RequestInit) =>
      ok({
        campaignId: 'cmp_1',
        snapshotAt: '2026-11-17T00:00:00.000Z',
        state: 'owed',
        pool: '100',
        totalEquity: '50',
        counted: 2,
        excludedNegative: 1,
        heldOut: 1,
        sharesTotal: '100',
      }),
    );
    vi.stubGlobal('fetch', fn);
    const out = await runDistribution(ctx, { campaignId: 'cmp_1', reason: 'snapshot due' });
    expect(fn.mock.calls[0]![0]).toBe('http://edge:4000/api/campaigns/trpc/ops.campaigns.distribution.run');
    expect(JSON.parse(String(fn.mock.calls[0]![1]!.body))).toEqual({ campaignId: 'cmp_1', reason: 'snapshot due' });
    expect(out.reply).toMatchObject({ ok: true, data: { counted: 2, excludedNegative: 1, heldOut: 1 } });
  });
});
