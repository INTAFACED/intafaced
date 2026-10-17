/**
 * portfolio.plan reads the caller's ledger balances and refuses an unpriced asset.
 * It does not post and it does not read another account.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { MemoryLedger, parseAmount, recipes } from '@intafaced/ledger-client';
import { ModelGateway } from '../gateway/gateway.js';
import { DEFAULT_ROUTING_TABLE } from '../gateway/routing.js';
import { MockModelProvider } from '../providers/mock.js';
import { createAgentsRouter } from '../router.js';
import type { AgentsRouterDeps } from '../router.js';
import { tradeTickerPrices } from './trade-prices.js';

const SECRET = 'agents-portfolio-holdings-test-secret';
const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-agents' });

function callerFor(userId: string) {
  const principal = {
    sub: userId,
    userId,
    sid: '33333333-3333-4333-8333-333333333333',
    scopes: ['agents:read'],
    tier: 'none',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
  const raw = encodePrincipal(principal);
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: `req-${userId}`,
  });
}

const previousFlag = process.env.AGENTS_PORTFOLIO_ENABLED;

beforeAll(() => {
  process.env.AGENTS_PORTFOLIO_ENABLED = 'true';
});

afterAll(() => {
  if (previousFlag === undefined) delete process.env.AGENTS_PORTFOLIO_ENABLED;
  else process.env.AGENTS_PORTFOLIO_ENABLED = previousFlag;
});

describe('portfolio.plan holdings port', () => {
  it('plans an exact rebalance from two priced holdings and posts nothing', async () => {
    const ledger = new MemoryLedger();
    let posts = 0;
    const seen: string[] = [];
    await ledger.post(recipes.deposit({ userId: USER_A, assetId: 'BTC', amount: parseAmount('1'), rail: 'test', railRef: 'a-btc' }));
    await ledger.post(recipes.deposit({ userId: USER_A, assetId: 'ETH', amount: parseAmount('3'), rail: 'test', railRef: 'a-eth' }));
    await ledger.post(recipes.deposit({ userId: USER_B, assetId: 'SOL', amount: parseAmount('9'), rail: 'test', railRef: 'b-sol' }));

    const deps: AgentsRouterDeps = {
      runtime: {} as AgentsRouterDeps['runtime'],
      gateway: new ModelGateway([new MockModelProvider({ id: 'primary' })], DEFAULT_ROUTING_TABLE),
      meter: {} as AgentsRouterDeps['meter'],
      feeAssetId: 'FEE',
      portfolioLedger: {
        balances: async (ownerType, ownerId) => {
          seen.push(ownerId);
          return ledger.balances(ownerType, ownerId);
        },
      },
      portfolioPrices: {
        price: async (assetId) => (assetId === 'BTC' || assetId === 'ETH' ? '2' : null),
      },
    };
    const originalPost = ledger.post.bind(ledger);
    ledger.post = async (request) => {
      posts += 1;
      return originalPost(request);
    };

    const result = await createAgentsRouter(deps)
      .createCaller(callerFor(USER_A))
      .portfolio.plan({
        targets: [
          { asset: 'BTC', plane: 'custodial', weight: '0.5' },
          { asset: 'ETH', plane: 'custodial', weight: '0.5' },
        ],
      });

    expect(posts).toBe(0);
    expect(seen).toEqual([USER_A]);
    expect(result.result).toEqual({
      status: 'planned',
      userId: USER_A,
      legs: [
        {
          asset: 'BTC',
          plane: 'custodial',
          currentWeight: '0.25',
          targetWeight: '0.5',
          deltaWeight: '0.25',
          intent: 'increase',
        },
        {
          asset: 'ETH',
          plane: 'custodial',
          currentWeight: '0.75',
          targetWeight: '0.5',
          deltaWeight: '-0.25',
          intent: 'reduce',
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('SOL');
  });

  it('refuses an unpriced asset by name and posts nothing', async () => {
    const ledger = new MemoryLedger();
    let posts = 0;
    await ledger.post(recipes.deposit({ userId: USER_A, assetId: 'BTC', amount: parseAmount('1'), rail: 'test', railRef: 'u-btc' }));
    await ledger.post(recipes.deposit({ userId: USER_A, assetId: 'ETH', amount: parseAmount('1'), rail: 'test', railRef: 'u-eth' }));
    const deps: AgentsRouterDeps = {
      runtime: {} as AgentsRouterDeps['runtime'],
      gateway: new ModelGateway([new MockModelProvider({ id: 'primary' })], DEFAULT_ROUTING_TABLE),
      meter: {} as AgentsRouterDeps['meter'],
      feeAssetId: 'FEE',
      portfolioLedger: { balances: (ownerType, ownerId) => ledger.balances(ownerType, ownerId) },
      portfolioPrices: { price: async (assetId) => (assetId === 'BTC' ? '2' : null) },
    };
    ledger.post = async () => {
      posts += 1;
      throw new Error('posted');
    };

    const result = await createAgentsRouter(deps)
      .createCaller(callerFor(USER_A))
      .portfolio.plan({
        targets: [
          { asset: 'BTC', plane: 'custodial', weight: '0.5' },
          { asset: 'ETH', plane: 'custodial', weight: '0.5' },
        ],
      });

    expect(posts).toBe(0);
    expect(result.result).toMatchObject({ status: 'refused', code: 'portfolio.price_unset', asset: 'ETH' });
  });
});

describe('trade ticker prices', () => {
  it('uses the mid and refuses a zero last', async () => {
    const source = tradeTickerPrices({
      baseUrl: 'https://trade.internal',
      quoteAssetId: 'USD',
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.endsWith('/ETH%2FUSD')) {
          return new Response(JSON.stringify({ bid: '2', ask: '4', last: '9' }), { status: 200 });
        }
        return new Response(JSON.stringify({ bid: null, ask: null, last: '0' }), { status: 200 });
      },
    });
    expect(await source.price('USD')).toBe('1');
    expect(await source.price('ETH')).toBe('3');
    expect(await source.price('BTC')).toBeNull();
  });
});
