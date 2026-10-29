import type { PublicClient } from 'viem';
import { describe, expect, it } from 'vitest';
import { readBlockTransactions } from './explorer-txs.js';
import { TRACE_NOT_READ } from './revert-reason.js';

const BLOCK = `0x${'b'.repeat(64)}` as const;
const HASH = `0x${'a'.repeat(64)}` as const;
const FROM = `0x${'1'.repeat(40)}` as const;
const TO = `0x${'2'.repeat(40)}` as const;
// InsufficientOut()
const INSUFFICIENT_OUT = '0xbe664d40';

function stubClient(trace: () => Promise<unknown>, rawReceipt: object = { status: '0x0' }): PublicClient {
  return {
    getTransaction: async () => ({
      hash: HASH,
      blockHash: BLOCK,
      transactionIndex: 0,
      from: FROM,
      to: TO,
      value: 0n,
      nonce: 1,
      gas: 100000n,
      gasPrice: 1n,
      input: '0x',
    }),
    getTransactionReceipt: async () => ({
      blockHash: BLOCK,
      status: 'reverted',
      logs: [],
      gasUsed: 21000n,
      effectiveGasPrice: 1n,
      contractAddress: null,
    }),
    request: async ({ method }: { method: string }) => {
      if (method === 'eth_getTransactionReceipt') return rawReceipt;
      if (method === 'debug_traceTransaction') return trace();
      throw new Error(`unexpected ${method}`);
    },
  } as unknown as PublicClient;
}

describe('readBlockTransactions · revert reason from the node trace', () => {
  it('names the custom error the failed transaction returned', async () => {
    const [tx] = await readBlockTransactions(
      stubClient(async () => ({ output: INSUFFICIENT_OUT })),
      [HASH],
      BLOCK,
      'rpc',
    );
    expect(tx?.status).toBe('failed');
    expect(tx?.revertReason).toBe('InsufficientOut');
  });

  it('makes a chain-chosen reason storable: a NUL from the receipt or the trace never reaches Postgres', async () => {
    const noTrace = async () => {
      throw new Error('not traced');
    };
    const [fromReceipt] = await readBlockTransactions(
      stubClient(noTrace, { status: '0x0', revertReason: 'a\u0000b' }),
      [HASH],
      BLOCK,
      'rpc',
    );
    expect(fromReceipt?.revertReason).toBe('a b');
    // Error(string) carrying "x\u0000y"
    const data = '0x08c379a0' + '20'.padStart(64, '0') + '3'.padStart(64, '0') + '780079'.padEnd(64, '0');
    const [fromTrace] = await readBlockTransactions(
      stubClient(async () => ({ output: data })),
      [HASH],
      BLOCK,
      'rpc',
    );
    expect(fromTrace?.revertReason).toBe('x y');
  });

  it('keeps no reason when the contract returned none', async () => {
    const [tx] = await readBlockTransactions(
      stubClient(async () => ({ output: '0x' })),
      [HASH],
      BLOCK,
      'rpc',
    );
    expect(tx?.revertReason).toBeNull();
  });

  it('stores the reason as not read when the node refuses to trace, and keeps indexing the block', async () => {
    for (const refusal of [
      Object.assign(new Error('method not found'), { code: -32601 }),
      Object.assign(new Error('historical state unavailable'), { code: -32000 }),
      Object.assign(new Error('not on your plan'), { name: 'HttpRequestError', status: 403 }),
    ]) {
      const [tx] = await readBlockTransactions(
        stubClient(async () => Promise.reject(refusal)),
        [HASH],
        BLOCK,
        'rpc',
      );
      expect(tx?.revertReason).toBe(TRACE_NOT_READ);
    }
  });

  it('refuses the block when the trace read fails in transit', async () => {
    const down = Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    await expect(
      readBlockTransactions(
        stubClient(async () => Promise.reject(down)),
        [HASH],
        BLOCK,
        'rpc',
      ),
    ).rejects.toMatchObject({
      code: 'indexer.chain_unreachable',
    });
  });
});
