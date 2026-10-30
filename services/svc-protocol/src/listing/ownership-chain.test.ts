import { describe, expect, it } from 'vitest';
import { createPublicClient, custom, encodeAbiParameters, RpcRequestError, type Address } from 'viem';
import type { ProtocolChain } from '../chain/client.js';
import { ownershipChain } from './ownership-chain.js';

const TOKEN = '0x00000000000000000000000000000000000a11ce' as Address;
const OWNER = '0x00000000000000000000000000000000000B0b00' as Address;

/** A real viem client whose node answers `eth_call` with `reply`, so errors are wrapped exactly as viem wraps them. */
function chainThat(reply: () => unknown): ProtocolChain {
  const client = createPublicClient({
    transport: custom(
      {
        async request({ method }) {
          if (method === 'eth_blockNumber') return '0x9';
          if (method === 'eth_call') return reply();
          throw new Error(`unexpected ${method}`);
        },
      },
      { retryCount: 0 },
    ),
  });
  return { config: { chainId: 84532, rpcUrl: 'http://node.test' }, isDeployed: async () => true, client } as unknown as ProtocolChain;
}
const rpcError = (code: number, message: string) =>
  new RpcRequestError({ body: { method: 'eth_call' }, error: { code, message }, url: 'http://node.test' });

describe('ownershipChain', () => {
  it('a contract with no owner() (the node answers code 3, execution reverted) names no owner', async () => {
    await expect(ownershipChain(chainThat(() => Promise.reject(rpcError(3, 'execution reverted')))).owner(TOKEN)).resolves.toBeNull();
  });

  it('a -32603 internal error that viem wraps as a revert is the chain refusing, never "no owner"', async () => {
    await expect(
      ownershipChain(chainThat(() => Promise.reject(rpcError(-32603, 'execution reverted')))).owner(TOKEN),
    ).rejects.toMatchObject({
      code: 'protocol.chain_unreachable',
    });
  });

  it('reads the owner at one block and returns it with that block', async () => {
    const answer = encodeAbiParameters([{ type: 'address' }], [OWNER]);
    await expect(ownershipChain(chainThat(() => answer)).owner(TOKEN)).resolves.toEqual({ owner: OWNER, blockNumber: 9n });
  });
});
