import { describe, expect, it } from 'vitest';
import { READ_FRESH_MS, type FetchLike, type Json } from './core.js';
import { HyperliquidTestnetUserVenue } from './venue.js';

/**
 * Shared reads (`shareReads`, on in the live venue server): every tester's desk reads the venue through one process,
 * so one address, which the venue limits by request weight a minute. A beta desk polling every 2 s answered 429 on
 * `userFees` mid-order (beta 93f2abe, 2026-11-25 12:31 UTC): "The venue refused it: info userFees answered HTTP 429".
 */
class Probe extends HyperliquidTestnetUserVenue {
  read(body: Record<string, Json>) {
    return this.info(body);
  }
  forget() {
    this.forgetReads();
  }
}

function setup(shareReads: boolean, answers: number[] = []) {
  let now = Date.parse('2026-11-25T12:00:00.000Z');
  const calls: string[] = [];
  const pending: Array<() => void> = [];
  let hold = false;
  const fetch: FetchLike = async (_url, init) => {
    calls.push(String((JSON.parse(init.body) as { type: string }).type));
    if (hold) await new Promise<void>((r) => pending.push(r));
    const status = answers.shift() ?? 200;
    return { ok: status === 200, status, text: async () => JSON.stringify({ n: calls.length }) };
  };
  const venue = new Probe({ appEnv: 'test', fetch, clock: () => new Date(now), timeoutMs: 5_000, shareReads });
  return {
    venue,
    calls,
    tick: (ms: number) => (now += ms),
    holdReads: () => (hold = true),
    release: () => pending.splice(0).forEach((r) => r()),
  };
}

describe('shared venue reads', () => {
  it('off (the default), every read goes to the venue', async () => {
    const s = setup(false);
    await s.venue.read({ type: 'openOrders', user: '0xa' });
    await s.venue.read({ type: 'openOrders', user: '0xa' });
    expect(s.calls).toEqual(['openOrders', 'openOrders']);
  });

  it('keeps an answer by its weight: a light read 2 s, a heavy one 15 s, fee rates and approvals 30 s', async () => {
    const s = setup(true);
    for (const [type, fresh] of [
      ['clearinghouseState', READ_FRESH_MS.light],
      ['openOrders', READ_FRESH_MS.heavy],
      ['userFees', READ_FRESH_MS.slow],
    ] as const) {
      s.calls.length = 0;
      const first = await s.venue.read({ type, user: '0xa' });
      s.tick(fresh - 1);
      expect(await s.venue.read({ type, user: '0xa' })).toEqual(first);
      await s.venue.read({ type, user: '0xb' }); // another account is its own read
      expect(s.calls).toEqual([type, type]);
      s.tick(1);
      await s.venue.read({ type, user: '0xa' });
      expect(s.calls).toEqual([type, type, type]);
    }
  });

  it('one read is in flight per request, however many desks ask', async () => {
    const s = setup(true);
    s.holdReads();
    const both = Promise.all([s.venue.read({ type: 'openOrders', user: '0xa' }), s.venue.read({ type: 'openOrders', user: '0xa' })]);
    await Promise.resolve();
    s.release();
    const [a, b] = await both;
    expect(a).toEqual(b);
    expect(s.calls).toEqual(['openOrders']);
  });

  it('a signed action drops every kept answer, and a read begun before it is not kept after it', async () => {
    const s = setup(true);
    await s.venue.read({ type: 'openOrders', user: '0xa' });
    s.venue.forget();
    await s.venue.read({ type: 'openOrders', user: '0xa' });
    expect(s.calls).toHaveLength(2);
    s.holdReads();
    const before = s.venue.read({ type: 'frontendOpenOrders', user: '0xa' });
    await Promise.resolve();
    s.venue.forget();
    s.release();
    await before;
    s.release();
    const after = s.venue.read({ type: 'frontendOpenOrders', user: '0xa' });
    await Promise.resolve();
    s.release();
    await after;
    expect(s.calls.filter((c) => c === 'frontendOpenOrders')).toHaveLength(2);
  });

  it('a read the venue answers 429 is tried once more; a second 429 is venue_down, and nothing is kept', async () => {
    const once = setup(true, [429, 200]);
    expect(await once.venue.read({ type: 'userFees', user: '0xa' })).toEqual({ n: 2 });
    const twice = setup(true, [429, 429]);
    await expect(twice.venue.read({ type: 'userFees', user: '0xa' })).rejects.toMatchObject({ refusal: { code: 'venue_down' } });
    await twice.venue.read({ type: 'userFees', user: '0xa' });
    expect(twice.calls).toHaveLength(3);
    const off = setup(false, [429]);
    await expect(off.venue.read({ type: 'userFees', user: '0xa' })).rejects.toMatchObject({ refusal: { code: 'venue_down' } });
    expect(off.calls).toHaveLength(1);
  });
});
