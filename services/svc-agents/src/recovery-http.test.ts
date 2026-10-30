import Fastify, { type FastifyRequest } from 'fastify';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgentsRouter, type AgentsRouterDeps } from './router.js';
import { NO_TIER_LAWS } from './tier-laws.js';

const SECRET = 'agents-recovery-http-fixture-edge-secret';
const USER = '11111111-1111-4111-8111-111111111111';
const NOW = '2026-10-12T00:00:00.000Z';
const INPUT = {
  tool: 'trade.quote',
  plane: 'live',
  now: NOW,
  quote: { marketId: 'btc-usdt', last: '-1.50', asOf: NOW, maxAgeMs: 30_000 },
};

function headers(scopes: Principal['scopes'] = ['agents:read']) {
  const raw = encodePrincipal({
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes,
    tier: 'basic',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal);
  return {
    'x-intafaced-principal': raw,
    'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
    'x-intafaced-region': 'DE',
  };
}

async function mount() {
  const downstream = vi.fn(async () => []);
  const deps: AgentsRouterDeps = {
    runtime: {} as AgentsRouterDeps['runtime'],
    gateway: { routingTable: { routes: [] } } as unknown as AgentsRouterDeps['gateway'],
    meter: {} as AgentsRouterDeps['meter'],
    feeAssetId: 'fixture-asset',
    navigatorTradeUrl: 'http://trade.test',
    navigatorTradeDataPort: { listMarkets: downstream, quote: async () => null },
    tierLaws: { ...NO_TIER_LAWS, navigator: { published: true, matrix: { basic: ['trade.quote', 'trade.markets.list'] } } },
  };
  const app = Fastify();
  const edge = createEdgeContext({ secret: SECRET, serviceName: 'svc-agents' });
  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router: createAgentsRouter(deps),
      createContext: ({ req }: { req: FastifyRequest }) => edge(req),
    },
  });
  return { app, downstream };
}

afterEach(() => vi.unstubAllEnvs());

describe('agent recovery through mounted signed HTTP', () => {
  it('refuses a negative quote and still accepts its positive control', async () => {
    const { app } = await mount();
    try {
      for (const [last, status] of [
        ['-1.50', 'refuse'],
        ['1.50', 'ok'],
      ] as const) {
        const response = await app.inject({
          method: 'GET',
          url: `/trpc/navigator.invokeDataTool?input=${encodeURIComponent(JSON.stringify({ ...INPUT, quote: { ...INPUT.quote, last } }))}`,
          headers: headers(),
        });
        expect(response.statusCode).toBe(200);
        const result = response.json().result.data.result;
        expect(result.status).toBe(status);
        if (status === 'refuse') expect(result.reason).toBe('invalid_decimal');
        else expect(result.last).toBe(last);
      }
    } finally {
      await app.close();
    }
  });

  it('refuses an unsigned request and a signed request missing agents:read', async () => {
    const { app, downstream } = await mount();
    try {
      const url = `/trpc/navigator.invokeDataTool?input=${encodeURIComponent(JSON.stringify(INPUT))}`;
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
      const scoped = await app.inject({ method: 'GET', url, headers: headers([]) });
      expect(scoped.statusCode).toBe(403);
      expect(scoped.json().error.data.intafacedCode).toBe('scope.denied');
      expect(downstream).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('strict blank screening refuses before a downstream market read', async () => {
    vi.stubEnv('INTAFACED_SCREENING_FAIL_CLOSED', 'on');
    vi.stubEnv('INTAFACED_SANCTIONS_REGIONS', '');
    const { app, downstream } = await mount();
    try {
      const input = {
        ...INPUT,
        tool: 'trade.markets.list',
        marketsLimit: 1,
      };
      const response = await app.inject({
        method: 'GET',
        url: `/trpc/navigator.invokeDataTool?input=${encodeURIComponent(JSON.stringify(input))}`,
        headers: headers(),
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.data.intafacedCode).toBe('denied.screening_unconfigured');
      expect(downstream).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
