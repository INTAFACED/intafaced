import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { createEdgeContext, type ProtocolSwapPairs } from '@intafaced/contracts';
import { createProtocolRouter, type ProtocolRouterDeps } from '../router.js';
import { routeOptions, type RoutesChain } from './routes.js';
import { quoteExactIn } from './build.js';

const A = '0x00000000000000000000000000000000000a11ce' as Address;
const B = '0x00000000000000000000000000000000000b0b00' as Address;
const C = '0x00000000000000000000000000000000000c0c00' as Address;
const DEEP = '0x1000000000000000000000000000000000000001';
const SHALLOW = '0x1000000000000000000000000000000000000002';
const STALE = '0x1000000000000000000000000000000000000003';
const EMPTY = '0x1000000000000000000000000000000000000004';
const OTHER = '0x1000000000000000000000000000000000000005';
const e = (n: number) => BigInt(n) * 10n ** 18n;
const pool = (address: string, token0: string, token1: string, reserve0: bigint, reserve1: bigint, feeBps: number) => ({
  pool: address,
  token0,
  token1,
  feeBps,
  reserve0: reserve0.toString(),
  reserve1: reserve1.toString(),
  blockTimestampLast: 1,
});
const PAIRS: ProtocolSwapPairs = {
  factory: '0xcf7ed3acca5a467e9e704c703e8d87f634fb0fc9',
  blockNumber: '77',
  tokens: [
    { address: A, name: 'TEST Token A', symbol: 'A', decimals: 18 },
    { address: B, name: 'TEST Token B', symbol: 'B', decimals: 18 },
    { address: C, name: 'TEST Token C', symbol: 'C', decimals: 18 },
  ],
  pools: [
    pool(SHALLOW, A, B, e(50_000), e(50_000), 100),
    pool(DEEP, A, B, e(1_000_000), e(1_000_000), 30),
    pool(STALE, B, A, e(2_000_000), e(2_000_000), 50),
    pool(EMPTY, A, B, 0n, 0n, 30),
    pool(OTHER, A, C, e(1_000), e(1_000), 30),
  ],
  skipped: 0,
};

/** Balances equal reserves, except the stale pool, which holds 1,000 more TEST Token A than it recorded. */
function chain(asked: Array<{ token: string; holder: string; block: bigint }> = []): RoutesChain {
  return {
    tokenBalanceAt: async (token, holder, block) => {
      asked.push({ token, holder, block });
      const row = PAIRS.pools.find((entry) => entry.pool === holder)!;
      const recorded = BigInt(token === row.token0 ? row.reserve0 : row.reserve1);
      return holder === STALE && token === A ? recorded + e(1_000) : recorded;
    },
  };
}
const quote = (reserve: bigint, feeBps: number) =>
  quoteExactIn({ amountIn: e(10), reserveIn: reserve, reserveOut: reserve, feeBps }).amountOut;

describe('routeOptions', () => {
  it('ranks every pool for the pair best first, says how much less the others give, and drops none', async () => {
    const asked: Array<{ token: string; holder: string; block: bigint }> = [];
    const answer = await routeOptions(chain(asked), PAIRS, { tokenIn: A, tokenOut: B, amountIn: e(10), exclude: [] });
    expect(answer.legs.map((leg) => [leg.pool, leg.status, leg.reason])).toEqual([
      [DEEP, 'best', null],
      [SHALLOW, 'lost', null],
      [STALE, 'unavailable', 'stale'],
      [EMPTY, 'unavailable', 'no_liquidity'],
    ]);
    expect(answer.legs[0]!.amountOut).toBe(quote(e(1_000_000), 30).toString());
    expect(answer.legs[1]!.shortfall).toBe((quote(e(1_000_000), 30) - quote(e(50_000), 100)).toString());
    expect(answer.legs[2]!.amountOut).toBeNull();
    // Every holding is read at the pairs' block, never at a later one.
    expect(new Set(asked.map((read) => read.block))).toEqual(new Set([77n]));
    expect(answer).toMatchObject({ venue: 'pool', blockNumber: '77', amountIn: e(10).toString() });
  });

  it('keeps an excluded pool in its place, marked, and the next usable pool leads', async () => {
    const answer = await routeOptions(chain(), PAIRS, {
      tokenIn: A,
      tokenOut: B,
      amountIn: e(10),
      exclude: [DEEP.toUpperCase().replace('0X', '0x')],
    });
    expect(answer.legs.map((leg) => [leg.pool, leg.status])).toEqual([
      [DEEP, 'excluded'],
      [SHALLOW, 'best'],
      [STALE, 'unavailable'],
      [EMPTY, 'unavailable'],
    ]);
    expect(answer.legs[0]!.amountOut).toBe(quote(e(1_000_000), 30).toString());
    expect(answer.legs[1]!.shortfall).toBeNull();
  });

  it('quotes the reverse direction from the other side of each pool', async () => {
    const answer = await routeOptions(chain(), PAIRS, { tokenIn: B, tokenOut: A, amountIn: e(10), exclude: [] });
    expect(answer.legs[0]).toMatchObject({ pool: DEEP, status: 'best', amountOut: quote(e(1_000_000), 30).toString() });
  });

  it('a stale pool is never quoted, even when its recorded reserves would win', async () => {
    const answer = await routeOptions(chain(), PAIRS, { tokenIn: A, tokenOut: B, amountIn: e(10), exclude: [] });
    const stale = answer.legs.find((leg) => leg.pool === STALE)!;
    expect(stale).toEqual({
      pool: STALE,
      feeBps: 50,
      amountOut: null,
      priceImpactBps: null,
      status: 'unavailable',
      shortfall: null,
      reason: 'stale',
    });
  });

  it('lists nothing for a pair no pool trades, and every leg is unavailable when no pool can be used', async () => {
    expect((await routeOptions(chain(), PAIRS, { tokenIn: B, tokenOut: C, amountIn: e(1), exclude: [] })).legs).toEqual([]);
    const only = { ...PAIRS, pools: PAIRS.pools.filter((row) => row.pool === STALE || row.pool === EMPTY) };
    const answer = await routeOptions(chain(), only, { tokenIn: A, tokenOut: B, amountIn: e(1), exclude: [] });
    expect(answer.legs.every((leg) => leg.status === 'unavailable')).toBe(true);
  });
});

const edge = createEdgeContext({ secret: 'a-protocol-routes-test-edge-secret-long', serviceName: 'svc-protocol' });
const anonymous = () => edge({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-routes' });

describe('protocol.amm.routes', () => {
  const deps = (overrides: Partial<ProtocolRouterDeps>) =>
    ({
      chain: {},
      registry: {},
      relay: {},
      relayEnabled: () => false,
      swapSlippageBps: () => null,
      ...overrides,
    }) as unknown as ProtocolRouterDeps;
  const ask = { tokenIn: A, tokenOut: B, amountIn: '10' };

  it('refuses an unset factory before any chain read', async () => {
    const caller = createProtocolRouter(deps({ ammFactoryAddress: () => '0x0000000000000000000000000000000000000000' })).createCaller(
      anonymous(),
    );
    await expect(caller.amm.routes(ask)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining('protocol.amm_factory_unset'),
    });
  });

  it('refuses the same token on both sides, and a zero amount', async () => {
    const caller = createProtocolRouter(deps({ ammFactoryAddress: () => PAIRS.factory as Address })).createCaller(anonymous());
    await expect(caller.amm.routes({ ...ask, tokenOut: A })).rejects.toMatchObject({
      message: expect.stringContaining('protocol.route_same_token'),
    });
    await expect(caller.amm.routes({ ...ask, amountIn: '0' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});
