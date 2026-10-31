import { decodeFunctionResult, encodeFunctionData, type Address, type Hex } from 'viem';
import { classifyChainError, ChainUnavailableError } from '../chain/availability.js';
import type { ProtocolChain } from '../chain/client.js';
import { isExecutionRevert } from '../chain/revert.js';
import { chainIdentityReader, type ChainIdentityReader } from '../chain/identity.js';
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

/**
 * The most gas an ownership read may burn on the node. `owner()` and `isValidSignature` are views on contracts anyone can
 * write, so an unbounded call could spend the node's whole call gas cap on every public request.
 */
export const OWNER_READ_GAS = 100_000n;
export const ERC1271_READ_GAS = 300_000n;

/**
 * A call the contract answered by reverting: it has no such function, which is an answer, not an outage. A node error
 * that merely looks like a revert (-32603, a timeout, a 5xx) is not one: `isExecutionRevert` tells them apart.
 */
const contractSaidNo = (err: unknown): boolean => isExecutionRevert(err);

/** The decoded answer, or null when the contract returned nothing or something that is not that function's answer. */
function decoded<T>(decode: () => T): T | null {
  try {
    return decode();
  } catch {
    return null;
  }
}

/**
 * The ownership reads over the service's own public client. An unreachable chain refuses with the chain's own code (never
 * read as "no owner"); a contract that has no `owner()` answers null, which the proof refuses as `owner_unknown`.
 */
export function ownershipChain(chain: ProtocolChain, identity: ChainIdentityReader = chainIdentityReader(chain)): OwnershipChain {
  const rpc = chain.config.rpcUrl;
  return {
    chainId: chain.config.chainId,
    // Issuing and verifying both write a row labelled with this genesis, so it is read afresh each time.
    identity: () => identity({ fresh: true }),
    async owner(token: Address) {
      if (!(await chain.isDeployed(token)))
        throw new ChainUnavailableError(
          'protocol.contract_not_deployed',
          `${token} holds no contract code on chain ${chain.config.chainId}, so it has no owner to prove.`,
        );
      try {
        const blockNumber = await chain.client.getBlockNumber();
        const { data } = await chain.client.call({
          to: token,
          data: encodeFunctionData({ abi: ownableAbi, functionName: 'owner' }),
          gas: OWNER_READ_GAS,
          blockNumber,
        });
        const owner = data ? decoded(() => decodeFunctionResult({ abi: ownableAbi, functionName: 'owner', data })) : null;
        return !owner || /^0x0{40}$/i.test(owner) ? null : { owner, blockNumber };
      } catch (err) {
        if (contractSaidNo(err)) return null;
        throw classifyChainError(err, 'listing owner', rpc);
      }
    },
    async hasCode(account: Address, blockNumber: bigint) {
      try {
        const code = await chain.client.getCode({ address: account, blockNumber });
        return code !== undefined && code !== '0x';
      } catch (err) {
        throw classifyChainError(err, 'listing hasCode', rpc);
      }
    },
    async isValidSignature(account: Address, hash: Hex, signature: Hex, blockNumber: bigint) {
      try {
        const { data } = await chain.client.call({
          to: account,
          data: encodeFunctionData({ abi: erc1271Abi, functionName: 'isValidSignature', args: [hash, signature] }),
          gas: ERC1271_READ_GAS,
          blockNumber,
        });
        return data ? decoded(() => decodeFunctionResult({ abi: erc1271Abi, functionName: 'isValidSignature', data })) : null;
      } catch (err) {
        if (contractSaidNo(err)) return null;
        throw classifyChainError(err, 'listing isValidSignature', rpc);
      }
    },
  };
}
