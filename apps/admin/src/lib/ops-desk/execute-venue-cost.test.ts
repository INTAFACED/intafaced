import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DeskRequest } from '@/lib/desk/approval-packet';
import { opsExecute, readVenueCostAnswer } from './execute';

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
const request: DeskRequest = {
  kind: 'ops.venue_cost.record',
  period: '2026-10',
  category: 'custody',
  amount: '1250.50',
  asset: 'USD',
  reason: 'TEST invoice 4471 from the custodian',
};
const stored = { key: 'venue-cost:2026-10:custody:2', period: '2026-10', category: 'custody', amount: '1250.5', asset: 'USD', version: 2 };

afterEach(() => vi.unstubAllGlobals());

describe('venue cost entry', () => {
  it('sends the figure in stored form, the note, both approval ids and a key tied to the approval, to svc-ops through the edge', async () => {
    const fn = vi.fn(async (_u: string, _i?: RequestInit) => ok(stored));
    vi.stubGlobal('fetch', fn);
    const reply = await opsExecute(ctx)(request, ids);
    expect(reply).toMatchObject({ ok: true });
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe('http://edge:4000/api/ops/trpc/recordVenueCost');
    expect(JSON.parse(String(init!.body))).toEqual({
      period: '2026-10',
      category: 'custody',
      amount: '1250.5',
      asset: 'USD',
      sourceNote: 'TEST invoice 4471 from the custodian',
      idempotencyKey: 'venue-cost-approval:appr_1',
      ...ids,
    });
    expect((init!.headers as Record<string, string>).authorization).toBe('Bearer founder-access-token');
  });

  it('counts as done only when the stored entry is the one asked for', async () => {
    for (const body of [
      { ...stored, amount: '9' },
      { ...stored, category: 'data' },
      { ...stored, period: '2026-09' },
      { ...stored, asset: 'EUR' },
    ]) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ok(body)),
      );
      expect(await opsExecute(ctx)(request, ids)).toMatchObject({ ok: false, refusal: { changed: 'unknown' } });
    }
    expect(readVenueCostAnswer({ key: 'k' })).toBeNull();
  });

  it('a refusal with a typed code says nothing was saved', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => err(412, 'ops.cost_storage_unconfigured', 'ops.cost_storage_unconfigured')),
    );
    expect(await opsExecute(ctx)(request, ids)).toMatchObject({ ok: false, refusal: { changed: 'no' } });
  });

  it('a dropped connection is unknown, and the approval-keyed retry is safe', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('socket hang up'))),
    );
    expect(await opsExecute(ctx)(request, ids)).toMatchObject({ ok: false, refusal: { changed: 'unknown' } });
  });
});
