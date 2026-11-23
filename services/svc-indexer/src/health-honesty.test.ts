/**
 * GET /health must not sell configured INDEXER_CHAIN_ID as live.
 * status.chain is the probe. Configured / unprobed is not chain ok.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { INDEXER_CHAIN_UNPROBED, indexerHealthHonesty } from './health-honesty.js';

const here = dirname(fileURLToPath(import.meta.url));

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

  it('index.ts and public-http.ts serve health via indexerHealthHonesty, not INDEXER_CHAIN_ID', () => {
    const indexSrc = readFileSync(join(here, 'index.ts'), 'utf8');
    const publicSrc = readFileSync(join(here, 'public-http.ts'), 'utf8');
    expect(publicSrc).toContain('indexerHealthHonesty');
    expect(publicSrc).not.toMatch(/app\.get\('\/health'[\s\S]{0,400}chainId:\s*deps\.chainId/);
    expect(indexSrc).not.toMatch(/app\.get\('\/health'[\s\S]{0,400}chainId:\s*env\.INDEXER_CHAIN_ID/);
  });

  it('health-honesty.ts does not literal-stamp custodial:false', () => {
    const src = readFileSync(join(here, 'health-honesty.ts'), 'utf8');
    expect(src).not.toMatch(/custodial:\s*z\.literal\(false\)/);
    expect(src).not.toMatch(/custodial:\s*false\s+as const/);
    expect(src).not.toMatch(/custodial:\s*false/);
  });
});
