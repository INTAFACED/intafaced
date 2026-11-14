import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { AGENT_ORDERS_PATH, attachAgentAccountRoutes } from './agent-account-rest.js';
import { attachOwnAgentTradingRoutes } from './own-agent-trading-rest.js';
import { attachUserVenueRoutes, type UserVenueRestDeps } from './user-venue-rest.js';

// J-agents-21 #9 at the routes: an API key connected to an agent account calls the assistant's order route and no other
// venue route. Every other route refuses it 403 `auth.scope_denied` before anything is read, prepared or sent; a key
// that is not connected, and the person's own session, go on as before. The doors are off here (null), so a call that
// is let through answers the door's own `trade.user_venue_off` and one that is refused never gets that far.

const USER = '11111111-1111-4111-8111-1111111111d1';
const KEY = '22222222-2222-4222-8222-2222222222d2';
const session = { userId: USER, sub: USER, sid: 's-1', scopes: ['trade:read', 'trade:write'] } as unknown as Principal;
const apiKey = { ...session, kid: KEY } as unknown as Principal;
const OWNER = '0x00000000000000000000000000000000000000a1';
const ACCOUNT = '33333333-3333-4333-8333-3333333333d3';

let app: FastifyInstance;
afterEach(async () => app?.close());

async function mount(principal: Principal, agentKeyConfined: UserVenueRestDeps['agentKeyConfined']) {
  app = Fastify();
  const deps: UserVenueRestDeps = { requirePrincipal: () => principal, requireTradeJurisdiction: () => true, agentKeyConfined };
  attachUserVenueRoutes(app, null, deps);
  attachAgentAccountRoutes(app, null, deps, null);
  attachOwnAgentTradingRoutes(app, null, deps);
  await app.ready();
}

/** The four things the assistant tries in #9, and more of the venue door: each a route a connected key may not call. */
const OTHER_ROUTES = [
  // Move money: the agent account's own move out, and a transfer prepared on the plain door.
  { method: 'POST', url: `/api/v1/venue/agent-accounts/${ACCOUNT}/withdraw`, payload: { moveId: ACCOUNT, amount: '1' } },
  { method: 'POST', url: `/api/v1/venue/agent-accounts/${ACCOUNT}/fund`, payload: { moveId: ACCOUNT, amount: '1' } },
  // Withdraw from the venue.
  {
    method: 'POST',
    url: '/api/v1/venue/prepare',
    payload: { owner: OWNER, signer: { role: 'agent', address: OWNER }, intent: { kind: 'withdraw', asset: 'USDC', amount: '1' } },
  },
  // Read the main venue account.
  { method: 'GET', url: `/api/v1/venue/balances?owner=${OWNER}` },
  { method: 'GET', url: `/api/v1/venue/positions?owner=${OWNER}` },
  { method: 'GET', url: '/api/v1/venue/agent-accounts' },
  { method: 'POST', url: '/api/v1/venue/submit', payload: { actionKey: 'order:x:1', signature: {} } },
] as const;

describe('a connected agent key on the venue routes (J-agents-21 #9)', () => {
  it('is refused auth.scope_denied on every venue route but the assistant order route, before the door is reached', async () => {
    const asked: Principal[] = [];
    await mount(apiKey, async (p) => {
      asked.push(p);
      return true;
    });
    for (const r of OTHER_ROUTES) {
      const res = await app.inject(r);
      expect(res.statusCode, r.url).toBe(403);
      expect(res.json(), r.url).toMatchObject({ code: 'PermissionDenied', intafacedCode: 'auth.scope_denied' });
    }
    expect(asked.length).toBe(OTHER_ROUTES.length);
    // Its own route goes on (to the door, off here).
    const own = await app.inject({ method: 'POST', url: AGENT_ORDERS_PATH, payload: {} });
    expect(own.json().intafacedCode).toBe('trade.user_venue_off');
  });

  it('a key that is not connected, and the person own session, go on as before', async () => {
    await mount(apiKey, async () => false);
    expect((await app.inject({ method: 'GET', url: `/api/v1/venue/balances?owner=${OWNER}` })).json().intafacedCode).toBe(
      'trade.user_venue_off',
    );
    let asked = 0;
    await app.close();
    await mount(session, async () => {
      asked += 1;
      return true;
    });
    expect((await app.inject({ method: 'GET', url: `/api/v1/venue/balances?owner=${OWNER}` })).json().intafacedCode).toBe(
      'trade.user_venue_off',
    );
    expect(asked).toBe(0); // a session is never a key: nothing to ask
  });

  it('a check that fails refuses (503, retry-after), never lets the key through', async () => {
    await mount(apiKey, async () => {
      throw new Error('TEST: the connection store is down');
    });
    const res = await app.inject({ method: 'GET', url: `/api/v1/venue/balances?owner=${OWNER}` });
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe('1');
    expect(res.json().intafacedCode).toBe('trade.agent_key_check_unavailable');
  });
});
