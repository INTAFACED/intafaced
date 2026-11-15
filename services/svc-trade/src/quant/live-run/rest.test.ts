import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { attachLiveRunRoutes, KEY_NO_DEPLOY, LIVE_RUNS_PATH } from './rest.js';
import type { LiveRuns } from './live-runs.js';

// J-algo-dev-14 #6 and #7: a key can't start (deploy) a live run, and stops one under the screen's own rules.

const session: Principal = {
  sub: '00000000-0000-4000-8000-000000000001',
  userId: '00000000-0000-4000-8000-000000000001',
  sid: '00000000-0000-4000-8000-000000000002',
  scopes: ['trade:read', 'trade:write'],
  tier: 'basic',
  mfa: false,
  expiresAt: new Date(Date.now() + 60_000),
};
const key = { ...session, kid: '00000000-0000-4000-8000-000000000003' } as Principal;

function app(principal: Principal, calls: string[]) {
  const runs = {
    start: async () => {
      calls.push('start');
      return { state: 'signing' };
    },
    stop: async () => {
      calls.push('stop');
      return { state: 'stopped' };
    },
  } as Pick<LiveRuns, 'start' | 'stop'> as LiveRuns; // oxlint-disable-line garden(no-double-cast) -- a fake of the two methods these routes call
  const server = Fastify();
  attachLiveRunRoutes(server, runs, {
    requirePrincipal: () => principal,
    requireTradeJurisdiction: () => true,
    regionOf: () => 'XX',
  });
  return server;
}

describe('live runs by API key', () => {
  it('refuses a key that starts a run: 404 quant.key_no_such_endpoint, nothing started', async () => {
    const calls: string[] = [];
    const res = await app(key, calls).inject({ method: 'POST', url: LIVE_RUNS_PATH, payload: { runId: 'r' } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual(KEY_NO_DEPLOY);
    expect(calls).toEqual([]);
  });

  it('a session starts one as before', async () => {
    const calls: string[] = [];
    const res = await app(session, calls).inject({ method: 'POST', url: LIVE_RUNS_PATH, payload: { runId: 'r' } });
    expect(res.statusCode).toBe(200);
    expect(calls).toEqual(['start']);
  });

  it('a key with trade:write stops a run through the same route as the screen', async () => {
    const calls: string[] = [];
    const res = await app(key, calls).inject({ method: 'POST', url: `${LIVE_RUNS_PATH}/r/stop`, payload: { seq: 1 } });
    expect(res.statusCode).toBe(200);
    expect(calls).toEqual(['stop']);
  });

  it('a key without trade:write is refused the stop and nothing is sent', async () => {
    const calls: string[] = [];
    const res = await app({ ...key, scopes: ['trade:read'] } as Principal, calls).inject({
      method: 'POST',
      url: `${LIVE_RUNS_PATH}/r/stop`,
      payload: { seq: 1 },
    });
    expect(res.statusCode).toBe(403);
    expect(calls).toEqual([]);
  });
});
