import type { PublicClient } from 'viem';
import { describe, expect, it } from 'vitest';
import { readBlockTransactions } from './explorer-txs.js';
import { TRACE_UNAVAILABLE_REASON } from './revert-reason.js';

const BLOCK = `0x${'b'.repeat(64)}` as const;
const HASH = `0x${'a'.repeat(64)}` as const;
const FROM = `0x${'1'.repeat(40)}` as const;
const TO = `0x${'2'.repeat(40)}` as const;
// InsufficientOut()
const INSUFFICIENT_OUT = '0xbe664d40';

function stubClient(trace: () => Promise<unknown>): PublicClient {
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
      if (method === 'eth_getTransactionReceipt') return { status: '0x0' };
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

  it('keeps no reason when the contract returned none', async () => {
    const [tx] = await readBlockTransactions(
      stubClient(async () => ({ output: '0x' })),
      [HASH],
      BLOCK,
      'rpc',
    );
    expect(tx?.revertReason).toBeNull();
  });

  it('says the reason was not read when the node will not trace', async () => {
    const unsupported = Object.assign(new Error('method not found'), { code: -32601 });
    const [tx] = await readBlockTransactions(
      stubClient(async () => Promise.reject(unsupported)),
      [HASH],
      BLOCK,
      'rpc',
    );
    expect(tx?.revertReason).toBe(TRACE_UNAVAILABLE_REASON);
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
