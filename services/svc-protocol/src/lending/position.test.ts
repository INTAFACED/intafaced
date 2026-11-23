import { describe, expect, it } from 'vitest';
import { LENDING_MARKET_UNSET } from '@intafaced/contracts';
import { LendingMarketUnset, lendingPosition, type LendingChain } from './position.js';

const MARKET = '0x00000000000000000000000000000000000001e0';
const ACCOUNT = '0x00000000000000000000000000000000000000aa';
const A = '0x00000000000000000000000000000000000a11ce';
const USD = '0x000000000000000000000000000000000000d011';

/** A chain that answers the market's and tokens' reads, and records the block each read was asked at. */
function chainWith(state: { collateral: bigint; debt: bigint }) {
  const blocks: (bigint | undefined)[] = [];
  const chain: LendingChain = {
    getChainId: async () => 84532,
    getBlockNumber: async () => 416n,
    readContract: (async ({ address, functionName, blockNumber }: { address: string; functionName: string; blockNumber?: bigint }) => {
      blocks.push(blockNumber);
      if (address === MARKET) {
        if (functionName === 'collateralToken') return A;
        if (functionName === 'borrowToken') return USD;
        if (functionName === 'maxLtvBps') return 7000;
        if (functionName === 'collateralOf') return state.collateral;
        if (functionName === 'debtOf') return state.debt;
      }
      if (functionName === 'symbol') return address === A ? 'TESTA' : 'TESTUSD';
      if (functionName === 'decimals') return 6;
      throw new Error(`unexpected read ${functionName} on ${address}`);
    }) as never,
  };
  return { chain, blocks };
}

describe('lendingPosition (J-dex-protocol-06 #4)', () => {
  it('reads the account collateral and debt from the market at one block, in each token own units', async () => {
    const { chain, blocks } = chainWith({ collateral: 25_000_000n, debt: 1_500_000n });
    const p = await lendingPosition({ chain: () => chain, market: () => MARKET }, ACCOUNT);
    expect(p).toMatchObject({
      blockNumber: '416',
      chainId: 84532,
      collateral: '25',
      debt: '1.5',
      maxLtvBps: 7000,
      collateralToken: { symbol: 'TESTA', decimals: 6 },
      borrowToken: { symbol: 'TESTUSD', decimals: 6 },
    });
    expect(new Set(blocks)).toEqual(new Set([416n]));
  });

  it('refuses protocol.lending_market_unset with no market set, and reads nothing', async () => {
    const { chain, blocks } = chainWith({ collateral: 0n, debt: 0n });
    for (const market of [null, '0x0000000000000000000000000000000000000000'] as const) {
      const read = lendingPosition({ chain: () => chain, market: () => market }, ACCOUNT);
      await expect(read).rejects.toBeInstanceOf(LendingMarketUnset);
      await expect(read).rejects.toThrow(LENDING_MARKET_UNSET);
    }
    expect(blocks).toEqual([]);
  });

  it('a chain failure is passed on, never answered as an empty position', async () => {
    const chain: LendingChain = {
      getChainId: async () => 84532,
      getBlockNumber: async () => {
        throw new Error('connection refused');
      },
      readContract: (async () => 0n) as never,
    };
    await expect(lendingPosition({ chain: () => chain, market: () => MARKET }, ACCOUNT)).rejects.toThrow('connection refused');
  });
});
