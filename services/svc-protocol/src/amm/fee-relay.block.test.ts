/**
 * #7192: a fee quote is read at the node's block now, not at a block number viem cached. The dev chain mines at once,
 * so a relay deployed a moment ago is already there; a quote pinned to a block from before it read `quoteCharge` as
 * "0x" (fee-relay-onchain.test.ts, main run 42139825376).
 */
import { createPublicClient, defineChain, encodeAbiParameters, hexToBigInt, type Address, type Hex, type Transport } from 'viem';
import { describe, expect, it } from 'vitest';
import { quoteFee, readFeeTokens, type FeeRelayChain } from './fee-relay.js';

const RELAY: Address = '0x00000000000000000000000000000000000fee01';
const TOKEN: Address = '0x00000000000000000000000000000000000000c1';
const DEPLOYED_AT = 2n;

/**
 * A node at block 1 that mines the relay's deploy as block 2 when `deploy()` is called. An eth_call pinned to a block
 * before the deploy finds no code ("0x"); from the deploy on it answers like the relay.
 */
function node() {
  let block = 1n;
  const transport = (() => ({
    config: { key: 'stub', name: 'stub', request: async () => null, retryCount: 0, retryDelay: 0, timeout: 1, type: 'stub' },
    request: async ({ method, params }: { method: string; params?: unknown[] }) => {
      if (method === 'eth_chainId') return '0x7a69';
      if (method === 'eth_blockNumber') return `0x${block.toString(16)}`;
      if (method === 'eth_call') {
        const [call, tag] = params as [{ data: Hex }, Hex];
        if (hexToBigInt(tag) < DEPLOYED_AT) return '0x';
        if (call.data.length > 10)
          return encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint64' }], [123n, 4n, 1_800_000_000n]);
        return encodeAbiParameters([{ type: 'uint16' }], [500]);
      }
      return null;
    },
    value: undefined,
  })) as unknown as Transport;
  const chain = defineChain({
    id: 31337,
    name: 'TEST dev chain',
    nativeCurrency: { name: 'TEST', symbol: 'TEST', decimals: 18 },
    rpcUrls: { default: { http: ['http://127.0.0.1:8545'] } },
  });
  // As the dev chain and the service build theirs: a polling interval, so viem caches the block number for it.
  const client = createPublicClient({ chain, transport, pollingInterval: 4_000 });
  return {
    chain: client as unknown as FeeRelayChain,
    deploy: () => {
      block = DEPLOYED_AT;
    },
  };
}

const setting = { relay: RELAY, url: 'http://relayer.invalid/relay', gasLimit: 400_000n };

describe('fee quotes read the block the node is at now (#7192)', () => {
  it('quotes a relay deployed a moment after the block number was last read', async () => {
    const { chain, deploy } = node();
    expect(await chain.getBlockNumber()).toBe(1n); // a read before the deploy: viem now holds block 1
    deploy();
    const quote = await quoteFee(chain, setting, TOKEN, 2_000_000_000n);
    expect(quote).toMatchObject({ blockNumber: '2', charge: '123', markupBps: 500 });
  });

  it('reads the relay token list at the block now, too', async () => {
    const calls: unknown[] = [];
    const chain = {
      getBlockNumber: async (args?: { cacheTime?: number }) => {
        calls.push(args);
        throw new Error('stop after the block number');
      },
    } as unknown as FeeRelayChain;
    await expect(readFeeTokens(chain, setting)).rejects.toThrow('stop after the block number');
    expect(calls).toEqual([{ cacheTime: 0 }]);
  });
});
