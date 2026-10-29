import { BaseError, ContractFunctionRevertedError, ContractFunctionZeroDataError, type Address, type Hex } from 'viem';
import { classifyChainError, ChainUnavailableError } from '../chain/availability.js';
import type { ProtocolChain } from '../chain/client.js';
import type { OwnershipChain } from './ownership.js';

const ownableAbi = [{ type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }] as const;
const erc1271Abi = [
  {
    type: 'function',
    name: 'isValidSignature',
    stateMutability: 'view',
    inputs: [
      { name: 'hash', type: 'bytes32' },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [{ type: 'bytes4' }],
  },
] as const;

/** A call the contract answered by reverting or with no data: it has no such function, which is an answer, not an outage. */
function contractSaidNo(err: unknown): boolean {
  return (
    err instanceof BaseError &&
    err.walk((e) => e instanceof ContractFunctionRevertedError || e instanceof ContractFunctionZeroDataError) !== null
  );
}

/**
 * The ownership reads over the service's own public client. An unreachable chain refuses with the chain's own code (never
 * read as "no owner"); a contract that has no `owner()` answers null, which the proof refuses as `owner_unknown`.
 */
export function ownershipChain(chain: ProtocolChain): OwnershipChain {
  const rpc = chain.config.rpcUrl;
  return {
    chainId: chain.config.chainId,
    async owner(token: Address) {
      if (!(await chain.isDeployed(token)))
        throw new ChainUnavailableError(
          'protocol.contract_not_deployed',
          `${token} holds no contract code on chain ${chain.config.chainId}, so it has no owner to prove.`,
        );
      try {
        const blockNumber = await chain.client.getBlockNumber();
        const owner = await chain.client.readContract({ address: token, abi: ownableAbi, functionName: 'owner', blockNumber });
        return /^0x0{40}$/i.test(owner) ? null : { owner, blockNumber };
      } catch (err) {
        if (contractSaidNo(err)) return null;
        throw classifyChainError(err, 'listing owner', rpc);
      }
    },
    async hasCode(account: Address) {
      return chain.isDeployed(account);
    },
    async isValidSignature(account: Address, hash: Hex, signature: Hex) {
      try {
        return await chain.client.readContract({
          address: account,
          abi: erc1271Abi,
          functionName: 'isValidSignature',
          args: [hash, signature],
        });
      } catch (err) {
        if (contractSaidNo(err)) return null;
        throw classifyChainError(err, 'listing isValidSignature', rpc);
      }
    },
  };
}
