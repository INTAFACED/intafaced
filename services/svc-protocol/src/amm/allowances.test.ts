import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { createEdgeContext, type ProtocolSwapPairs } from '@intafaced/contracts';
import { createProtocolRouter, type ProtocolRouterDeps } from '../router.js';
import { ChainUnavailableError } from '../chain/availability.js';
import { ALLOWANCE_READ_LIMIT, APPROVAL_LOG_BLOCKS, listAllowances, type AllowancesChain } from './allowances.js';
import { MAX_UINT256 } from './build.js';

const OWNER = '0x1111111111111111111111111111111111111111' as Address;
const A = '0x00000000000000000000000000000000000a11ce';
const B = '0x00000000000000000000000000000000000b0b00';
const POOL = '0x1000000000000000000000000000000000000001';
const ROUTER = '0x2000000000000000000000000000000000000002' as Address;
const OTHER_TOKEN = '0x3000000000000000000000000000000000000003' as Address;

const PAIRS: ProtocolSwapPairs = {
  factory: '0xcf7ed3acca5a467e9e704c703e8d87f634fb0fc9',
  blockNumber: '20000',
  tokens: [
    { address: B, name: 'TEST Token B', symbol: 'TESTB', decimals: 18 },
    { address: A, name: 'TEST Token A', symbol: 'TESTA', decimals: 6 },
  ],
  pools: [{ pool: POOL, token0: A, token1: B, feeBps: 30, reserve0: '1', reserve1: '1', blockTimestampLast: 1 }],
  skipped: 0,
};

type Allowances = Record<string, bigint | null | Error>;
function chain(allowances: Allowances, logs: Array<{ token: Address; spender: Address }> = []) {
  const asked: { logs: Array<{ tokens: readonly Address[]; from: bigint; to: bigint }>; reads: Array<{ key: string; block: bigint }> } = {
    logs: [],
    reads: [],
  };
  const reader: AllowancesChain = {
    approvalSpenders: async (tokens, owner, from, to) => {
      expect(owner).toBe(OWNER);
      asked.logs.push({ tokens, from, to });
      return logs;
    },
    allowanceAt: async (token, owner, spender, block) => {
      expect(owner).toBe(OWNER);
      const key = `${token.toLowerCase()}:${spender.toLowerCase()}`;
      asked.reads.push({ key, block });
      const value = Object.hasOwn(allowances, key) ? (allowances[key] ?? null) : 0n;
      if (value instanceof Error) throw value;
      return value;
    },
  };
  return { reader, asked };
}
const key = (token: string, spender: string) => `${token.toLowerCase()}:${spender.toLowerCase()}`;

describe('listAllowances', () => {
  it('lists the non-zero allowances for each pool and logged spender, all at the pairs block', async () => {
    const { reader, asked } = chain({ [key(A, POOL)]: 10_000_000n, [key(B, ROUTER)]: MAX_UINT256 }, [
      { token: B as Address, spender: ROUTER },
      { token: A as Address, spender: POOL as Address },
    ]);
    const answer = await listAllowances(reader, PAIRS, OWNER);
    expect(answer.rows).toEqual([
      { token: A, spender: POOL, allowance: '10000000', unlimited: false, pool: { token0: A, token1: B } },
      { token: B, spender: ROUTER, allowance: MAX_UINT256.toString(), unlimited: true, pool: null },
    ]);
    expect(answer.blockNumber).toBe('20000');
    expect(answer.logsFromBlock).toBe((20000n - APPROVAL_LOG_BLOCKS + 1n).toString());
    expect(asked.logs).toEqual([{ tokens: [B, A], from: 20000n - APPROVAL_LOG_BLOCKS + 1n, to: 20000n }]);
    // The pool is checked once for each of its tokens, plus the one logged spender; the duplicate log adds nothing.
    expect(asked.reads.map((read) => read.key).sort()).toEqual([key(A, POOL), key(B, POOL), key(B, ROUTER)].sort());
    expect(new Set(asked.reads.map((read) => read.block))).toEqual(new Set([20000n]));
    expect(answer.unread).toBe(0);
    expect(answer.truncated).toBe(false);
  });

  it('lists nothing when every allowance is zero: no invented rows', async () => {
    const { reader } = chain({}, [{ token: A as Address, spender: ROUTER }]);
    expect((await listAllowances(reader, PAIRS, OWNER)).rows).toEqual([]);
  });

  it('reads logs from block 0 on a young chain', async () => {
    const { reader, asked } = chain({});
    const answer = await listAllowances(reader, { ...PAIRS, blockNumber: '12' }, OWNER);
    expect(answer.logsFromBlock).toBe('0');
    expect(asked.logs[0]).toMatchObject({ from: 0n, to: 12n });
  });

  it('ignores a logged token the factory does not list', async () => {
    const { reader, asked } = chain({ [key(OTHER_TOKEN, ROUTER)]: 5n }, [{ token: OTHER_TOKEN, spender: ROUTER }]);
    expect((await listAllowances(reader, PAIRS, OWNER)).rows).toEqual([]);
    expect(asked.reads.some((read) => read.key === key(OTHER_TOKEN, ROUTER))).toBe(false);
  });

  it('asks for no logs when the factory lists no tokens', async () => {
    const { reader, asked } = chain({});
    const answer = await listAllowances(reader, { ...PAIRS, tokens: [], pools: [] }, OWNER);
    expect(answer.rows).toEqual([]);
    expect(asked.logs).toEqual([]);
  });

  it('counts a token that reverts or fails as unread, never as zero', async () => {
    const { reader } = chain({ [key(A, POOL)]: null, [key(B, POOL)]: new Error('odd token'), [key(B, ROUTER)]: 3n }, [
      { token: B as Address, spender: ROUTER },
    ]);
    const answer = await listAllowances(reader, PAIRS, OWNER);
    expect(answer.unread).toBe(2);
    expect(answer.rows.map((row) => row.spender)).toEqual([ROUTER]);
  });

  it('refuses the whole answer when the chain cannot be read', async () => {
    const down = new ChainUnavailableError('protocol.chain_unreachable', 'allowanceAt: no answer');
    const { reader } = chain({ [key(A, POOL)]: down });
    await expect(listAllowances(reader, PAIRS, OWNER)).rejects.toBe(down);
  });

  it('refuses when the Approval logs cannot be read', async () => {
    const down = new ChainUnavailableError('protocol.chain_unreachable', 'approvalSpenders: range refused');
    const reader: AllowancesChain = {
      approvalSpenders: async () => {
        throw down;
      },
      allowanceAt: async () => 0n,
    };
    await expect(listAllowances(reader, PAIRS, OWNER)).rejects.toBe(down);
  });

  it('checks at most the read limit and says so', async () => {
    const spenders = Array.from({ length: ALLOWANCE_READ_LIMIT + 5 }, (_, index) => ({
      token: A as Address,
      spender: `0x${(index + 0x100).toString(16).padStart(40, '0')}` as Address,
    }));
    const { reader, asked } = chain({}, spenders);
    const answer = await listAllowances(reader, PAIRS, OWNER);
    expect(asked.reads).toHaveLength(ALLOWANCE_READ_LIMIT);
    expect(answer.truncated).toBe(true);
  });
});

const edge = createEdgeContext({ secret: 'a-protocol-allowance-test-edge-secret', serviceName: 'svc-protocol' });
const anonymous = () => edge({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-allowances' });

describe('protocol.amm.allowances', () => {
  const base = { registry: {}, relay: {}, relayEnabled: () => false, swapSlippageBps: () => null };

  it('refuses an unset factory before any chain read', async () => {
    let asked = 0;
    const deps = {
      ...base,
      ammFactoryAddress: () => '0x0000000000000000000000000000000000000000',
      chain: {
        headBlock: async () => {
          asked += 1;
          return 1n;
        },
      },
    } as unknown as ProtocolRouterDeps;
    await expect(createProtocolRouter(deps).createCaller(anonymous()).amm.allowances({ owner: OWNER })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining('protocol.amm_factory_unset'),
    });
    expect(asked).toBe(0);
  });

  it('refuses an owner that is not an address', async () => {
    const deps = { ...base, ammFactoryAddress: () => PAIRS.factory, chain: {} } as unknown as ProtocolRouterDeps;
    await expect(createProtocolRouter(deps).createCaller(anonymous()).amm.allowances({ owner: 'alice' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('answers from the chain for the owner asked about', async () => {
    const { reader } = chain({ [key(A, POOL)]: 10_000_000n });
    const deps = {
      ...base,
      ammFactoryAddress: () => PAIRS.factory,
      chain: {
        ...reader,
        headBlock: async () => 20000n,
        factoryPools: async () => [POOL],
        poolSnapshot: async () => ({ token0: A, token1: B, feeBps: 30, reserve0: 1n, reserve1: 1n, blockTimestampLast: 1 }),
        tokenBasics: async (token: string) =>
          token === A ? { name: 'TEST Token A', symbol: 'TESTA', decimals: 6 } : { name: 'TEST Token B', symbol: 'TESTB', decimals: 18 },
      },
    } as unknown as ProtocolRouterDeps;
    const answer = await createProtocolRouter(deps).createCaller(anonymous()).amm.allowances({ owner: OWNER });
    expect(answer.owner).toBe(OWNER);
    expect(answer.rows).toEqual([{ token: A, spender: POOL, allowance: '10000000', unlimited: false, pool: { token0: A, token1: B } }]);
  });

  it('turns an unreadable chain into a typed 503, not a 500', async () => {
    const deps = {
      ...base,
      ammFactoryAddress: () => PAIRS.factory,
      chain: {
        headBlock: async () => {
          throw new ChainUnavailableError('protocol.chain_unreachable', 'headBlock: no answer');
        },
      },
    } as unknown as ProtocolRouterDeps;
    await expect(createProtocolRouter(deps).createCaller(anonymous()).amm.allowances({ owner: OWNER })).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: expect.stringContaining('protocol.chain_unreachable'),
    });
  });
});
