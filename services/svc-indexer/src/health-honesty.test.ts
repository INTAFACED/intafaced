/**
 * GET /health must not sell configured INDEXER_CHAIN_ID as live.
 * status.chain is the probe. Configured / unprobed is not chain ok.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { INDEXER_CHAIN_UNPROBED, indexerHealthHonesty } from './health-honesty.js';
import { BOOT_ENV, bootIndexer } from './testing/boot.js';

describe('indexer health honesty — unprobed is not a live chain', () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    while (apps.length) {
      const app = apps.pop();
      if (app) await app.close();
    }
  });

  it('payload has no chainId, observedChainId null, status unprobed', () => {
    const body = indexerHealthHonesty({ ingestEnabled: true, venue: null });
    expect(body).toEqual({
      ok: true,
      service: 'svc-indexer',
      ingestEnabled: true,
      clob: { live: false, kind: 'unset', reserves: false },
      chain: { status: 'unprobed', code: INDEXER_CHAIN_UNPROBED, observedChainId: null },
    });
    expect(body).not.toHaveProperty('custodial');
    expect(body).not.toHaveProperty('chainId');
    expect(JSON.stringify(body)).not.toMatch(/31337/);
  });

  it('GET /health as public-http mounts does not echo 31337', async () => {
    const app = Fastify({ logger: false });
    app.get('/health', async () => indexerHealthHonesty({ ingestEnabled: true, venue: null }));
    await app.ready();
    apps.push(app);
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.chainId).toBeUndefined();
    expect(body.chain).toEqual({
      status: 'unprobed',
      code: INDEXER_CHAIN_UNPROBED,
      observedChainId: null,
    });
    expect(JSON.stringify(body)).not.toMatch(/31337/);
  });

  it('index.ts and public-http.ts serve health via indexerHealthHonesty, not INDEXER_CHAIN_ID', async () => {
    // The booted service, on the Anvil chain id an operator may name: /health still names no chain id.
    const booted = await bootIndexer({ INDEXER_CHAIN_ID: '31337' });
    try {
      const res = await booted.app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Record<string, unknown>;
      expect(body).toEqual(
        JSON.parse(JSON.stringify(indexerHealthHonesty({ ingestEnabled: true, venue: BOOT_ENV.INDEXER_VENUE_ADDRESS ?? null }))),
      );
      expect(body).not.toHaveProperty('chainId');
      expect(JSON.stringify(body)).not.toMatch(/31337/);
    } finally {
      await booted.close();
    }
  });

  it('health-honesty.ts does not literal-stamp custodial:false', () => {
    // No custody claim at all, on any input: the answer never carries a custodial field to be read as "false".
    for (const ingestEnabled of [true, false]) {
      for (const venue of [null, BOOT_ENV.INDEXER_VENUE_ADDRESS ?? null, '0x0000000000000000000000000000000000000000']) {
        const body = indexerHealthHonesty({ ingestEnabled, venue });
        expect(body, `${ingestEnabled} ${venue}`).not.toHaveProperty('custodial');
        expect(JSON.stringify(body)).not.toMatch(/custodial/i);
      }
    }
  });
});
