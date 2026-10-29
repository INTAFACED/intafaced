import { describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';
import { listPairs, PAIRS_READ_LIMIT, type PairsChain } from './pairs.js';

const A = '0x00000000000000000000000000000000000a11ce' as Address;
const B = '0x00000000000000000000000000000000000b0b00' as Address;
const P1 = '0x1000000000000000000000000000000000000001' as Address;
const P2 = '0x2000000000000000000000000000000000000002' as Address;
const FACTORY = '0xcf7ed3acca5a467e9e704c703e8d87f634fb0fc9' as Address;

const chain = (overrides: Partial<PairsChain> = {}): PairsChain => ({
  factoryPools: vi.fn(async () => ({ pools: [P1, P2], blockNumber: 23n })),
  poolToken0: vi.fn(async () => A),
  poolToken1: vi.fn(async () => B),
  poolFeeBps: vi.fn(async (pool: Address) => (pool === P1 ? 30 : 100)),
  poolReserves: vi.fn(async (pool: Address) =>
    pool === P1
      ? { reserve0: 10n ** 12n, reserve1: 10n ** 24n, blockTimestampLast: 5 }
      : { reserve0: 1n, reserve1: 2n, blockTimestampLast: 6 },
  ),
  tokenBasics: vi.fn(async (token: Address) =>
    token === A ? { name: 'TEST Token A', symbol: 'TSTA', decimals: 6 } : { name: 'TEST Token B', symbol: 'TSTB', decimals: 18 },
  ),
  ...overrides,
});

describe('listPairs', () => {
  it('lists every pool with its reserves and each token once, from the contracts themselves', async () => {
    const c = chain();
    const pairs = await listPairs(c, FACTORY);
    expect(c.factoryPools).toHaveBeenCalledWith(FACTORY, PAIRS_READ_LIMIT);
    expect(pairs.blockNumber).toBe('23');
    expect(pairs.pools).toEqual([
      {
        pool: P1,
        token0: A,
        token1: B,
        feeBps: 30,
        reserve0: '1000000000000',
        reserve1: '1000000000000000000000000',
        blockTimestampLast: 5,
      },
      { pool: P2, token0: A, token1: B, feeBps: 100, reserve0: '1', reserve1: '2', blockTimestampLast: 6 },
    ]);
    expect(pairs.tokens).toEqual([
      { address: A, name: 'TEST Token A', symbol: 'TSTA', decimals: 6 },
      { address: B, name: 'TEST Token B', symbol: 'TSTB', decimals: 18 },
    ]);
    expect(c.tokenBasics).toHaveBeenCalledTimes(2);
  });

  it('answers an empty factory with no pools and no tokens', async () => {
    const pairs = await listPairs(chain({ factoryPools: async () => ({ pools: [], blockNumber: 1n }) }), FACTORY);
    expect(pairs).toEqual({ factory: FACTORY, blockNumber: '1', tokens: [], pools: [] });
  });

  it('refuses the whole list when one read fails, never a partial list', async () => {
    const refused = Object.assign(new Error('protocol.chain_unreachable'), { code: 'protocol.chain_unreachable' });
    await expect(
      listPairs(
        chain({
          poolReserves: async () => {
            throw refused;
          },
        }),
        FACTORY,
      ),
    ).rejects.toBe(refused);
  });
});
