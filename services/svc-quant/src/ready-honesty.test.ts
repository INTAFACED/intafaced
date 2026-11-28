/**
 * GET /ready must not sell isolate as wired when the lake is missing.
 * Isolate wired is not lake wired. missingLake is named, not silent.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { missingLake } from './backtest/lake.js';
import { QUANT_BACKTEST_LAKE_MISSING, QUANT_SANDBOX_UNWIRED } from './errors.js';
import { quantReadyHonesty } from './ready-honesty.js';

describe('quant /ready honesty — isolate wired is not a missing lake', () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    while (apps.length) {
      const app = apps.pop();
      if (app) await app.close();
    }
  });

  it('does not sell isolate as wired when the lake is missing', () => {
    const lake = missingLake();
    const body = quantReadyHonesty({ isolateWired: true, lakeWired: lake.wired, venueVaultSet: false });
    expect(lake.wired).toBe(false);
    expect(body).toEqual({
      ready: true,
      isolate: 'unwired',
      lake: 'missing',
      refuse: QUANT_BACKTEST_LAKE_MISSING,
      venueVault: 'unset',
    });
    expect(body.isolate).not.toBe('wired');
    expect(body).not.toHaveProperty('custodial');
  });

  it('sells isolate as wired only when isolate and lake are both wired', () => {
    const body = quantReadyHonesty({ isolateWired: true, lakeWired: true, venueVaultSet: true });
    expect(body).toEqual({
      ready: true,
      isolate: 'wired',
      lake: 'wired',
      refuse: null,
      venueVault: 'trade-only',
    });
    expect(body).not.toHaveProperty('custodial');
  });

  it('names sandbox unwired when the lake is wired and the isolate is not', () => {
    const body = quantReadyHonesty({ isolateWired: false, lakeWired: true, venueVaultSet: false });
    expect(body.isolate).toBe('unwired');
    expect(body.lake).toBe('wired');
    expect(body.refuse).toBe(QUANT_SANDBOX_UNWIRED);
  });

  it('GET /ready as index.ts mounts does not hardcode isolate wired over missingLake', async () => {
    const lake = missingLake();
    const app = Fastify({ logger: false });
    app.get('/ready', async () => quantReadyHonesty({ isolateWired: true, lakeWired: lake.wired, venueVaultSet: false }));
    await app.ready();
    apps.push(app);
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.isolate).toBe('unwired');
    expect(body.lake).toBe('missing');
    expect(body.refuse).toBe(QUANT_BACKTEST_LAKE_MISSING);
    expect(body.ready).toBe(true);
    expect(body).not.toHaveProperty('custodial');
  });

  it('stamps no custodial claim for any wiring (served by index.ts: index-boot.test.ts)', () => {
    for (const isolateWired of [true, false]) {
      for (const lakeWired of [true, false]) {
        for (const venueVaultSet of [true, false]) {
          const body = quantReadyHonesty({ isolateWired, lakeWired, venueVaultSet });
          expect(body).not.toHaveProperty('custodial');
          expect(JSON.stringify(body)).not.toMatch(/custod/i);
        }
      }
    }
  });
});
