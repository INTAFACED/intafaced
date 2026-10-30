import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { StepUpCheckError } from '@intafaced/contracts';
import { GridError } from './errors.js';
import { attachGridRestRoutes } from './grid-rest.js';
import type { GridBotView, GridService } from './grid-service.js';

const OWNER = { userId: '11111111-1111-4111-8111-111111111111', sid: 's-1', scopes: ['trade:read', 'trade:write'] } as unknown as Principal;

function bot(over: Partial<GridBotView> = {}): GridBotView {
  return { botId: 'bot-1', clientRequestId: 'grid-req-0001', symbol: 'BTC/USDT', status: 'running', ...over } as GridBotView;
}

/** A grid service that records each call and answers what the test sets. */
function fakeGrid(answers: Partial<Record<keyof GridService, (...args: unknown[]) => unknown>> = {}) {
  const calls: Array<[string, unknown[]]> = [];
  const grid = new Proxy(
    {},
    {
      get:
        (_t, name: string) =>
        async (...args: unknown[]) => {
          calls.push([name, args.slice(1)]);
          const answer = answers[name as keyof GridService];
          if (!answer) throw new Error(`unexpected call ${name}`);
          return answer(...args);
        },
    },
  ) as GridService;
  return { grid, calls };
}

let app: FastifyInstance;
afterEach(async () => {
  await app?.close();
});

async function mount(grid: GridService | undefined, opts: { allowed?: boolean; principal?: Principal | null } = {}) {
  app = Fastify();
  attachGridRestRoutes(app, grid, {
    requirePrincipal: (_req, reply) => {
      const principal = opts.principal === undefined ? OWNER : opts.principal;
      if (!principal) void reply.code(401).send({ code: 'AuthenticationError' });
      return principal;
    },
    requireTradeJurisdiction: (_req, reply) => {
      if (opts.allowed === false) void reply.code(403).send({ code: 'PermissionDenied', intafacedCode: 'access.region_blocked' });
      return opts.allowed !== false;
    },
  });
  await app.ready();
  return app;
}

describe('the grid bot public API (J-copy-bots-otc-19 #1, #4)', () => {
  it('creates through the web service with the client id as its request key, and answers the bot with id and state', async () => {
    const { grid, calls } = fakeGrid({ create: async () => bot() });
    await mount(grid);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/bots/grid',
      payload: {
        clientId: 'grid-req-0001',
        symbol: 'BTC/USDT',
        direction: 'neutral',
        lowerPrice: '60000',
        upperPrice: '70000',
        grids: 10,
        investment: '300',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: 'bot-1', state: 'running', botId: 'bot-1', clientRequestId: 'grid-req-0001' });
    expect(calls).toEqual([
      [
        'create',
        [
          {
            clientRequestId: 'grid-req-0001',
            symbol: 'BTC/USDT',
            lowerPrice: '60000',
            upperPrice: '70000',
            gridCount: 10,
            investment: '300',
          },
        ],
      ],
    ]);
  });

  it('refuses a long or short grid as not built, and a malformed body as invalid, before the service is asked', async () => {
    const { grid, calls } = fakeGrid();
    await mount(grid);
    const long = await app.inject({
      method: 'POST',
      url: '/api/v1/bots/grid',
      payload: { clientId: 'grid-req-0002', symbol: 'BTC/USDT', direction: 'long' },
    });
    expect(long.statusCode).toBe(400);
    expect(long.json()).toMatchObject({ code: 'BadRequest', intafacedCode: 'trade.grid_direction_not_built' });
    const bad = await app.inject({ method: 'POST', url: '/api/v1/bots/grid', payload: { symbol: 'BTC/USDT', grids: 'ten' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ intafacedCode: 'trade.grid_request_invalid' });
    expect(calls).toEqual([]);
  });

  it("answers the service's refusal with the web's status and code", async () => {
    const { grid } = fakeGrid({
      create: async () => {
        throw new GridError('Lower price is required', 'trade.bots_grid_bounds_not_set');
      },
      get: async () => {
        throw new GridError('Grid bot not found', 'trade.grid_not_found');
      },
    });
    await mount(grid);
    const blank = await app.inject({
      method: 'POST',
      url: '/api/v1/bots/grid',
      payload: { clientId: 'grid-req-0003', symbol: 'BTC/USDT' },
    });
    expect(blank.statusCode).toBe(400);
    expect(blank.json()).toEqual({
      code: 'BadRequest',
      message: 'Lower price is required',
      intafacedCode: 'trade.bots_grid_bounds_not_set',
    });
    const missing = await app.inject({ method: 'GET', url: '/api/v1/bots/grid/nope' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: 'NotFound', intafacedCode: 'trade.grid_not_found' });
  });

  it('stops with settlement keep (the default), and refuses any other settlement as not built without stopping', async () => {
    const { grid, calls } = fakeGrid({ stop: async () => bot({ status: 'stopped' } as Partial<GridBotView>) });
    await mount(grid);
    const sell = await app.inject({ method: 'POST', url: '/api/v1/bots/grid/bot-1/stop', payload: { settlement: 'sell' } });
    expect(sell.statusCode).toBe(400);
    expect(sell.json()).toMatchObject({ intafacedCode: 'trade.grid_settlement_not_built' });
    expect(calls).toEqual([]);
    const keep = await app.inject({ method: 'POST', url: '/api/v1/bots/grid/bot-1/stop', payload: { settlement: 'keep' } });
    expect(keep.statusCode).toBe(200);
    expect(keep.json()).toMatchObject({ id: 'bot-1', state: 'stopped' });
    const bare = await app.inject({ method: 'POST', url: '/api/v1/bots/grid/bot-1/stop' });
    expect(bare.statusCode).toBe(200);
    expect(calls).toEqual([
      ['stop', ['bot-1']],
      ['stop', ['bot-1']],
    ]);
  });

  it("a withdrawal without a step-up answers identity's refusal (403 identity.step_up_required)", async () => {
    const { grid, calls } = fakeGrid({
      withdrawProfit: async () => {
        throw new StepUpCheckError('Confirm this with your passkey or authenticator code first', 'identity.step_up_required');
      },
    });
    await mount(grid);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/bots/grid/bot-1/withdraw',
      payload: { requestId: 'withdraw-0001', asset: 'USDT', amount: '10' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'PermissionDenied', intafacedCode: 'identity.step_up_required' });
    expect(calls).toEqual([['withdrawProfit', [{ botId: 'bot-1', requestId: 'withdraw-0001', asset: 'USDT', amount: '10' }]]]);
  });

  it('a write from a region that may not trade, or with no principal, reaches no service call', async () => {
    const { grid, calls } = fakeGrid();
    await mount(grid, { allowed: false });
    const blocked = await app.inject({
      method: 'POST',
      url: '/api/v1/bots/grid',
      payload: { clientId: 'grid-req-0004', symbol: 'BTC/USDT' },
    });
    expect(blocked.statusCode).toBe(403);
    await app.close();
    await mount(grid, { principal: null });
    const anonymous = await app.inject({ method: 'GET', url: '/api/v1/bots/grid' });
    expect(anonymous.statusCode).toBe(401);
    expect(calls).toEqual([]);
  });

  it('with no grid service mounted every door answers 503 trade.grid_unavailable', async () => {
    await mount(undefined);
    const res = await app.inject({ method: 'GET', url: '/api/v1/bots/grid' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: 'ExchangeNotAvailable', intafacedCode: 'trade.grid_unavailable' });
  });
});
