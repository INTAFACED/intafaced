import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadWaves, wavesExecute } from './waves-server';

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
const wave = (waveNumber: number, releasedCount = 2) => ({
  id: '22222222-2222-4222-8222-222222222222',
  waveNumber,
  size: 2,
  releasedCount,
  flagKey: 'waitlist.enabled',
  releasedBy: '11111111-1111-4111-8111-111111111111',
  approvedBy: '33333333-3333-4333-8333-333333333333',
  releasedAt: '2026-10-24T06:00:00.000Z',
});
const ok = (data: unknown) => Response.json({ result: { data } });
const err = (status: number, message: string) =>
  Response.json({ error: { message, code: -32603, data: { code: 'BAD_REQUEST', httpStatus: status } } }, { status });

afterEach(() => vi.unstubAllGlobals());

describe('waitlist waves desk', () => {
  it('reads the waves as the founder and stamps the read time', async () => {
    const fn = vi.fn(async (_u: string, _i?: RequestInit) => ok({ waveSize: 2, nextWave: 2, waiting: 7, waves: [wave(1)] }));
    vi.stubGlobal('fetch', fn);
    const view = await loadWaves(ctx);
    expect(fn.mock.calls[0]![0]).toBe('http://edge:4000/api/identity/trpc/waitlist.waves.list');
    expect((fn.mock.calls[0]![1]!.headers as Record<string, string>).authorization).toBe('Bearer founder-access-token');
    expect(view.state).toEqual({ kind: 'ok', data: expect.objectContaining({ waveSize: 2, nextWave: 2, waiting: 7 }) });
    expect(Number.isFinite(Date.parse(view.asOf))).toBe(true);
  });

  it('a blank owner size reads as null, and a malformed answer is a failed read', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok({ waveSize: null, nextWave: 1, waiting: 3, waves: [] })),
    );
    expect((await loadWaves(ctx)).state).toMatchObject({ kind: 'ok', data: { waveSize: null } });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok({ waveSize: '2', nextWave: 1, waiting: 3, waves: [] })),
    );
    expect((await loadWaves(ctx)).state.kind).toBe('failed');
  });

  it('release sends the wave number and both approval ids, and reports done for the approved wave', async () => {
    const fn = vi.fn(async (_u: string, _i?: RequestInit) => ok({ created: true, wave: wave(3) }));
    vi.stubGlobal('fetch', fn);
    const result = await wavesExecute(ctx)({ kind: 'campaigns.waitlist.wave_release', wave: '3', size: '2' }, ids);
    expect(result).toMatchObject({ ok: true, detail: expect.stringContaining('wave 3 released 2 of 2') });
    expect(fn.mock.calls[0]![0]).toBe('http://edge:4000/api/identity/trpc/waitlist.waves.release');
    expect(JSON.parse(String(fn.mock.calls[0]![1]!.body))).toEqual({ waveNumber: 3, ...ids });
  });

  it('a replay says nothing new was released; a different wave back is never a success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok({ created: false, wave: wave(3) })),
    );
    expect(await wavesExecute(ctx)({ kind: 'campaigns.waitlist.wave_release', wave: '3', size: '2' }, ids)).toMatchObject({
      ok: true,
      detail: expect.stringContaining('already released'),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok({ created: true, wave: wave(4) })),
    );
    expect(await wavesExecute(ctx)({ kind: 'campaigns.waitlist.wave_release', wave: '3', size: '2' }, ids)).toMatchObject({
      ok: false,
    }); // The stored wave 3 has size 2; a request approved for size 5 never ran.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok({ created: false, wave: wave(3) })),
    );
    expect(await wavesExecute(ctx)({ kind: 'campaigns.waitlist.wave_release', wave: '3', size: '5' }, ids)).toMatchObject({
      ok: false,
    });
  });

  it('explains identity’s typed refusals in words and says nothing changed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => err(412, 'The owner has not set the wave size [drop.wave_unset]')),
    );
    expect(await wavesExecute(ctx)({ kind: 'campaigns.waitlist.wave_release', wave: '1', size: '2' }, ids)).toMatchObject({
      ok: false,
      refusal: { code: 'drop.wave_unset', changed: 'no' },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => err(409, 'Wave 9 is not the next wave (2) [waitlist.wave_unknown]')),
    );
    expect(await wavesExecute(ctx)({ kind: 'campaigns.waitlist.wave_release', wave: '9', size: '2' }, ids)).toMatchObject({
      ok: false,
      refusal: { code: 'waitlist.wave_unknown', changed: 'no' },
    });
  });

  it('a switched-off waitlist names the switch, not a race', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => err(412, 'waitlist.enabled is off [flag.waitlist.enabled.disabled]')),
    );
    expect(await wavesExecute(ctx)({ kind: 'campaigns.waitlist.wave_release', wave: '1', size: '2' }, ids)).toMatchObject({
      ok: false,
      refusal: { code: 'flag.waitlist.enabled.disabled', title: 'The waitlist is switched off' },
    });
  });

  it('a dropped connection on a release is outcome unknown', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('socket'))),
    );
    expect(await wavesExecute(ctx)({ kind: 'campaigns.waitlist.wave_release', wave: '1', size: '2' }, ids)).toMatchObject({
      ok: false,
      refusal: { changed: 'unknown' },
    });
  });

  it('refuses a request kind that is not a wave release', async () => {
    expect(await wavesExecute(ctx)({ kind: 'ledger.unfreeze', version: 'v' }, ids)).toMatchObject({ ok: false });
  });
});
