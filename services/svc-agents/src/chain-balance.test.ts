import { describe, expect, it } from 'vitest';
import { createChainBalance, toAmountScale } from './chain-balance.js';
import { FundsUnreadError } from './funds.js';

const WALLET = '0x00000000000000000000000000000000000A11CE';
const TOKEN = '0x000000000000000000000000000000000000d011';
const CONFIG = { rpcUrl: 'http://127.0.0.1:9', chainId: 84532, tokenAddress: TOKEN, tokenDecimals: 6 } as const;

/** A node that answers as told and records what it was asked. */
function node(answers: {
  chainId?: number | Error;
  block?: { number: bigint | null; timestamp: bigint } | Error;
  balance?: bigint | Error;
  symbol?: string | Error;
}) {
  const asked: Array<{ fn: string; args: unknown }> = [];
  const answer = <T>(value: T | Error | undefined, fallback: T): T => {
    if (value instanceof Error) throw value;
    return value ?? fallback;
  };
  const client = {
    getChainId: async () => {
      asked.push({ fn: 'getChainId', args: null });
      return answer(answers.chainId, 84532);
    },
    getBlock: async (args: unknown) => {
      asked.push({ fn: 'getBlock', args });
      return answer(answers.block, { number: 1234n, timestamp: 1_762_646_400n });
    },
    readContract: async (args: { functionName: string }) => {
      asked.push({ fn: 'readContract', args });
      return args.functionName === 'symbol' ? answer(answers.symbol, 'TESTUSD') : answer(answers.balance, 0n);
    },
  };
  return { client: client as never, asked };
}

describe('toAmountScale', () => {
  it('scales token units to 18 places, rounding down, never up', () => {
    expect(toAmountScale(1_500_000n, 6)).toBe(15n * 10n ** 17n);
    expect(toAmountScale(7n, 18)).toBe(7n);
    expect(toAmountScale(19n, 19)).toBe(1n);
    expect(toAmountScale(9n, 19)).toBe(0n);
  });
});

describe('createChainBalance', () => {
  it('reads balanceOf at the latest block and reports that block and its time', async () => {
    const { client, asked } = node({ balance: 4_000n });
    const reading = await createChainBalance(CONFIG, client).read(WALLET);
    expect(reading).toEqual({
      kind: 'wallet',
      available: 4_000n * 10n ** 12n,
      token: 'TESTUSD',
      method: { kind: 'wallet', address: WALLET.toLowerCase() },
      source: { kind: 'chain', chainId: 84532, block: 1234n },
      asOf: new Date(1_762_646_400_000).toISOString(),
    });
    const calls = asked.filter((a) => a.fn === 'readContract').map((a) => a.args as Record<string, unknown>);
    expect(calls).toEqual([
      expect.objectContaining({ address: TOKEN, functionName: 'balanceOf', args: [WALLET.toLowerCase()], blockNumber: 1234n }),
      expect.objectContaining({ address: TOKEN, functionName: 'symbol', blockNumber: 1234n }),
    ]);
  });

  it('a node for another chain refuses chain_mismatch and reads no balance', async () => {
    const { client, asked } = node({ chainId: 1 });
    await expect(createChainBalance(CONFIG, client).read(WALLET)).rejects.toMatchObject({ reason: 'chain_mismatch' });
    expect(asked.map((a) => a.fn)).toEqual(['getChainId']);
  });

  it.each([
    ['the node is down', { chainId: new Error('ECONNREFUSED') }],
    ['the block read fails', { block: new Error('timeout') }],
    ['the latest block is pending', { block: { number: null, timestamp: 1n } }],
    ['the balance call fails', { balance: new Error('execution reverted') }],
    ['the symbol call fails', { symbol: new Error('execution reverted') }],
    ['the symbol is blank', { symbol: '' }],
    ['the symbol is markup', { symbol: '<b>USDT</b>' }],
  ])('%s: chain_unreachable, with the wallet named, never a figure', async (_label, answers) => {
    const { client } = node(answers as never);
    const err = await createChainBalance(CONFIG, client)
      .read(WALLET)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FundsUnreadError);
    expect(err).toMatchObject({ reason: 'chain_unreachable', method: { kind: 'wallet', address: WALLET.toLowerCase() } });
  });
});
