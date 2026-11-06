import { describe, expect, it } from 'vitest';
import { createMarketMaintenanceReader } from './market-maintenance-read.js';

const WINDOW = {
  id: '00000000-0000-4000-8000-000000000001',
  title: 'TEST maintenance',
  markets: ['market-btc-usdc'],
  startsAt: '2026-11-06T10:00:00.000Z',
  endsAt: null,
};

function fetcherOf(reply: () => Response | Promise<Response>) {
  const calls: string[] = [];
  const fetcher = (async (url: string | URL) => {
    calls.push(String(url));
    return reply();
  }) as unknown as typeof fetch;
  return { calls, fetcher };
}

const ok = (data: unknown) => new Response(JSON.stringify({ result: { data } }), { status: 200 });

describe('market maintenance reader (J-cex-spot-14 #5)', () => {
  it("reads svc-notify's signed-out window list and keeps it for a few seconds", async () => {
    let t = 0;
    const { calls, fetcher } = fetcherOf(() => ok({ windows: [WINDOW] }));
    const read = createMarketMaintenanceReader({ notifyUrl: 'http://notify:4010/', fetcher, ttlMs: 5_000, now: () => t });
    expect(await read()).toEqual({ windows: [WINDOW] });
    t = 4_000;
    await read();
    expect(calls).toEqual(['http://notify:4010/trpc/notify.marketMaintenance']);
    t = 5_000;
    await read();
    expect(calls).toHaveLength(2);
  });

  it('no address, a refusal, a reply that does not parse, or a failed call all read as null (unavailable)', async () => {
    expect(await createMarketMaintenanceReader({})()).toBeNull();
    const refused = fetcherOf(() => new Response('{}', { status: 412 }));
    expect(await createMarketMaintenanceReader({ notifyUrl: 'http://notify:4010', fetcher: refused.fetcher })()).toBeNull();
    const garbled = fetcherOf(() => ok({ windows: [{ ...WINDOW, markets: ['BTC/USDC'] }] }));
    expect(await createMarketMaintenanceReader({ notifyUrl: 'http://notify:4010', fetcher: garbled.fetcher })()).toBeNull();
    const down = fetcherOf(() => {
      throw new Error('connect ECONNREFUSED');
    });
    expect(await createMarketMaintenanceReader({ notifyUrl: 'http://notify:4010', fetcher: down.fetcher })()).toBeNull();
  });
});
