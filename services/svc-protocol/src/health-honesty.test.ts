/**
 * GET /health and tRPC health must not sell Anvil 31337 as the chain.
 * chainStatus is the probe. Configured / unprobed is not chain ok.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { PROTOCOL_CHAIN_UNPROBED, protocolHealthHonesty } from './health-honesty.js';

describe('protocol health honesty — unprobed is not a live chain', () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    while (apps.length) {
      const app = apps.pop();
      if (app) await app.close();
    }
  });

  it('payload has no chainId, observedChainId null, status unprobed', () => {
    const body = protocolHealthHonesty({
      relayEnabled: true,
      factoryConfigured: false,
      venueVaultConfigured: false,
    });
    expect(body).toEqual({
      ok: true,
      service: 'svc-protocol',
      relayEnabled: true,
      factoryConfigured: false,
      venueVaultConfigured: false,
      chain: { status: 'unprobed', code: PROTOCOL_CHAIN_UNPROBED, observedChainId: null },
    });
    expect(body).not.toHaveProperty('custodial');
    expect(body).not.toHaveProperty('chainId');
    expect(JSON.stringify(body)).not.toMatch(/31337/);
  });

  it('GET /health as index.ts mounts does not echo 31337', async () => {
    const app = Fastify({ logger: false });
    app.get('/health', async () =>
      protocolHealthHonesty({
        relayEnabled: true,
        factoryConfigured: false,
        venueVaultConfigured: false,
      }),
    );
    await app.ready();
    apps.push(app);
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body).not.toHaveProperty('custodial');
    expect(body.chainId).toBeUndefined();
    expect(body.chain).toEqual({
      status: 'unprobed',
      code: PROTOCOL_CHAIN_UNPROBED,
      observedChainId: null,
    });
    expect(JSON.stringify(body)).not.toMatch(/31337/);
  });

  it('stamps no custodial claim for any wiring (index.ts and the router serve it: index-boot.test.ts)', () => {
    for (const relayEnabled of [true, false]) {
      for (const factoryConfigured of [true, false]) {
        for (const venueVaultConfigured of [true, false, undefined]) {
          const body = protocolHealthHonesty({ relayEnabled, factoryConfigured, venueVaultConfigured });
          expect(body).not.toHaveProperty('custodial');
          expect(JSON.stringify(body)).not.toMatch(/custod/i);
        }
      }
    }
  });
});
