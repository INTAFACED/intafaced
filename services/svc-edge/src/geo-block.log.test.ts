import { Writable } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SANCTIONS_REGIONS_ENV, SANCTIONS_SOURCE_ENV } from '@intafaced/config';
import { registerGeoBlockGuard } from './control-plane.js';
import { GEO_BLOCK_HIT_CODE } from './geo-block.js';

vi.stubEnv('APP_ENV', 'test');

/**
 * A geo-block refusal's log line carries the reason code and a count, never
 * the caller's region: on a hit, that region is one entry of the
 * `INTAFACED_SANCTIONS_REGIONS` secret, and Edge's log reaches public CI job
 * logs. QZ is an ISO user-assigned code; the other stand-ins say TEST.
 */
const REGION = 'QZ';
const REASON = 'TEST-REASON-2d8f-stand-in';
const SOURCE = 'TEST-SOURCE-6a1c-stand-in';

const apps: FastifyInstance[] = [];

afterEach(async () => {
  while (apps.length) await apps.pop()?.close();
  delete process.env[SANCTIONS_REGIONS_ENV];
  delete process.env[SANCTIONS_SOURCE_ENV];
  delete process.env.DEFAULT_REGION;
});

async function edgeWithCapturedLog(): Promise<{ app: FastifyInstance; read: () => string }> {
  let raw = '';
  const stream = new Writable({
    write(chunk, _enc, done) {
      raw += String(chunk);
      done();
    },
  });
  const app = Fastify({ logger: { level: 'info', stream } });
  registerGeoBlockGuard(app);
  app.all('/api/*', async () => ({ ok: true }));
  await app.ready();
  apps.push(app);
  return { app, read: () => raw };
}

describe('geo-block refusal log carries no region value', () => {
  it('a hit on a listed region logs the code, the reason and a count, never the region or the list', async () => {
    process.env[SANCTIONS_REGIONS_ENV] = `${REGION}:${REASON}`;
    process.env[SANCTIONS_SOURCE_ENV] = SOURCE;
    process.env.DEFAULT_REGION = REGION;
    const { app, read } = await edgeWithCapturedLog();

    const first = await app.inject({ method: 'GET', url: '/api/trade/health' });
    const second = await app.inject({ method: 'GET', url: '/api/trade/health' });
    expect(first.statusCode).toBeGreaterThanOrEqual(400);
    expect(second.statusCode).toBeGreaterThanOrEqual(400);

    const raw = read();
    const refusals = raw
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l.msg === 'edge: refused — geo-block / empty screening');
    expect(refusals).toHaveLength(2);
    expect(refusals[0]).toMatchObject({ code: GEO_BLOCK_HIT_CODE, reason: 'region_listed', declaration: 'listed', refusals: 1 });
    expect(refusals[1]).toMatchObject({ refusals: 2 });
    for (const line of refusals) expect(line).not.toHaveProperty('region');

    expect(raw).not.toMatch(new RegExp(`\\b${REGION}\\b`));
    expect(raw).not.toContain(REASON);
    expect(raw).not.toContain(SOURCE);
  });
});
