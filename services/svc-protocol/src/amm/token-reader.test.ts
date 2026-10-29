import { describe, expect, it } from 'vitest';
import type { Address, PublicClient } from 'viem';
import { TOKENS_READ_TOO_LARGE } from '@intafaced/contracts';
import { PAIRS_READ_LIMIT } from './pairs.js';
import { holdersReader, readMarket, tokenLogsChain, type TokenLogsChain } from './token-reader.js';
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
