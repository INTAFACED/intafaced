import { describe, expect, it } from 'vitest';
import { createEdgeContext } from '@intafaced/contracts';
import { createProtocolRouter, type ProtocolRouterDeps } from '../router.js';

// RC-dex-protocol-02: the fee relay's procedures refuse before any relay read or post when a setting is blank, and a
// signed order naming a pool the factory does not list is refused before anything is posted to the relayer.
const edge = createEdgeContext({ secret: 'a-protocol-fee-relay-test-edge-secret', serviceName: 'svc-protocol' });
const anonymous = () => edge({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-fee-relay' });
const FACTORY = '0xcf7ed3acca5a467e9e704c703e8d87f634fb0fc9';
const RELAY = '0x9d4454b023096f34b160d6b654540c56a1f81688';
const LISTED = '0x1000000000000000000000000000000000000001';
const FOREIGN = '0x2000000000000000000000000000000000000002';
const A = '0x00000000000000000000000000000000000a11ce';
const USD = '0x000000000000000000000000000000000000d011';
const OWNER = '0x52908400098527886E0F7030069857D2E4169EE7';

const chain = {
  config: { chainId: 84532, rpcUrl: 'http://127.0.0.1:1' },
  headBlock: async () => 9n,
  factoryPools: async () => [LISTED],
  poolSnapshot: async () => ({ token0: A, token1: USD, feeBps: 30, reserve0: 5n, reserve1: 7n, blockTimestampLast: 1 }),
  tokenBasics: async (token: string) => ({ name: token === A ? 'TEST Token A' : 'TEST USD', symbol: 'T', decimals: 6 }),
};

function caller(overrides: Partial<ProtocolRouterDeps> = {}) {
  return createProtocolRouter({
    chain,
    registry: {},
    relay: {},
    relayEnabled: () => false,
    ammFactoryAddress: () => FACTORY,
    swapSlippageBps: () => 300,
    swapQuoteTtlSeconds: () => 30,
    swapFeeCapWei: () => 100_000_000_000n,
    feeRelay: () => ({ relay: RELAY, url: 'http://127.0.0.1:2/relay', gasLimit: 400_000n }),
    ...overrides,
  } as unknown as ProtocolRouterDeps).createCaller(anonymous());
}

const order = (pool: string) => ({
  owner: OWNER,
  pool,
  tokenIn: USD,
  amountIn: '10000000',
  minAmountOut: '1',
  feeToken: USD,
  gasWei: '800000000000000',
  maxCharge: '2100000',
  nonce: '0',
  deadline: '9999999999',
});
const SIGNATURE = `0x${'11'.repeat(64)}1b`;

describe('protocol.amm fee relay', () => {
  it('refuses every fee-token procedure while the relay settings are blank', async () => {
    const blank = caller({ feeRelay: () => null });
    for (const call of [
      () => blank.amm.feeTokens(),
      () => blank.amm.feeQuote({ feeToken: USD, maxFeePerGasWei: '1' }),
      () =>
        blank.amm.prepareFeeSwap({
          owner: OWNER,
          pool: LISTED,
          tokenIn: USD,
          amountIn: '1',
          minAmountOut: '1',
          feeToken: USD,
          maxFeePerGasWei: '1',
        }),
      () =>
        blank.amm.relayFeeSwap({
          order: order(LISTED),
          signature: SIGNATURE,
          permits: [],
          maxFeePerGasWei: '2000000000',
          maxPriorityFeePerGasWei: '1',
        }),
    ])
      await expect(call()).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        message: expect.stringContaining('protocol.fee_relay_unset'),
      });
  });

  it('refuses a signed order naming a pool the factory does not list, and posts nothing', async () => {
    let posted = 0;
    const relay = caller({
      postRelay: async () => {
        posted += 1;
        return { status: 200, body: {} };
      },
    });
    await expect(
      relay.amm.relayFeeSwap({
        order: order(FOREIGN),
        signature: SIGNATURE,
        permits: [],
        maxFeePerGasWei: '2000000000',
        maxPriorityFeePerGasWei: '1',
      }),
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('protocol.fee_swap_pool_unlisted'),
      // The client branches on the cause's code (contracts' error formatter sends it), never on the prose.
      cause: { code: 'protocol.fee_swap_pool_unlisted' },
    });
    await expect(
      relay.amm.prepareFeeSwap({
        owner: OWNER,
        pool: FOREIGN,
        tokenIn: USD,
        amountIn: '1',
        minAmountOut: '1',
        feeToken: USD,
        maxFeePerGasWei: '1',
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining('protocol.fee_swap_pool_unlisted') });
    expect(posted).toBe(0);
  });

  it('refuses a per-gas fee above the owner cap, never lowering it', async () => {
    await expect(caller().amm.feeQuote({ feeToken: USD, maxFeePerGasWei: '100000000001' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('protocol.swap_fee_over_cap'),
    });
  });
});
