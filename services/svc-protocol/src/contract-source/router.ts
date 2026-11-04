import { decodeErrorResult, getAddress, type Abi, type Address, type Hex } from 'viem';
import { publicJurisdictionProcedure, router, TRPCError } from '@intafaced/contracts';
import {
  CONTRACT_CALL_REVERTED,
  CONTRACT_INTERFACE_UNKNOWN,
  CONTRACT_ARGUMENT_INVALID,
  protocolContractBuildWriteInputSchema,
  protocolContractBuildWriteOutputSchema,
  protocolContractInspectInputSchema,
  protocolContractInspectOutputSchema,
  protocolContractReadInputSchema,
  protocolContractReadOutputSchema,
  type ProtocolContractInspect,
} from '@intafaced/contracts/protocol-contract-source';
import type { ContractArtifact } from '../chain/artifacts.js';
import { classifyChainError } from '../chain/availability.js';
import type { ProtocolChain } from '../chain/client.js';
import { isExecutionRevert } from '../chain/revert.js';
import {
  coerceArgs,
  ContractCallError,
  decodeOutputs,
  EIP1967_IMPLEMENTATION_SLOT,
  encodeCall,
  findFunction,
  interfaceOf,
  loadSources,
  matchSource,
  minimalProxyTarget,
  slotImplementation,
  type SourceMatch,
} from './source.js';

/**
 * The most gas one Read may burn on the node. Read is public and the function is the visitor's choice, on a contract
 * anyone can write, so an unbounded view could spend the node's whole call gas cap on every request.
 */
export const CONTRACT_READ_GAS = 1_000_000n;

/** The chain reads the contract tabs make, every one at a named block. */
export interface ContractChain {
  chainId: number;
  head(): Promise<bigint>;
  code(address: Address, block: bigint): Promise<Hex | null>;
  storage(address: Address, slot: Hex, block: bigint): Promise<Hex | null>;
  /** An `eth_call` capped at `CONTRACT_READ_GAS`. A revert keeps its error so its reason can be decoded. */
  call(to: Address, data: Hex, block: bigint): Promise<Hex>;
}

/** The reads over the service's own public client; an unreachable node is classified by name, never read as "no code". */
export function contractChain(chain: ProtocolChain): ContractChain {
  const rpc = chain.config.rpcUrl;
  const read = async <T>(what: string, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      throw classifyChainError(err, what, rpc);
    }
  };
  return {
    chainId: chain.config.chainId,
    head: () => read('contract.head', () => chain.client.getBlockNumber()),
    code: (address, block) =>
      read('contract.getCode', async () => {
        const code = await chain.client.getCode({ address, blockNumber: block });
        return code === undefined || code === '0x' ? null : code;
      }),
    storage: (address, slot, block) =>
      read('contract.getStorageAt', async () => (await chain.client.getStorageAt({ address, slot, blockNumber: block })) ?? null),
    call: async (to, data, block) => {
      try {
        const { data: answer } = await chain.client.call({ to, data, gas: CONTRACT_READ_GAS, blockNumber: block });
        return answer ?? '0x';
      } catch (err) {
        if (isExecutionRevert(err)) throw err;
        throw classifyChainError(err, 'contract.call', rpc);
      }
    },
  };
}

/** The revert data a node returned, from anywhere in the error's cause chain. */
function revertData(err: unknown): Hex | null {
  for (let link: unknown = err, depth = 0; link && typeof link === 'object' && depth < 10; depth += 1) {
    const data = (link as { data?: unknown }).data;
    if (typeof data === 'string' && /^0x(?:[0-9a-fA-F]{2})*$/.test(data)) return data as Hex;
    if (data && typeof data === 'object' && typeof (data as { data?: unknown }).data === 'string') return (data as { data: Hex }).data;
    link = (link as { cause?: unknown }).cause;
  }
  return null;
}

/** The contract's own reason for a revert: its custom error or `Error(string)`, else "No reason returned". */
export function revertReason(abi: Abi, err: unknown): string {
  const data = revertData(err);
  if (!data || data === '0x') return 'No reason returned';
  try {
    const decoded = decodeErrorResult({ abi, data });
    if (decoded.errorName === 'Error' && typeof decoded.args?.[0] === 'string') return decoded.args[0];
    return decoded.errorName;
  } catch {
    return `Unrecognised revert data ${data.slice(0, 10)}`;
  }
}

export interface ContractSourceDeps {
  chain: () => ContractChain;
  /** The committed builds; defaults to `contracts/out/`, read once. */
  sources?: readonly ContractArtifact[];
  /** Shapes a chain refusal the way the rest of the router does. */
  toTrpcError: (err: unknown) => TRPCError;
}

interface Inspected {
  output: ProtocolContractInspect;
  abi: Abi | null;
  block: bigint;
}

/**
 * `protocol.contract.*` (D-explorer-06): a contract's source status, its proxy, and the Read and Write tabs. Read is an
 * `eth_call` the service makes at one block; Write only builds the call, which the person's own wallet signs and sends.
 * Nothing here holds a key or can post.
 */
export function createContractSourceRouter(deps: ContractSourceDeps) {
  const sources = deps.sources ?? loadSources();

  async function inspect(address: Address): Promise<Inspected> {
    const chain = deps.chain();
    const block = await chain.head();
    const runtime = await chain.code(address, block);
    const own: SourceMatch = matchSource(sources, runtime);
    let proxy: ProtocolContractInspect['proxy'] = null;
    let implementation: SourceMatch | null = null;
    if (runtime) {
      const clone = minimalProxyTarget(runtime);
      const target = clone ?? slotImplementation(await chain.storage(address, EIP1967_IMPLEMENTATION_SLOT, block));
      if (target) {
        implementation = matchSource(sources, await chain.code(target as Address, block));
        proxy = { standard: clone ? 'eip1167' : 'eip1967', implementation: target, source: implementation.source };
      }
    }
    const from = implementation?.artifact ? implementation : !proxy && own.artifact ? own : null;
    const abi = from?.artifact?.abi ?? null;
    return {
      block,
      abi,
      output: {
        address: getAddress(address),
        chainId: chain.chainId,
        blockNumber: block.toString(),
        source: own.source,
        proxy,
        interface:
          from && abi
            ? { from: from === implementation ? 'implementation' : 'contract', name: from.artifact!.contractName, ...interfaceOf(abi) }
            : null,
      },
    };
  }

  const requireInterface = (found: Inspected): Abi => {
    if (found.abi) return found.abi;
    throw new ContractCallError(
      CONTRACT_INTERFACE_UNKNOWN,
      found.output.proxy
        ? `the implementation ${found.output.proxy.implementation} matches no source on file, so its interface is unknown.`
        : 'this contract matches no source on file, so its interface is unknown.',
    );
  };

  const guard = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ContractCallError) {
        const code =
          err.code === CONTRACT_INTERFACE_UNKNOWN
            ? 'PRECONDITION_FAILED'
            : err.code === CONTRACT_CALL_REVERTED
              ? 'CONFLICT'
              : 'BAD_REQUEST';
        throw new TRPCError({ code, message: err.message, cause: err });
      }
      throw deps.toTrpcError(err);
    }
  };

  return router({
    inspect: publicJurisdictionProcedure('protocol', 'protocol')
      .input(protocolContractInspectInputSchema)
      .output(protocolContractInspectOutputSchema)
      .query(({ input }) => guard(async () => (await inspect(input.address as Address)).output)),

    read: publicJurisdictionProcedure('protocol', 'protocol')
      .input(protocolContractReadInputSchema)
      .output(protocolContractReadOutputSchema)
      .query(({ input }) =>
        guard(async () => {
          const found = await inspect(input.address as Address);
          const abi = requireInterface(found);
          const fn = findFunction(abi, input.signature, 'read');
          const data = encodeCall(fn, coerceArgs(fn, input.args));
          let answer: Hex;
          try {
            answer = await deps.chain().call(input.address as Address, data, found.block);
          } catch (err) {
            if (!isExecutionRevert(err)) throw err;
            throw new ContractCallError(CONTRACT_CALL_REVERTED, `the contract reverted: ${revertReason(abi, err)}.`);
          }
          return { blockNumber: found.block.toString(), outputs: decodeOutputs(fn, answer) };
        }),
      ),

    buildWrite: publicJurisdictionProcedure('protocol', 'protocol')
      .input(protocolContractBuildWriteInputSchema)
      .output(protocolContractBuildWriteOutputSchema)
      .query(({ input }) =>
        guard(async () => {
          const found = await inspect(input.address as Address);
          const fn = findFunction(requireInterface(found), input.signature, 'write');
          const value = BigInt(input.value ?? '0');
          if (value > 0n && fn.stateMutability !== 'payable')
            throw new ContractCallError(CONTRACT_ARGUMENT_INVALID, `${input.signature} is not payable, so it takes no value.`);
          return {
            chainId: found.output.chainId,
            to: found.output.address,
            data: encodeCall(fn, coerceArgs(fn, input.args)),
            value: `0x${value.toString(16)}`,
          };
        }),
      ),
  });
}
