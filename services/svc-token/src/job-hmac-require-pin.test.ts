/**
 * Unit card — production token job mutate mounts hardcode HMAC bodyBind require
 *
 * 1. Promise: live POST /internal/{emissions,buyback,yield}/* 401 unbound v1
 *    HMAC even while fleet compose stays INTERNAL_SERVICE_BODY_BIND:-accept-both.
 * 2. Break: index.ts passed bodyBind: env.INTERNAL_SERVICE_BODY_BIND to the
 *    three mutate registers, so the compose default kept accept-both on mint,
 *    buyback, and yield jobs.
 * 3. Done bar: registerInternalEmissions / Yield / Buyback mounts are
 *    bodyBind: 'require' — not the env. GET /internal/stake/:userId may stay
 *    env. Callers already send serviceAuthHeadersForBody.
 * 4. Class N
 * 5. Paths: services/svc-token/src/index.ts (production mounts only)
 * 6. RED: origin/main passing the shared `bodyBind` env flag into mutate jobs
 * 7. Collision: none — does not touch docker-compose.apps.yml or config pins.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { serviceAuthHeaders, serviceAuthHeadersForBody } from '@intafaced/contracts';
import { parseAmount } from '@intafaced/ledger-client';
import { registerInternalBuyback } from './internal-buyback.js';
import { registerInternalEmissions } from './internal-emissions.js';
import { registerInternalYield } from './internal-yield.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const COMPOSE = join(HERE, '../../../docker-compose.apps.yml');
const SECRET = 'a'.repeat(32);

describe('the deployed svc-token job mutate mounts require body-bound HMAC', () => {
  it('does not flip the compose INTERNAL_SERVICE_BODY_BIND default', () => {
    const compose = readFileSync(COMPOSE, 'utf8');
    expect(compose).toMatch(/INTERNAL_SERVICE_BODY_BIND:\s*\$\{INTERNAL_SERVICE_BODY_BIND:-accept-both\}/);
    expect(compose).not.toMatch(/INTERNAL_SERVICE_BODY_BIND:.*:-require/);
  });

  it('v1 HMAC is 401 on mutate jobs when production mode require is mounted', async () => {
    const app = Fastify({ logger: false });
    registerInternalEmissions(app, {
      internalSecret: SECRET,
      emissionsEnabled: true,
      mintNextEpoch: async () => ({ epoch: 0, minted: parseAmount('1') }),
      bodyBind: 'require',
    });
    registerInternalYield(app, {
      internalSecret: SECRET,
      yieldJobEnabled: true,
      runWindow: async () => ({
        windowId: 'w1',
        distributed: parseAmount('1'),
        recipients: 0,
        skipped: 0,
        alreadyPaid: 0,
      }),
      bodyBind: 'require',
      installRawBody: false,
    });
    registerInternalBuyback(app, {
      internalSecret: SECRET,
      buybackJobEnabled: true,
      runWindow: async () => ({
        runId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        tokensBought: parseAmount('1'),
        burned: parseAmount('1'),
        toRewards: parseAmount('0'),
      }),
      bodyBind: 'require',
      installRawBody: false,
    });
    await app.ready();

    const v1 = serviceAuthHeaders('svc-token', SECRET);
    const mint = await app.inject({ method: 'POST', url: '/internal/emissions/mint-next', headers: v1 });
    expect(mint.statusCode).toBe(401);
    expect(mint.json().code).toBe('token.unauthenticated');

    const yieldBody = JSON.stringify({ windowId: 'w1' });
    const yieldRes = await app.inject({
      method: 'POST',
      url: '/internal/yield/run-window',
      headers: { 'content-type': 'application/json', ...v1 },
      payload: yieldBody,
    });
    expect(yieldRes.statusCode).toBe(401);
    expect(yieldRes.json().code).toBe('token.unauthenticated');

    const buyBody = JSON.stringify({
      runId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      revenueWindow: { from: '2026-07-01T00:00:00.000Z', to: '2026-07-08T00:00:00.000Z' },
    });
    const buy = await app.inject({
      method: 'POST',
      url: '/internal/buyback/run-window',
      headers: { 'content-type': 'application/json', ...v1 },
      payload: buyBody,
    });
    expect(buy.statusCode).toBe(401);
    expect(buy.json().code).toBe('token.unauthenticated');

    const bound = await app.inject({
      method: 'POST',
      url: '/internal/emissions/mint-next',
      headers: serviceAuthHeadersForBody('svc-token', SECRET, ''),
    });
    expect(bound.statusCode).toBe(200);
    await app.close();
  });
});
