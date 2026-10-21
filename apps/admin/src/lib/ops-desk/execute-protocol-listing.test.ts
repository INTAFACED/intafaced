import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DeskRequest } from '@/lib/desk/approval-packet';
import { opsExecute, readListingAnswer } from './execute';

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
const ids = { approvalId: 'appr_1', operationId: 'op_1' };
const ok = (data: unknown) => Response.json({ result: { data } });
const err = (status: number, message: string, code: string) =>
  Response.json({ error: { message, code: -32603, data: { code: 'X', httpStatus: status, cause: { code } } } }, { status });
const POOL = '0xAbCdEf0123456789aBcDeF0123456789abCDef01';
const hide: DeskRequest = {
  kind: 'protocol.pool.hide',
  chainId: 84532,
  poolAddress: POOL,
  reasonCode: 'scam_report',
  reason: 'TEST reported as a copy',
};
const poolAnswer = (state: string, outcome = 'applied') => ({
  action: 'protocol.pool.hide',
  targetId: `84532:${POOL.toLowerCase()}`,
  state,
  outcome,
  note: null,
});

afterEach(() => vi.unstubAllGlobals());

describe('protocol listing execution', () => {
  it('sends the pool, the reason code, the reason and both approval ids to svc-ops through the edge', async () => {
    const fn = vi.fn(async (_u: string, _i?: RequestInit) => ok(poolAnswer('hidden')));
    vi.stubGlobal('fetch', fn);
    expect(await opsExecute(ctx)(hide, ids)).toMatchObject({ ok: true });
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe('http://edge:4000/api/ops/trpc/protocolListing.pools.hide');
    expect(JSON.parse(String(init!.body))).toEqual({
      chainId: 84532,
      poolAddress: POOL,
      reasonCode: 'scam_report',
      reason: 'TEST reported as a copy',
      ...ids,
    });
  });

  it('calls the market procedures with the symbol only for a relist', async () => {
    const fn = vi.fn(async (_u: string, _i?: RequestInit) =>
      ok({ ...poolAnswer('visible'), action: 'protocol.market.restore', targetId: 'IFC-USD' }),
    );
    vi.stubGlobal('fetch', fn);
    expect(await opsExecute(ctx)({ kind: 'protocol.market.restore', symbol: 'IFC-USD' }, ids)).toMatchObject({ ok: true });
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe('http://edge:4000/api/ops/trpc/protocolListing.markets.restore');
    expect(JSON.parse(String(init!.body))).toEqual({ symbol: 'IFC-USD', ...ids });
  });

  it('counts as done only when svc-ops shows the asked action, target and state', async () => {
    for (const body of [
      poolAnswer('visible'),
      { ...poolAnswer('hidden'), targetId: 'other' },
      { ...poolAnswer('hidden'), action: 'protocol.pool.restore' },
    ]) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ok(body)),
      );
      expect(await opsExecute(ctx)(hide, ids)).toMatchObject({ ok: false, refusal: { changed: 'unknown' } });
    }
    expect(readListingAnswer({ action: 'x' })).toBeNull();
  });

  it('says a second approval on a hidden pool changed nothing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok(poolAnswer('hidden', 'noop'))),
    );
    const reply = await opsExecute(ctx)(hide, ids);
    expect(reply).toMatchObject({ ok: true, detail: expect.stringContaining('nothing changed') });
  });

  it('a typed refusal says nothing changed, and a dropped connection is unknown', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => err(412, 'owner.decision', 'owner.decision')),
    );
    expect(await opsExecute(ctx)(hide, ids)).toMatchObject({ ok: false, refusal: { changed: 'no' } });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('socket hang up'))),
    );
    expect(await opsExecute(ctx)(hide, ids)).toMatchObject({ ok: false, refusal: { changed: 'unknown' } });
  });
});
