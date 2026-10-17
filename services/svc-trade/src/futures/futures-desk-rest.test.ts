import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerPublicRest, type PublicRestDeps } from '../public-rest.js';
import { readTradePlanes } from './plane-capabilities.js';

describe('GET /api/v1/capabilities plane switch', () => {
  it('reports the same futures flag a write refuses on, with no operator permission', async () => {
    const previous = process.env.TRADE_FUTURES_ENABLED;
    process.env.TRADE_FUTURES_ENABLED = 'false';
    const app = Fastify();
    registerPublicRest(app, { now: () => 1 } as unknown as PublicRestDeps);
    await app.ready();
    try {
      const off = await app.inject({ method: 'GET', url: '/api/v1/capabilities' });
      expect(off.statusCode).toBe(200);
      expect(off.json().futures).toEqual({ enabled: false, reason: 'trade.futures_disabled' });
      expect(off.json().spot).toEqual(readTradePlanes().spot);
      expect(off.json().futures).toEqual(readTradePlanes().futures);
      expect(JSON.stringify({ spot: off.json().spot, futures: off.json().futures })).not.toMatch(/secret|operator|token/i);

      process.env.TRADE_FUTURES_ENABLED = 'true';
      const on = await app.inject({ method: 'GET', url: '/api/v1/capabilities' });
      expect(on.json().futures).toEqual({ enabled: true });
      expect(on.json().spot.enabled).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.TRADE_FUTURES_ENABLED;
      else process.env.TRADE_FUTURES_ENABLED = previous;
      await app.close();
    }
  });
});
