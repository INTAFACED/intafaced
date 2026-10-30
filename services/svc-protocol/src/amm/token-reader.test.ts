import { describe, expect, it } from 'vitest';
import type { Address, PublicClient } from 'viem';
import { TOKENS_READ_TOO_LARGE } from '@intafaced/contracts';
import { PAIRS_READ_LIMIT } from './pairs.js';
import { holdersReader, readMarket, TOKEN_TEXT_LIMIT, tokenLogsChain, type TokenLogsChain } from './token-reader.js';
import { TokensReadError } from './tokens.js';

const POOL = '0x00000000000000000000000000000000000000a1' as Address;
const ROUTER = '0x00000000000000000000000000000000000000f0' as Address;
const TRADER = '0x00000000000000000000000000000000000000e1' as Address;
const TOKEN = '0x00000000000000000000000000000000000000c1' as Address;
const DEAD = '0x000000000000000000000000000000000000dEaD';

const unused = () => Promise.reject(new Error('not read in this test'));
const pairsUnused = { headBlock: unused, factoryPools: unused, poolSnapshot: unused, tokenBasics: unused } as never;

describe('tokenLogsChain', () => {
  it("names a swap's trader by the account the pool paid, not by whoever sent the transaction", async () => {
    const client = {
      getLogs: async ({ event }: { event: { name: string } }) =>
        event.name !== 'Swap'
          ? []
          : [
              {
                address: POOL,
                transactionHash: '0x01',
                logIndex: 0,
                blockNumber: 5n,
                args: { sender: ROUTER, to: TRADER, amount0In: 1n, amount1In: 0n, amount0Out: 0n, amount1Out: 1n },
              },
            ],
    } as unknown as PublicClient;
    const chain = tokenLogsChain(
      pairsUnused,
      () => client,
      () => 'http://127.0.0.1:1',
    );
    const { swaps } = await chain.poolLogs([POOL], 5n);
    expect(swaps.map((s) => s.wallet)).toEqual([TRADER]);
  });

  it('reads each block time once, however many reads ask for it', async () => {
    let reads = 0;
    const client = { getBlock: async ({ blockNumber }: { blockNumber: bigint }) => (reads++, { timestamp: blockNumber * 10n }) };
    const chain = tokenLogsChain(
      pairsUnused,
      () => client as unknown as PublicClient,
      () => 'http://127.0.0.1:1',
    );
    const blocks = Array.from({ length: 40 }, (_, i) => BigInt(i));
    expect((await chain.blockTimes([...blocks, ...blocks])).get(39n)).toBe(390);
    await chain.blockTimes(blocks);
    expect(reads).toBe(40);
  });
});

describe('readMarket', () => {
  it('refuses a factory with more pools than the pairs read takes, rather than list part of the market', async () => {
    const chain = {
      headBlock: async () => 9n,
      factoryPools: async () => [],
      poolSnapshot: unused,
      tokenBasics: unused,
      poolCreatedLogs: async () => Array.from({ length: PAIRS_READ_LIMIT + 1 }, (_, index) => ({ pool: POOL, block: 1n, index })),
    } as unknown as TokenLogsChain;
    const refused = await readMarket(chain, POOL, 9n).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(TokensReadError);
    expect((refused as TokensReadError).code).toBe(TOKENS_READ_TOO_LARGE);
  });
});

describe('readMarket shaping what token contracts say about themselves', () => {
  const P1 = '0x00000000000000000000000000000000000000b1' as Address;
  const P2 = '0x00000000000000000000000000000000000000b2' as Address;
  const PLAIN = '0x00000000000000000000000000000000000000c2' as Address;
  const HUGE = '0x00000000000000000000000000000000000000c3' as Address;
  const snapshot = (token1: Address) => ({ token0: TOKEN, token1, feeBps: 30, reserve0: 1n, reserve1: 1n, blockTimestampLast: 0 });
  const basics: Record<string, { name: string; symbol: string; decimals: number }> = {
    [TOKEN]: { name: `\u202eLONG${'x'.repeat(100)}`, symbol: 'A\u2066B', decimals: 18 },
    [PLAIN]: { name: 'Plain', symbol: 'PLN', decimals: 6 },
    [HUGE]: { name: 'Huge', symbol: 'HUG', decimals: 77 },
  };
  const asked: Address[][] = [];
  const chain = {
    headBlock: async () => 9n,
    factoryPools: async () => [P1, P2],
    poolSnapshot: async (pool: Address) => snapshot(pool === P1 ? PLAIN : HUGE),
    tokenBasics: async (token: Address) => basics[token]!,
    poolCreatedLogs: async () => [],
    poolLogs: async (pools: Address[]) => (asked.push(pools), { syncs: [], swaps: [] }),
    blockTimes: async (blocks: bigint[]) => new Map(blocks.map((b) => [b, 100])),
  } as unknown as TokenLogsChain;

  it('leaves out a token claiming more decimals than the wire takes, with its pools, instead of refusing the list', async () => {
    const snap = await readMarket(chain, POOL, 9n);
    expect(snap.tokens.map((t) => t.address)).toEqual([TOKEN, PLAIN]);
    expect(snap.pools.map((p) => p.pool)).toEqual([P1]);
    expect(snap.unsupported).toEqual([HUGE.toLowerCase()]);
    expect(asked.at(-1)).toEqual([P1]);
  });

  it('drops direction controls from a name or symbol and cuts a long one', async () => {
    const token = (await readMarket(chain, POOL, 9n)).tokens.find((t) => t.address === TOKEN)!;
    expect(token.symbol).toBe('AB');
    expect(token.name).toBe(`LONG${'x'.repeat(TOKEN_TEXT_LIMIT - 4)}`);
  });
});

describe('holdersReader', () => {
  it('takes burned from what the burn addresses hold on the chain, and keeps a block it already read', async () => {
    let transferReads = 0;
    const chain = {
      transferLogs: async () => (
        transferReads++,
        [
          { from: '0x0000000000000000000000000000000000000000', to: TRADER, value: 1_000n },
          { from: TRADER, to: '0x0000000000000000000000000000000000000000', value: 100n },
          { from: TRADER, to: DEAD, value: 50n },
        ]
      ),
      totalSupply: async () => 900n,
      balanceOf: async (_token: Address, holder: Address) => (holder.toLowerCase() === DEAD.toLowerCase() ? 50n : 0n),
    } as unknown as TokenLogsChain;
    const read = holdersReader(chain);
    const holders = await read(TOKEN, 7n);
    expect(holders).toMatchObject({ totalSupply: '900', burned: '50', supplyLessBurned: '850' });
    expect(holders.list).toEqual([{ address: TRADER.toLowerCase(), amount: '850' }]);
    await read(TOKEN, 7n);
    expect(transferReads).toBe(1);
  });
});
