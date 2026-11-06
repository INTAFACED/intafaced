/**
 * #7192: the service's chain client never answers the block number from a cache. Every pinned read (allowance, owner,
 * fee quote) and /ready asks the node, so a block mined a moment ago is the one read.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProtocolChain } from './client.js';

/** A JSON-RPC node that mines a block between every two eth_blockNumber calls, as anvil does under a stream of writes. */
let server: Server;
let url = '';
let block = 0;
beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const { id, method } = JSON.parse(body) as { id: number; method: string };
      const result = method === 'eth_blockNumber' ? `0x${(++block).toString(16)}` : method === 'eth_chainId' ? '0x14a34' : null;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('ProtocolChain block number (#7192)', () => {
  it('asks the node every time, never a cached number', async () => {
    const chain = new ProtocolChain({
      chainId: 84532,
      rpcUrl: url,
      entryPoint: '0x4444444444444444444444444444444444444444',
      factory: '0x0000000000000000000000000000000000000000',
      implementation: '0x0000000000000000000000000000000000000000',
    });
    const first = await chain.client.getBlockNumber();
    expect(await chain.client.getBlockNumber()).toBe(first + 1n);
    expect(await chain.headBlock()).toBe(first + 2n);
  });
});
