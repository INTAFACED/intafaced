import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeAbiParameters, type Address } from 'viem';
import { BALANCE_READ_GAS, ProtocolChain } from './client.js';

/**
 * `tokenBalanceAt` reads `balanceOf` on any token the factory's pools hold, for a public request: the call to the node
 * carries a gas cap, so a token contract cannot spend the node's whole call gas on each read.
 */
const ZERO = '0x0000000000000000000000000000000000000000' as Address;
const TOKEN = '0x00000000000000000000000000000000000000a1' as Address;
const POOL = '0x00000000000000000000000000000000000000b2' as Address;

let server: Server | null = null;
afterEach(async () => {
  const s = server;
  server = null;
  if (s) await new Promise<void>((resolve) => s.close(() => resolve()));
});

/** A node that answers `eth_call` with `result` and keeps every call's parameters. */
async function node(result: string) {
  const calls: Array<Record<string, unknown>> = [];
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const body = JSON.parse(raw) as { id: number; method: string; params: unknown[] };
      if (body.method === 'eth_call') calls.push(body.params[0] as Record<string, unknown>);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: body.method === 'eth_chainId' ? '0x7a69' : result }));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const chain = new ProtocolChain({
    chainId: 31337,
    rpcUrl: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`,
    entryPoint: ZERO,
    factory: ZERO,
    implementation: ZERO,
  });
  return { chain, calls };
}

describe('tokenBalanceAt', () => {
  it('reads balanceOf at the block with a gas cap on the call', async () => {
    const { chain, calls } = await node(encodeAbiParameters([{ type: 'uint256' }], [1234n]));
    expect(await chain.tokenBalanceAt(TOKEN, POOL, 7n)).toBe(1234n);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ to: TOKEN, gas: `0x${BALANCE_READ_GAS.toString(16)}` });
  });

  it('an empty answer is not a balance: it refuses rather than reading as zero', async () => {
    const { chain } = await node('0x');
    await expect(chain.tokenBalanceAt(TOKEN, POOL, 7n)).rejects.toThrow();
  });
});
