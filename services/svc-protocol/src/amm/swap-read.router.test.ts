import { describe, expect, it } from 'vitest';
import { createEdgeContext } from '@intafaced/contracts';
import { createProtocolRouter, type ProtocolRouterDeps } from '../router.js';

const edge = createEdgeContext({ secret: 'a-protocol-swap-test-edge-secret-length', serviceName: 'svc-protocol' });
const anonymous = () => edge({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-swap' });
const FACTORY = '0xcf7ed3acca5a467e9e704c703e8d87f634fb0fc9';
const A = '0x00000000000000000000000000000000000a11ce';
const B = '0x00000000000000000000000000000000000b0b00';
const POOL = '0x1000000000000000000000000000000000000001';

function deps(overrides: Partial<ProtocolRouterDeps> = {}): ProtocolRouterDeps {
  return {
    chain: { config: { chainId: 84532 } },
    registry: {},
    relay: {},
    relayEnabled: () => false,
    ammFactoryAddress: () => '0x0000000000000000000000000000000000000000',
    swapSlippageBps: () => null,
    ...overrides,
  } as unknown as ProtocolRouterDeps;
}
const caller = (overrides: Partial<ProtocolRouterDeps>) => createProtocolRouter(deps(overrides)).createCaller(anonymous());

describe('protocol.amm.swapSettings', () => {
  it('answers what the owner set', async () => {
    await expect(
      caller({ swapSlippageBps: () => 300, swapQuoteTtlSeconds: () => 30, swapConfirmations: () => 2 }).amm.swapSettings(),
    ).resolves.toEqual({ slippageCeilingBps: 300, quoteTtlSeconds: 30, confirmations: 2 });
  });

  it.each<[string, Partial<ProtocolRouterDeps>, string]>([
    [
      'slippage',
      { swapSlippageBps: () => null, swapQuoteTtlSeconds: () => 30, swapConfirmations: () => 2 },
      'protocol.swap_slippage_unset',
    ],
    [
      'quote lifetime',
      { swapSlippageBps: () => 300, swapQuoteTtlSeconds: () => null, swapConfirmations: () => 2 },
      'protocol.swap_settings_unset',
    ],
    [
      'confirmations',
      { swapSlippageBps: () => 300, swapQuoteTtlSeconds: () => 30, swapConfirmations: () => null },
      'protocol.swap_settings_unset',
    ],
    ['absent seams', { swapSlippageBps: () => 300 }, 'protocol.swap_settings_unset'],
  ])('refuses a blank %s instead of inventing it', async (_name, overrides, code) => {
    await expect(caller(overrides).amm.swapSettings()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining(code),
    });
  });
});

describe('protocol.amm.pairs', () => {
  it('refuses an unset factory before any chain read', async () => {
    let asked = 0;
    const chain = {
      headBlock: async () => {
        asked += 1;
        return 1n;
      },
      factoryPools: async () => {
        asked += 1;
        return [];
      },
    };
    await expect(caller({ chain: chain as unknown as ProtocolRouterDeps['chain'] }).amm.pairs()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining('protocol.amm_factory_unset'),
    });
    expect(asked).toBe(0);
  });

  it('lists the factory pools and their tokens from the chain', async () => {
    const chain = {
      headBlock: async () => 9n,
      factoryPools: async () => [POOL],
      poolSnapshot: async () => ({ token0: A, token1: B, feeBps: 30, reserve0: 5n, reserve1: 7n, blockTimestampLast: 1 }),
      tokenBasics: async (token: string) => ({ name: token === A ? 'TEST Token A' : 'TEST Token B', symbol: 'T', decimals: 18 }),
    };
    const pairs = await caller({ ammFactoryAddress: () => FACTORY, chain: chain as unknown as ProtocolRouterDeps['chain'] }).amm.pairs();
    expect(pairs.pools).toEqual([{ pool: POOL, token0: A, token1: B, feeBps: 30, reserve0: '5', reserve1: '7', blockTimestampLast: 1 }]);
    expect(pairs.tokens.map((token) => token.name)).toEqual(['TEST Token A', 'TEST Token B']);
  });
});
