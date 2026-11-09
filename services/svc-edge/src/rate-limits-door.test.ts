import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { rateCostsOutputSchema } from '@intafaced/contracts/api-rate-limits';
import { registerRateLimitsDoor, RATE_COSTS_PATH, type RateLimitsDoorDeps } from './rate-limits-door.js';

const base = {
  tokens: {} as RateLimitsDoorDeps['tokens'],
  sessionLive: async () => undefined,
  buckets: {} as RateLimitsDoorDeps['buckets'],
  costs: [{ route: 'POST /api/v1/futures/orders', cost: 2 }],
  now: () => Date.parse('2026-11-09T02:00:00.000Z'),
};

async function read(address: RateLimitsDoorDeps['address']) {
  const app = Fastify();
  registerRateLimitsDoor(app, { ...base, address });
  await app.ready();
  return app.inject({ method: 'GET', url: RATE_COSTS_PATH });
}

describe('the edge rate-limits door (J-developer-06, J-derivatives-04 step 7)', () => {
  it('publishes the per-address limit it enforces with the cost table, in the contract’s shape', async () => {
    const res = await read({ max: 6000, windowMs: 60_000 });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(rateCostsOutputSchema.parse(res.json())).toEqual({
      asOf: '2026-11-09T02:00:00.000Z',
      costs: base.costs,
      address: { max: 6000, windowMs: 60_000 },
    });
  });

  it('says null when it enforces none, never a figure it does not hold', async () => {
    expect(rateCostsOutputSchema.parse((await read(null)).json()).address).toBeNull();
  });
});
