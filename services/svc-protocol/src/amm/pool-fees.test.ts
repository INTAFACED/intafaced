import { describe, expect, it } from 'vitest';
import { ContractFunctionExecutionError, ContractFunctionRevertedError, HttpRequestError, type Address, type PublicClient } from 'viem';
import { createEdgeContext, FEE_SHARE_TOTAL_BPS } from '@intafaced/contracts';
import { createProtocolRouter, type ProtocolRouterDeps } from '../router.js';
import { createPoolFeesRouter, poolFeesChain, readPoolFees, type PoolFeesChain } from './pool-fees.js';
import { poolAbi } from './abi.js';

const edge = createEdgeContext({ secret: 'a-protocol-pool-fees-test-edge-secret', serviceName: 'svc-protocol' });
const anonymous = () => edge({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-pool-fees' });
const FACTORY = '0xcf7ed3acca5a467e9e704c703e8d87f634fb0fc9' as Address;
const POOL = '0x00000000000000000000000000000000000000aa' as Address;
const OTHER = '0x00000000000000000000000000000000000000bb' as Address;
const A = '0x000000000000000000000000000000000000000a' as Address;
const B = '0x000000000000000000000000000000000000000b' as Address;

function chainWith(over: Partial<PoolFeesChain> = {}): PoolFeesChain & { asked: unknown[] } {
  const asked: unknown[] = [];
  return {
    asked,
    headBlock: async () => 42n,
    poolFields: async (pool, block) => (asked.push(['poolFields', pool, block]), { token0: A, token1: B, feeBps: 30 }),
    factoryPool: async (...args) => (asked.push(['factoryPool', ...args]), POOL),
    ...over,
  };
}

const call = (chain: PoolFeesChain, factory: Address = FACTORY) =>
  createPoolFeesRouter({ chain, factory: () => factory, toTrpcError: (err) => err as never }).createCaller(anonymous());

describe('protocol.amm.poolFees (D-fees-governance-04 (a))', () => {
  it('reads the pool’s own fee and gives the whole fee to its liquidity providers, with no third share', async () => {
    const chain = chainWith();
    const fees = await call(chain).poolFees({ pool: POOL });
    expect(fees).toEqual({
      pool: POOL,
      factory: FACTORY,
      feeBps: 30,
      shares: [{ to: 'liquidity_providers', bps: FEE_SHARE_TOTAL_BPS }],
      thirdShare: false,
      contract: 'ConstantProductPool v1',
      blockNumber: '42',
    });
    // Every read is pinned to the one head block, and the factory is asked about exactly the pool's own fields.
    expect(chain.asked).toEqual([
      ['poolFields', POOL, 42n],
      ['factoryPool', FACTORY, A, B, 30, 42n],
    ]);
  });

  it('fees.lp-share-plus-other-shares-equals-total, for every fee the pool contract allows', async () => {
    for (const feeBps of [0, 1, 30, 100, 999, 1000]) {
      const fees = await readPoolFees(chainWith({ poolFields: async () => ({ token0: A, token1: B, feeBps }) }), FACTORY, POOL);
      expect(fees.feeBps).toBe(feeBps);
      expect(fees.shares.reduce((sum, share) => sum + share.bps, 0)).toBe(FEE_SHARE_TOTAL_BPS);
      expect(fees.thirdShare).toBe(false);
    }
  });

  it('says nothing about an address the factory did not create, even one that answers feeBps()', async () => {
    await expect(call(chainWith({ factoryPool: async () => OTHER })).poolFees({ pool: POOL })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: expect.stringMatching(/^protocol\.not_factory_pool: /),
    });
    await expect(
      call(chainWith({ factoryPool: async () => '0x0000000000000000000000000000000000000000' as Address })).poolFees({ pool: POOL }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('an address that does not answer as a pool is not a factory pool, and the factory is not asked', async () => {
    const chain = chainWith({ poolFields: async () => null });
    await expect(call(chain).poolFees({ pool: POOL })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: expect.stringMatching(/^protocol\.not_factory_pool: /),
    });
    expect(chain.asked).toEqual([]);
  });

  it('refuses a blank factory by name and reads nothing', async () => {
    const chain = chainWith({ headBlock: async () => Promise.reject(new Error('no read expected')) });
    await expect(call(chain, '0x0000000000000000000000000000000000000000' as Address).poolFees({ pool: POOL })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringMatching(/^protocol\.amm_factory_unset: /),
    });
  });

  it('a chain that cannot be read stays a chain refusal, never a claim about the pool', async () => {
    const down = Object.assign(new Error('down'), { code: 'protocol.chain_unreachable' });
    await expect(call(chainWith({ headBlock: async () => Promise.reject(down) })).poolFees({ pool: POOL })).rejects.toMatchObject({
      cause: down,
    });
  });
});

describe('poolFeesChain', () => {
  const revert = () =>
    new ContractFunctionExecutionError(new ContractFunctionRevertedError({ abi: poolAbi, functionName: 'feeBps' }), {
      abi: poolAbi,
      functionName: 'feeBps',
      contractAddress: POOL,
    });
  const viaClient = (readContract: () => Promise<unknown>, getCode: () => Promise<unknown> = async () => '0x6080') =>
    poolFeesChain(
      () => ({ readContract, getCode }) as unknown as PublicClient,
      () => 'http://127.0.0.1:1',
      async () => 1n,
    );

  it('a call that reverts is "not a pool", never "the chain is unreachable"', async () => {
    await expect(viaClient(() => Promise.reject(revert())).poolFields(POOL, 1n)).resolves.toBeNull();
  });

  it('an address with no code at the block is "not deployed there", never a claim that it is not a pool', async () => {
    await expect(
      viaClient(
        () => Promise.reject(revert()),
        async () => undefined,
      ).poolFields(POOL, 1n),
    ).rejects.toMatchObject({ code: 'protocol.contract_not_deployed' });
  });

  it('a node that does not answer is the shared typed chain refusal', async () => {
    const offline = new HttpRequestError({ url: 'http://127.0.0.1:1', details: 'connect ECONNREFUSED' });
    await expect(viaClient(() => Promise.reject(offline)).poolFields(POOL, 1n)).rejects.toMatchObject({
      code: 'protocol.chain_unreachable',
    });
  });
});

describe('protocol.amm.requestProtocolFee (D-fees-governance-04 (b))', () => {
  it('refuses protocol.fee_policy_unset with the fields the owner must publish, and reads nothing', async () => {
    const reads = { count: 0 };
    const client = new Proxy({}, { get: () => () => (reads.count++, Promise.reject(new Error('no chain read expected'))) });
    const deps = {
      chain: { config: { chainId: 84532, rpcUrl: 'http://127.0.0.1:1' }, client, headBlock: () => Promise.reject(new Error('no read')) },
      registry: {},
      relay: {},
      relayEnabled: () => false,
      ammFactoryAddress: () => FACTORY,
    } as unknown as ProtocolRouterDeps;
    const amm = createProtocolRouter(deps).createCaller(anonymous()).amm;
    await expect(amm.requestProtocolFee({ pool: POOL })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringMatching(/^protocol\.fee_policy_unset: the protocol fee policy is not set\. .*protocol share per pool class/),
    });
    expect(reads.count).toBe(0);
  });
});
