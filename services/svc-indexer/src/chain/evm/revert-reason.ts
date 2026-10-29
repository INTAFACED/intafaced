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
 * ("No reason returned"), unless the tracer names a failure of its own (out of
 * gas, an invalid opcode). A node that answers the trace with a refusal (no
 * debug methods, no history, not on the plan) stores `TRACE_NOT_READ`, which the
 * page words; only a failure in transit refuses the block, so a node that will
 * never trace cannot stall ingest.
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

/** Stored in place of a reason when the node refused to trace the transaction. A code, not words: the page words it. */
export const TRACE_NOT_READ = 'indexer.trace_unavailable';

/** Longest reason kept, in characters; a longer one is cut and ends with an ellipsis. */
export const REASON_MAX_CHARS = 256;

/**
 * A chain-supplied reason made safe to store and show. The message is attacker-chosen: a NUL byte would make Postgres
 * refuse the row and hold the block back forever, so control characters become spaces, a lone surrogate becomes U+FFFD
 * and the length is capped. `null` when nothing readable is left.
 */
export function storableReason(text: string): string | null {
  const clean = text
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD')
    .trim();
  if (clean === '') return null;
  const chars = Array.from(clean);
  return chars.length <= REASON_MAX_CHARS ? clean : `${chars.slice(0, REASON_MAX_CHARS - 1).join('')}…`;
}

/** Revert data to the words the transaction page shows. `null` when the contract returned nothing. */
export function revertReasonFromData(data: string | null | undefined): string | null {
  if (typeof data !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(data) || data.length <= 2) return null;
  if (data.length < 10) return `Unrecognised revert data ${data.toLowerCase()}`;
  try {
    const decoded = decodeErrorResult({ abi: KNOWN_ERRORS, data: data as Hex });
    if (decoded.errorName === 'Error') {
      return storableReason(String(decoded.args?.[0] ?? '')) ?? 'Error with an empty message';
    }
    if (decoded.errorName === 'Panic') return `Panic(0x${(decoded.args?.[0] as bigint).toString(16)})`;
    return decoded.errorName;
  } catch {
    return `Custom error ${data.slice(0, 10).toLowerCase()}`;
  }
}

/**
 * The node answered the trace request with a refusal, not a transport failure: any JSON-RPC error response (method not
 * found, history pruned, tracer not supported, internal error) or an HTTP 4xx other than 408 and 429 (not on the plan,
 * forbidden). Asking again gets the same answer, so it is stored as not read rather than holding the block back.
 */
export function isTraceRefused(err: unknown): boolean {
  let current = err;
  for (let depth = 0; current !== undefined && current !== null && depth < 12; depth += 1) {
    const { code, status } = current as { code?: unknown; status?: unknown };
    if (typeof code === 'number' && Number.isInteger(code) && code < 0) return true;
    if (typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** The reason out of a call-tracer answer: the top call's revert data, else the tracer's own error when it is not a plain revert. */
export function traceReason(trace: unknown): string | null {
  if (!trace || typeof trace !== 'object') return null;
  const { output, error } = trace as { output?: unknown; error?: unknown };
  const fromData = revertReasonFromData(typeof output === 'string' ? output : null);
  if (fromData !== null) return fromData;
  if (typeof error !== 'string' || /^execution reverted$/i.test(error.trim())) return null;
  return storableReason(error);
}
