/**
 * A contract's source status, its proxy and its Read and Write tabs (D-explorer-06), svc-protocol `contract.inspect`,
 * `contract.read` and `contract.buildWrite`. Public like the rest of the Protocol Plane: the visitor may be signed out.
 *
 * The source status is judged against the sources this platform compiled itself (svc-protocol `contracts/out/`), with
 * the constructor-set immutables masked: `exact` when the code on chain is that build byte for byte, `similar` when it
 * differs only in the compiler's metadata hash (the same code from a source that differs in comments, names or layout),
 * `unverified` otherwise, always with the reason. A proxy (EIP-1167 or EIP-1967) names its implementation and the Read and
 * Write tabs use the implementation's interface against the proxy's address. Write is never sent by the service: it
 * builds the call, and the person's own wallet signs and sends it.
 */
import { z } from 'zod';

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 20-byte hex address');

/** Read refused: the contract's interface is unknown, because neither it nor its implementation matched a source. */
export const CONTRACT_INTERFACE_UNKNOWN = 'protocol.contract_interface_unknown';
/** The function named is not in the contract's interface, or not in the tab it was asked from (a read that writes). */
export const CONTRACT_FUNCTION_UNKNOWN = 'protocol.contract_function_unknown';
/** An argument does not fit its declared type; the message names which one and why. */
export const CONTRACT_ARGUMENT_INVALID = 'protocol.contract_argument_invalid';
/** The read was answered with a revert; the message carries the contract's own reason when it gave one. */
export const CONTRACT_CALL_REVERTED = 'protocol.contract_call_reverted';
/** The read ran past the gas this platform allows one public read (`CONTRACT_READ_GAS` in svc-protocol). */
export const CONTRACT_READ_GAS_EXCEEDED = 'protocol.contract_read_gas_exceeded';
/** The contract answered with data that is not the function's declared answer (empty, or the wrong shape). */
export const CONTRACT_ANSWER_UNREADABLE = 'protocol.contract_answer_unreadable';

export const CONTRACT_SOURCE_STATUSES = ['exact', 'similar', 'unverified'] as const;
export type ContractSourceStatus = (typeof CONTRACT_SOURCE_STATUSES)[number];

/** Why a contract reads unverified. */
export const CONTRACT_UNVERIFIED_REASONS = ['no_code', 'no_matching_source'] as const;
export type ContractUnverifiedReason = (typeof CONTRACT_UNVERIFIED_REASONS)[number];

export const contractSourceSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('exact'),
      /** The matched build: contract name, source file and compiler. */
      name: z.string(),
      sourceName: z.string(),
      compiler: z.string(),
      sourceHash: z.string(),
    })
    .strict(),
  z
    .object({
      status: z.literal('similar'),
      name: z.string(),
      sourceName: z.string(),
      compiler: z.string(),
      sourceHash: z.string(),
    })
    .strict(),
  z.object({ status: z.literal('unverified'), reason: z.enum(CONTRACT_UNVERIFIED_REASONS) }).strict(),
]);
export type ContractSource = z.infer<typeof contractSourceSchema>;

const abiParam: z.ZodType<{ name: string; type: string; components?: unknown[] }> = z.lazy(() =>
  z.object({ name: z.string(), type: z.string(), components: z.array(abiParam).optional() }).strict(),
);

export const contractFunctionSchema = z
  .object({
    name: z.string(),
    /** `name(type,...)`, the key a read or write names. Unique within a contract even when names overload. */
    signature: z.string(),
    stateMutability: z.enum(['pure', 'view', 'nonpayable', 'payable']),
    inputs: z.array(abiParam),
    outputs: z.array(abiParam),
  })
  .strict();
export type ContractFunction = z.infer<typeof contractFunctionSchema>;

export const PROXY_STANDARDS = ['eip1167', 'eip1967'] as const;

export const protocolContractInspectInputSchema = z.object({ address }).strict();
export const protocolContractInspectOutputSchema = z
  .object({
    address: z.string(),
    chainId: z.number().int(),
    /** Decimal string: the block the code and the proxy slot were read at. */
    blockNumber: z.string(),
    source: contractSourceSchema,
    proxy: z
      .object({
        standard: z.enum(PROXY_STANDARDS),
        implementation: z.string(),
        source: contractSourceSchema,
      })
      .strict()
      .nullable(),
    /**
     * The interface the Read and Write tabs use: the implementation's for a proxy whose implementation matched a source,
     * else the contract's own when it matched; null when neither did.
     */
    interface: z
      .object({
        from: z.enum(['contract', 'implementation']),
        name: z.string(),
        read: z.array(contractFunctionSchema),
        write: z.array(contractFunctionSchema),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type ProtocolContractInspect = z.infer<typeof protocolContractInspectOutputSchema>;

const args = z.array(z.string().max(4096)).max(32);

export const protocolContractReadInputSchema = z.object({ address, signature: z.string().min(3).max(512), args }).strict();
export const protocolContractReadOutputSchema = z
  .object({
    blockNumber: z.string(),
    /** Each output in order, as text: integers in decimal, addresses checksummed, bytes in hex, lists and tuples as JSON. */
    outputs: z.array(z.object({ name: z.string(), type: z.string(), value: z.string() }).strict()),
  })
  .strict();
export type ProtocolContractRead = z.infer<typeof protocolContractReadOutputSchema>;

export const protocolContractBuildWriteInputSchema = z
  .object({
    address,
    signature: z.string().min(3).max(512),
    args,
    /** Decimal wei sent with a payable function; absent is none. */
    value: z
      .string()
      .regex(/^\d{1,78}$/)
      .optional(),
  })
  .strict();
export const protocolContractBuildWriteOutputSchema = z
  .object({
    chainId: z.number().int(),
    to: z.string(),
    data: z.string(),
    /** Hex wei. */
    value: z.string(),
  })
  .strict();
export type ProtocolContractWriteCall = z.infer<typeof protocolContractBuildWriteOutputSchema>;
