import { decodeErrorResult, parseAbi, type Hex } from 'viem';

/**
 * Why a mined transaction failed.
 *
 * The reason is the revert data of the real execution, read from the node's
 * own trace of that transaction (`debug_traceTransaction`, call tracer, top
 * call only). Replaying the call against the parent block is not used: an
 * earlier transaction in the same block can change the state, so a replay can
 * name an error the transaction never raised.
 *
 * Empty revert data is a contract that gave no reason, and reads as `null`
 * ("No reason returned"). A node that does not trace says so in the reason
 * instead of passing for a contract that gave none.
 */

/**
 * Errors named when they come back: the AMM pools, factory and router, and the TEST token
 * (`svc-protocol/contracts`). Any other selector reads as "Custom error 0x…", never as no reason.
 */
const KNOWN_ERRORS = parseAbi([
  'error Error(string message)',
  'error Panic(uint256 code)',
  'error BadPool()',
  'error BadAmount()',
  'error TransferFailed()',
  'error InsufficientOut()',
  'error InvalidTokens()',
  'error InsufficientLiquidity()',
  'error InsufficientInput()',
  'error InsufficientOutput()',
  'error InvalidFee()',
  'error K()',
  'error Overflow()',
  'error IdenticalTokens()',
  'error ZeroAddress()',
  'error PoolExists()',
  'error PermitExpired()',
  'error InvalidSigner()',
  'error StringTooLong()',
]);

export const TRACE_UNAVAILABLE_REASON = 'Reason not read: this network’s node does not trace transactions';

/** Revert data to the words the transaction page shows. `null` when the contract returned nothing. */
export function revertReasonFromData(data: string | null | undefined): string | null {
  if (typeof data !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(data) || data.length <= 2) return null;
  if (data.length < 10) return `Unrecognised revert data ${data.toLowerCase()}`;
  try {
    const decoded = decodeErrorResult({ abi: KNOWN_ERRORS, data: data as Hex });
    if (decoded.errorName === 'Error') {
      const message = String(decoded.args?.[0] ?? '').trim();
      return message === '' ? 'Error with an empty message' : message;
    }
    if (decoded.errorName === 'Panic') return `Panic(0x${(decoded.args?.[0] as bigint).toString(16)})`;
    return decoded.errorName;
  } catch {
    return `Custom error ${data.slice(0, 10).toLowerCase()}`;
  }
}

/** JSON-RPC "method not found" / "not supported": the node will not trace, which is an answer, not an outage. */
export function isTraceUnsupported(err: unknown): boolean {
  let current = err;
  for (let depth = 0; current !== undefined && current !== null && depth < 12; depth += 1) {
    const code = (current as { code?: unknown }).code;
    const name = (current as { name?: unknown }).name;
    if (code === -32601 || code === -32004) return true;
    if (name === 'MethodNotFoundRpcError' || name === 'MethodNotSupportedRpcError') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** The top call's revert data out of a call-tracer answer. */
export function traceOutput(trace: unknown): string | null {
  if (!trace || typeof trace !== 'object') return null;
  const output = (trace as { output?: unknown }).output;
  return typeof output === 'string' ? output : null;
}
