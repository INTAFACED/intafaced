import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, serviceAuthHeadersForBody, signPrincipalHeader } from '@intafaced/contracts';
import { SealedHouseTenantRegistry } from '@intafaced/execution-house-tenant';
import { registerOmsBuyingPowerDoor } from './oms-buying-power-http.js';
import { registerOmsCareDoor } from './oms-care-http.js';
import { registerOmsDisplayQtyDoor } from './oms-iceberg-http.js';
import { registerOmsKillDoor } from './oms-kill-http.js';
import { registerOmsMmpDoor } from './oms-mmp-http.js';
import { registerOmsMultivenueDoor } from './oms-multivenue-http.js';
import { registerOmsOcoDoor } from './oms-oco-http.js';
import { registerOmsPaperDoor } from './oms-paper-http.js';
import { registerOmsPegDoor } from './oms-peg-http.js';
import { registerOmsTcaDoor } from './oms-tca-http.js';
import { createExecutionRouter } from './router.js';
import { installOmsWriteRawBody } from './oms-write-hmac.js';

const SECRET = 'a-execution-oms-hmac-rest-test-edge-secret';
const SERVICE_SECRET = 'a'.repeat(32);
const OP = '33333333-3333-4333-8333-333333333333';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-execution' });
const DIR = dirname(fileURLToPath(import.meta.url));

const LEFTOVER_HTTP = [
  '/execution/oms/drain',
  '/execution/oms/cod',
  '/execution/oms/venue-halt',
  '/execution/oms/display-qty',
  '/execution/oms/peg',
  '/execution/oms/oco',
  '/execution/oms/buying-power',
  '/execution/oms/mmp-post',
  '/execution/oms/mmp-hedge',
  '/execution/oms/mmp-mqq',
  '/execution/oms/care',
  '/execution/oms/care-manual-fill',
  '/execution/oms/tca',
  '/execution/oms/tca-claim',
  '/execution/oms/tca-parent',
  '/execution/oms/tca-markouts',
  '/execution/oms/paper',
  '/execution/oms/paper-extra',
  '/execution/oms/best-ex-claim',
  '/execution/oms/dex-route',
  '/execution/oms/plan',
] as const;

const HTTP_MILL_FILES = [
  'oms-kill-http.ts',
  'oms-iceberg-http.ts',
  'oms-peg-http.ts',
  'oms-oco-http.ts',
  'oms-buying-power-http.ts',
  'oms-mmp-http.ts',
  'oms-care-http.ts',
  'oms-tca-http.ts',
  'oms-paper-http.ts',
  'oms-multivenue-http.ts',
] as const;

function principal(): Principal {
  return {
    sub: OP,
    userId: OP,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['admin:read', 'admin:write'],
    tier: 'none',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
}

function signed() {
  const raw = encodePrincipal(principal());
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-session',
  });
}

function signedHeaders() {
  const raw = encodePrincipal(principal());
  return {
    'x-intafaced-principal': raw,
    'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
    'x-intafaced-region': 'DE',
  };
}

function hmacHeaders(caller: 'svc-execution' | 'svc-trade' = 'svc-execution', body = '{}') {
  return {
    'content-type': 'application/json',
    ...serviceAuthHeadersForBody(caller, SERVICE_SECRET, body),
  };
}

async function leftoverApp() {
  const f = Fastify();
  installOmsWriteRawBody(f);
  const deps = { edgeContext, internalSecret: SERVICE_SECRET };
  registerOmsKillDoor(f, deps);
  registerOmsDisplayQtyDoor(f, deps);
  registerOmsPegDoor(f, deps);
  registerOmsOcoDoor(f, deps);
  registerOmsBuyingPowerDoor(f, deps);
  registerOmsMmpDoor(f, deps);
  registerOmsCareDoor(f, deps);
  registerOmsTcaDoor(f, deps);
  registerOmsPaperDoor(f, deps);
  registerOmsMultivenueDoor(f, deps);
  await f.ready();
  return f;
}

describe('leftover OMS writes require HMAC as svc-execution', () => {
  it('oms tRPC block has no leftover admin:write — #3967 rest mill', () => {
    const src = readFileSync(join(DIR, 'router.ts'), 'utf8');
    const oms = src.slice(src.indexOf('oms: router({'), src.indexOf('policy: publicProcedure'));
    expect(oms).not.toMatch(/scopedProcedure\('admin:write'/);
    expect(oms).toMatch(/omsWriteProcedure/);
    // Founder halt is execution.ops, not an OMS write. Session admin:write stays inside that block.
    const opsStart = src.indexOf('ops: router({');
    const opsEnd = src.indexOf('oms: router({');
    const outsideOps = src.slice(0, opsStart) + src.slice(opsEnd);
    expect(src.slice(opsStart, opsEnd)).toMatch(/scopedProcedure\('admin:write'/);
    expect(outsideOps).not.toMatch(/scopedProcedure\('admin:write'/);
    expect(src).toMatch(/tenant: router\([\s\S]*omsWriteProcedure/);
    expect(src).toMatch(/arb: router\([\s\S]*omsWriteProcedure/);
    expect(src).toMatch(/mm: router\([\s\S]*omsWriteProcedure/);
  });

  it('leftover HTTP mill files HMAC and drop session admin:write', () => {
    for (const name of HTTP_MILL_FILES) {
      const src = readFileSync(join(DIR, name), 'utf8');
      expect(src, name).toMatch(/authorizeOmsWriteRequest/);
      expect(src, name).not.toMatch(/hasAdminWrite/);
      expect(src, name).not.toMatch(/admin:write/);
    }
  });

  it('session-only admin:write cannot start / slice / drain', async () => {
    const caller = createExecutionRouter(new SealedHouseTenantRegistry()).createCaller(signed());
    await expect(caller.execution.oms.start({ parentClientOrderId: 'p1' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    await expect(caller.execution.oms.slice({ parentClientOrderId: 'p1' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    await expect(caller.execution.oms.drain({ parentClientOrderId: 'p1' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('svc-trade HMAC is FORBIDDEN on leftover tRPC start', async () => {
    const caller = createExecutionRouter(new SealedHouseTenantRegistry()).createCaller({
      ...signed(),
      service: 'svc-trade',
    });
    await expect(caller.execution.oms.start({ parentClientOrderId: 'p1' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('session-only admin:write is 401 on leftover HTTP POSTs', async () => {
    const f = await leftoverApp();
    for (const url of LEFTOVER_HTTP) {
      const res = await f.inject({ method: 'POST', url, headers: signedHeaders(), payload: {} });
      expect({ url, status: res.statusCode, body: res.json() }).toMatchObject({
        url,
        status: 401,
        body: { code: 'UNAUTHORIZED' },
      });
    }
    await f.close();
  });

  it('svc-trade HMAC is 403 on leftover HTTP POSTs', async () => {
    const f = await leftoverApp();
    const payload = {};
    const body = JSON.stringify(payload);
    for (const url of LEFTOVER_HTTP) {
      const res = await f.inject({
        method: 'POST',
        url,
        headers: {
          'content-type': 'application/json',
          ...serviceAuthHeadersForBody('svc-trade', SERVICE_SECRET, body),
        },
        payload: body,
      });
      expect({ url, status: res.statusCode, body: res.json() }).toMatchObject({
        url,
        status: 403,
        body: { code: 'FORBIDDEN' },
      });
    }
    await f.close();
  });

  it('svc-execution HMAC is not 401 on leftover HTTP POSTs', async () => {
    const f = await leftoverApp();
    const body = '{}';
    for (const url of LEFTOVER_HTTP) {
      const res = await f.inject({
        method: 'POST',
        url,
        headers: hmacHeaders('svc-execution', body),
        payload: body,
      });
      expect(res.statusCode, url).not.toBe(401);
      expect(res.statusCode, url).not.toBe(403);
    }
    await f.close();
  });

  it('leftover HTTP POSTs 401 when the v2 digest does not match the retained body', async () => {
    const f = await leftoverApp();
    const res = await f.inject({
      method: 'POST',
      url: '/execution/oms/drain',
      headers: hmacHeaders('svc-execution', '{"tampered":true}'),
      payload: '{}',
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'UNAUTHORIZED' });
    await f.close();
  });
});
