import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeAbiParameters, type Address } from 'viem';
import { ProtocolChain, TOKEN_READ_GAS } from './client.js';

/**
 * Every view on a token contract serves a public request on a contract anyone can write, so each call to the node
 * carries `TOKEN_READ_GAS` as its cap. The errors keep their meaning: an empty answer is an absent contract, and a
 * revert is a revert.
 */
const ZERO = '0x0000000000000000000000000000000000000000' as Address;
const TOKEN = '0x00000000000000000000000000000000000000a1' as Address;
const POOL = '0x00000000000000000000000000000000000000b2' as Address;
const GAS = `0x${TOKEN_READ_GAS.toString(16)}`;

let server: Server | null = null;
afterEach(async () => {
  const s = server;
  server = null;
  if (s) await new Promise<void>((resolve) => s.close(() => resolve()));
});

type Answer = { result: string } | { error: { code: number; message: string; data?: string } };

/** A node that answers every `eth_call` with `answer(call)` and keeps each call's parameters. */
async function node(answer: (call: { data: string }) => Answer) {
  const calls: Array<{ call: Record<string, unknown>; block: unknown }> = [];
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const body = JSON.parse(raw) as { id: number; method: string; params: unknown[] };
      let reply: Answer = { result: '0x' };
      if (body.method === 'eth_call') {
        const call = body.params[0] as Record<string, unknown> & { data: string };
        calls.push({ call, block: body.params[1] });
        reply = answer(call);
      } else if (body.method === 'eth_blockNumber') reply = { result: '0x9' };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, ...reply }));
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
const uint = (value: bigint) => ({ result: encodeAbiParameters([{ type: 'uint256' }], [value]) });

describe('token views carry a gas cap', () => {
  it('tokenBalanceAt reads balanceOf at its block, capped', async () => {
    const { chain, calls } = await node(() => uint(1234n));
    expect(await chain.tokenBalanceAt(TOKEN, POOL, 7n)).toBe(1234n);
    expect(calls).toEqual([{ call: expect.objectContaining({ to: TOKEN, gas: GAS }), block: '0x7' }]);
  });

  it('allowanceAt and tokenAllowance are capped; tokenAllowance reads at the block it reports', async () => {
    const { chain, calls } = await node(() => uint(5n));
    expect(await chain.allowanceAt(TOKEN, POOL, ZERO, 7n)).toBe(5n);
    expect(await chain.tokenAllowance(TOKEN, POOL, ZERO)).toEqual({ value: 5n, blockNumber: 9n });
    expect(calls.map((c) => [c.call.gas, c.block])).toEqual([
      [GAS, '0x7'],
      [GAS, '0x9'],
    ]);
  });

  it('tokenBasics reads name, symbol and decimals, each capped', async () => {
    const { chain, calls } = await node((call) =>
      call.data.startsWith('0x313ce567')
        ? uint(18n)
        : { result: encodeAbiParameters([{ type: 'string' }], [call.data.startsWith('0x06fdde03') ? 'TEST Token' : 'TT']) },
    );
    expect(await chain.tokenBasics(TOKEN)).toEqual({ name: 'TEST Token', symbol: 'TT', decimals: 18 });
    expect(calls.map((c) => c.call.gas)).toEqual([GAS, GAS, GAS]);
  });

  it('an empty answer is an absent contract, never a zero balance', async () => {
    const { chain } = await node(() => ({ result: '0x' }));
    await expect(chain.tokenBalanceAt(TOKEN, POOL, 7n)).rejects.toMatchObject({ code: 'protocol.contract_not_deployed' });
  });

  it('a malformed answer refuses as viem wraps it, never a value and never a revert', async () => {
    const { chain } = await node(() => ({ result: '0x01' }));
    const err = await chain.tokenBalanceAt(TOKEN, POOL, 7n).then(
      () => null,
      (e: unknown) => e,
    );
    // The node answered, so this is not an absent contract; "no usable answer" is the existing classification.
    expect(err).toMatchObject({ code: 'protocol.chain_unreachable' });
    expect(String((err as { cause?: { name?: string } }).cause?.name)).toBe('ContractFunctionExecutionError');
    // A malformed allowance is unread (rejects), not a revert read as null.
    await expect(chain.allowanceAt(TOKEN, POOL, ZERO, 7n)).rejects.toMatchObject({ code: 'protocol.chain_unreachable' });
  });

  it('a token that reverts on allowance still reads as a revert (null), not an outage', async () => {
    const { chain } = await node(() => ({ error: { code: 3, message: 'execution reverted', data: '0x' } }));
    expect(await chain.allowanceAt(TOKEN, POOL, ZERO, 7n)).toBeNull();
  });
});
