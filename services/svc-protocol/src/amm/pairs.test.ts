import { describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';
import { listPairs, pairsReader, PAIRS_READ_LIMIT, type PairsChain } from './pairs.js';

const A = '0x00000000000000000000000000000000000a11ce' as Address;
const B = '0x00000000000000000000000000000000000b0b00' as Address;
const BAD = '0x000000000000000000000000000000000000bad0' as Address;
const P1 = '0x1000000000000000000000000000000000000001' as Address;
const P2 = '0x2000000000000000000000000000000000000002' as Address;
const P3 = '0x3000000000000000000000000000000000000003' as Address;
const FACTORY = '0xcf7ed3acca5a467e9e704c703e8d87f634fb0fc9' as Address;
const refusal = (code: string) => Object.assign(new Error(code), { code });

const chain = (overrides: Partial<PairsChain> = {}): PairsChain => ({
  headBlock: vi.fn(async () => 23n),
  factoryPools: vi.fn(async () => [P1, P2]),
  poolSnapshot: vi.fn(async (pool: Address) =>
    pool === P1
      ? { token0: A, token1: B, feeBps: 30, reserve0: 10n ** 12n, reserve1: 10n ** 24n, blockTimestampLast: 5 }
      : { token0: A, token1: B, feeBps: 100, reserve0: 1n, reserve1: 2n, blockTimestampLast: 6 },
  ),
  tokenBasics: vi.fn(async (token: Address) =>
    token === A ? { name: 'TEST Token A', symbol: 'TSTA', decimals: 6 } : { name: 'TEST Token B', symbol: 'TSTB', decimals: 18 },
  ),
  ...overrides,
});

describe('listPairs', () => {
  it('lists every pool at one block with its reserves and each token once, from the contracts themselves', async () => {
    const c = chain();
    const pairs = await listPairs(c, FACTORY);
    expect(c.factoryPools).toHaveBeenCalledWith(FACTORY, PAIRS_READ_LIMIT, 23n);
    expect(c.poolSnapshot).toHaveBeenCalledWith(P1, 23n);
    expect(pairs.blockNumber).toBe('23');
    expect(pairs.skipped).toBe(0);
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
    const pairs = await listPairs(chain({ factoryPools: async () => [] }), FACTORY);
    expect(pairs).toEqual({ factory: FACTORY, blockNumber: '23', tokens: [], pools: [], skipped: 0 });
  });

  it('leaves out a pool or a token that does not answer as one, so one bad pool cannot take the list down', async () => {
    const pairs = await listPairs(
      chain({
        factoryPools: async () => [P1, P2, P3],
        poolSnapshot: async (pool: Address) => {
          if (pool === P2) throw new Error('execution reverted');
          return pool === P3
            ? { token0: A, token1: BAD, feeBps: 30, reserve0: 1n, reserve1: 1n, blockTimestampLast: 1 }
            : { token0: A, token1: B, feeBps: 30, reserve0: 1n, reserve1: 1n, blockTimestampLast: 1 };
        },
        tokenBasics: async (token: Address) => {
          if (token === BAD) throw new Error('execution reverted');
          return { name: token, symbol: 'T', decimals: 18 };
        },
      }),
      FACTORY,
    );
    expect(pairs.pools.map((pool) => pool.pool)).toEqual([P1]);
    expect(pairs.tokens.map((token) => token.address)).toEqual([A, B]);
    expect(pairs.skipped).toBe(2);
  });

  it('refuses the whole list when the chain itself cannot be read', async () => {
    const down = refusal('protocol.chain_unreachable');
    await expect(
      listPairs(
        chain({
          poolSnapshot: async () => {
            throw down;
          },
        }),
        FACTORY,
      ),
    ).rejects.toBe(down);
    await expect(
      listPairs(
        chain({
          tokenBasics: async () => {
            throw down;
          },
        }),
        FACTORY,
      ),
    ).rejects.toBe(down);
  });
});

describe('pairsReader', () => {
  it('reads once per block, shares one read in flight, and reads again on a new block or after a refusal', async () => {
    let block = 1n;
    let fail = false;
    const c = chain({
      headBlock: vi.fn(async () => block),
      factoryPools: vi.fn(async () => {
        if (fail) throw refusal('protocol.chain_unreachable');
        return [P1];
      }),
    });
    const read = pairsReader(c);
    await Promise.all([read(FACTORY), read(FACTORY), read(FACTORY)]);
    expect(c.factoryPools).toHaveBeenCalledTimes(1);
    block = 2n;
    await read(FACTORY);
    expect(c.factoryPools).toHaveBeenCalledTimes(2);
    block = 3n;
    fail = true;
    await expect(read(FACTORY)).rejects.toMatchObject({ code: 'protocol.chain_unreachable' });
    fail = false;
    await expect(read(FACTORY)).resolves.toMatchObject({ blockNumber: '3' });
    expect(c.factoryPools).toHaveBeenCalledTimes(4);
  });
});
