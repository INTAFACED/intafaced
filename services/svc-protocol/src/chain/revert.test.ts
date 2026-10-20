import { createPublicClient, custom, encodeAbiParameters, HttpRequestError, RpcRequestError, TimeoutError, type Address } from 'viem';
import { describe, expect, it } from 'vitest';
import { erc20ApprovalAbi } from './abi.js';
import { ProtocolChain } from './client.js';
import { isExecutionRevert } from './revert.js';

const OWNER = '0x1111111111111111111111111111111111111111' as Address;
const TOKEN = '0x2222222222222222222222222222222222222222' as Address;
const SPENDER = '0x3333333333333333333333333333333333333333' as Address;

/** The error viem really throws for `approve`, given what the node's transport does on `eth_call`. */
async function thrownFor(reply: () => unknown): Promise<unknown> {
  const client = createPublicClient({
    transport: custom(
      {
        async request({ method }) {
          if (method === 'eth_call') return reply();
          throw new Error(`unexpected ${method}`);
        },
      },
      { retryCount: 0 },
    ),
  });
  try {
    await client.simulateContract({ address: TOKEN, abi: erc20ApprovalAbi, functionName: 'approve', args: [SPENDER, 10n], account: OWNER });
  } catch (err) {
    return err;
  }
  return null;
}
const rpcError = (code: number, message: string) =>
  new RpcRequestError({ body: { method: 'eth_call' }, error: { code, message }, url: 'http://node.test' });

describe('isExecutionRevert', () => {
  it('counts a node answering code 3 "execution reverted" as a revert', async () => {
    throw_(await thrownFor(() => Promise.reject(rpcError(3, 'execution reverted'))), true);
  });

  it('counts a revert that carries reason data as a revert', async () => {
    const err = new RpcRequestError({
      body: { method: 'eth_call' },
      error: { code: 3, message: 'execution reverted: allowance must be zero', data: '0x08c379a0' },
      url: 'http://node.test',
    });
    throw_(await thrownFor(() => Promise.reject(err)), true);
  });

  it('does NOT count a bare -32603 internal error as a revert', async () => {
    throw_(await thrownFor(() => Promise.reject(rpcError(-32603, 'Internal error'))), false);
    throw_(await thrownFor(() => Promise.reject(rpcError(-32603, 'execution reverted'))), false);
  });

  it('does NOT count a timeout or an HTTP 5xx whose body says "execution reverted" as a revert', async () => {
    throw_(await thrownFor(() => Promise.reject(new TimeoutError({ body: { method: 'eth_call' }, url: 'http://node.test' }))), false);
    const http = new HttpRequestError({
      body: { method: 'eth_call' },
      details: 'execution reverted',
      status: 502,
      url: 'http://node.test',
    });
    throw_(await thrownFor(() => Promise.reject(http)), false);
  });

  it('does NOT count a plain failure or no error at all', async () => {
    throw_(await thrownFor(() => Promise.reject(new Error('socket hang up'))), false);
    expect(isExecutionRevert(undefined)).toBe(false);
    expect(isExecutionRevert('execution reverted')).toBe(false);
  });
});

function throw_(err: unknown, expected: boolean): void {
  expect(err).not.toBeNull();
  expect(isExecutionRevert(err)).toBe(expected);
}

/** The same answers, through the real ProtocolChain method the router calls. */
function chainOver(reply: () => unknown): ProtocolChain {
  const chain = new ProtocolChain({
    chainId: 84532,
    rpcUrl: 'http://node.test',
    entryPoint: '0x4444444444444444444444444444444444444444',
    factory: '0x0000000000000000000000000000000000000000',
    implementation: '0x0000000000000000000000000000000000000000',
  });
  (chain as { client: unknown }).client = createPublicClient({
    transport: custom(
      {
        async request() {
          return reply();
        },
      },
      { retryCount: 0 },
    ),
  });
  return chain;
}
const bool = (value: boolean) => encodeAbiParameters([{ type: 'bool' }], [value]);

describe('ProtocolChain.directApproveReverts', () => {
  it('is yes only for a real revert, or for a token answering false', async () => {
    expect(await chainOver(() => Promise.reject(rpcError(3, 'execution reverted'))).directApproveReverts(TOKEN, OWNER, SPENDER, 10n)).toBe(
      true,
    );
    expect(await chainOver(() => bool(false)).directApproveReverts(TOKEN, OWNER, SPENDER, 10n)).toBe(true);
  });

  it('is no when the direct change simulates cleanly', async () => {
    expect(await chainOver(() => bool(true)).directApproveReverts(TOKEN, OWNER, SPENDER, 10n)).toBe(false);
  });

  it('refuses, rather than answering yes, when the node is flaky', async () => {
    for (const reply of [
      () => Promise.reject(rpcError(-32603, 'Internal error')),
      () => Promise.reject(new TimeoutError({ body: { method: 'eth_call' }, url: 'http://node.test' })),
      () =>
        Promise.reject(
          new HttpRequestError({ body: { method: 'eth_call' }, details: 'execution reverted', status: 503, url: 'http://node.test' }),
        ),
    ]) {
      await expect(chainOver(reply).directApproveReverts(TOKEN, OWNER, SPENDER, 10n)).rejects.toMatchObject({
        name: 'ChainUnavailableError',
      });
    }
  });
});
