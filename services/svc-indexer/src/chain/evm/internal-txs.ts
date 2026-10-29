import type { Hex, PublicClient } from 'viem';
import { ChainUnavailableError, classifyChainError } from './availability.js';
import type { ChainBlockInternal, ChainInternalCall } from '../source.js';

/**
 * D-explorer-03. The value a block's contracts moved inside its transactions ("internal transactions"), read from the
 * node's own trace of the whole block: `trace_block` where the node has it, else `debug_traceBlockByHash` with the call
 * tracer. Only moves that stood are kept: a call with value, a contract created with value, a self-destruct sending its
 * balance; a reverted call and everything under it moved nothing. A delegate or static call moves no value of its own.
 *
 * A node that will not trace the block (no such method, history gone, tracer timed out, an answer past the size cap) is
 * the node's answer, the same on every retry, so the block is stored as "trace not read" with a code, never held back: a
 * contract that makes its trace slow or huge cannot stall ingest. A rate limit throws, so the block is read again later.
 * Any other failure (a client timeout, a gateway 5xx, a cut-off answer) throws too, but only `TRACE_ATTEMPTS` times for
 * one block: then the block is stored as not traced and ingest moves on.
 */

export const TRACE_UNAVAILABLE = 'indexer.trace_unavailable';
export const TRACE_MALFORMED = 'indexer.trace_malformed';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const QUANTITY = /^0x[0-9a-fA-F]{1,64}$/;

/** Busy or rate-limited: asking again later gets an answer, so the block waits. */
const TRANSIENT = /rate limit|too many requests|limit exceeded|request limit|capacity|try again/i;

/** A load-balanced node that lags the indexer says these for a block it has not seen yet: a busy node, not a refusal. */
const NOT_SEEN_YET = /header not found|unknown block|block not found/i;

/** Reads of one block's trace that fail without a node's answer, before the block is stored as not traced. */
export const TRACE_ATTEMPTS = 3;

/** Blocks still being counted at once; past it the counts start again, which only delays the bound. */
const FAILURES_TRACKED = 1024;

function causes(err: unknown): unknown[] {
  const out: unknown[] = [];
  let current = err;
  for (let depth = 0; current !== undefined && current !== null && depth < 12; depth += 1) {
    out.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return out;
}

/** A rate limit or a busy node: the only failure a block waits out without a bound. */
export function isRateLimited(err: unknown): boolean {
  return causes(err).some((link) => {
    const { code, status, message, details } = link as { code?: unknown; status?: unknown; message?: unknown; details?: unknown };
    if (code === -32005 || status === 429) return true;
    return [message, details].some((text) => typeof text === 'string' && TRANSIENT.test(text));
  });
}

/** viem refused an answer larger than the client's body cap: the node's trace of this block is too big to read. */
function isTooLarge(err: unknown): boolean {
  return causes(err).some((link) => (link as { name?: unknown }).name === 'ResponseBodyTooLargeError');
}

/**
 * The node answered the trace with an error response (a JSON-RPC error, or an HTTP 4xx other than 408 and 429) that is
 * not a rate limit. That answer is the node's for this block, so the block is stored as not traced.
 */
export function isTraceDeclined(err: unknown): boolean {
  if (isRateLimited(err)) return false;
  if (isTooLarge(err)) return true;
  let declined = false;
  for (const link of causes(err)) {
    const { code, status, message, details } = link as { code?: unknown; status?: unknown; message?: unknown; details?: unknown };
    if (status === 408) return false;
    if ([message, details].some((text) => typeof text === 'string' && NOT_SEEN_YET.test(text))) return false;
    if (typeof code === 'number' && Number.isInteger(code) && code < 0) declined = true;
    if (typeof status === 'number' && status >= 400 && status < 500) declined = true;
  }
  return declined;
}

class Malformed extends Error {}
/** The node traced the block but not every transaction in it (a tracer timeout on one): the block is not read. */
class Declined extends Error {}

function address(value: unknown): string {
  if (typeof value !== 'string' || !ADDRESS.test(value)) throw new Malformed('address');
  return value.toLowerCase();
}

function wei(value: unknown): bigint {
  if (value === undefined || value === null) return 0n;
  if (typeof value !== 'string' || !QUANTITY.test(value)) throw new Malformed('value');
  return BigInt(value);
}

function txHash(value: unknown, known: ReadonlySet<string>): string {
  if (typeof value !== 'string' || !HASH.test(value) || !known.has(value.toLowerCase())) throw new Malformed('tx hash');
  return value.toLowerCase();
}

/** Parity-style `trace_block`: a flat list, each entry with its tx hash and its place (`traceAddress`) in the tree. */
export function internalFromParity(traces: unknown, blockHash: string, txHashes: readonly string[]): ChainInternalCall[] {
  if (!Array.isArray(traces)) throw new Malformed('trace list');
  const known = new Set(txHashes);
  const failed = new Set<string>();
  const calls: ChainInternalCall[] = [];
  const entries = traces.filter((entry) => (entry as { type?: unknown })?.type !== 'reward');
  for (const entry of entries) {
    const { blockHash: of, transactionHash, traceAddress, error } = entry as Record<string, unknown>;
    if (typeof of !== 'string' || of.toLowerCase() !== blockHash) {
      throw new ChainUnavailableError('indexer.malformed_block', `trace_block answered for block ${String(of)}, not ${blockHash}`);
    }
    const hash = txHash(transactionHash, known);
    if (!Array.isArray(traceAddress) || !traceAddress.every((n) => Number.isSafeInteger(n) && n >= 0)) throw new Malformed('trace address');
    if (error !== undefined && error !== null) failed.add(`${hash}:${traceAddress.join('.')}`);
  }
  for (const entry of entries) {
    const { transactionHash, traceAddress, type, action, error } = entry as Record<string, unknown>;
    const path = traceAddress as number[];
    if (path.length === 0 || (error !== undefined && error !== null)) continue;
    const hash = (transactionHash as string).toLowerCase();
    // Under a reverted call nothing stood, however deep.
    if (failed.size > 0 && underFailed(failed, hash, path)) continue;
    const act = (action ?? {}) as Record<string, unknown>;
    const key = path.join('.');
    if (type === 'call') {
      if (act.callType !== 'call') continue;
      const value = wei(act.value);
      if (value > 0n) calls.push({ txHash: hash, path: key, kind: 'call', from: address(act.from), to: address(act.to), valueWei: value });
    } else if (type === 'create') {
      const value = wei(act.value);
      const created = ((entry as { result?: { address?: unknown } }).result ?? {}).address;
      if (value > 0n)
        calls.push({ txHash: hash, path: key, kind: 'create', from: address(act.from), to: address(created), valueWei: value });
    } else if (type === 'suicide' || type === 'selfdestruct') {
      const value = wei(act.balance);
      if (value > 0n) {
        calls.push({
          txHash: hash,
          path: key,
          kind: 'selfdestruct',
          from: address(act.address),
          to: address(act.refundAddress),
          valueWei: value,
        });
      }
    } else {
      throw new Malformed('trace type');
    }
  }
  return calls;
}

/** Whether a call above `path` in its transaction reverted. The prefix is built once, not once per depth. */
function underFailed(failed: ReadonlySet<string>, hash: string, path: readonly number[]): boolean {
  let prefix = '';
  for (let depth = 0; depth < path.length; depth += 1) {
    if (failed.has(`${hash}:${prefix}`)) return true;
    prefix = depth === 0 ? String(path[0]) : `${prefix}.${path[depth]}`;
  }
  return false;
}

interface CallFrame {
  type?: unknown;
  from?: unknown;
  to?: unknown;
  value?: unknown;
  error?: unknown;
  calls?: unknown;
}

/** Geth's call tracer over the whole block: one tree per transaction, in block order. */
export function internalFromCallTracer(traces: unknown, txHashes: readonly string[]): ChainInternalCall[] {
  if (!Array.isArray(traces) || traces.length !== txHashes.length) throw new Malformed('trace list');
  const known = new Set(txHashes);
  const calls: ChainInternalCall[] = [];
  traces.forEach((entry, index) => {
    const { txHash: named, result, error } = (entry ?? {}) as { txHash?: unknown; result?: unknown; error?: unknown };
    const hash = named === undefined ? (txHashes[index] as string) : txHash(named, known);
    if (hash !== txHashes[index]) throw new Malformed('trace order');
    if (error !== undefined && error !== null) throw new Declined('trace error');
    if (!result || typeof result !== 'object') throw new Malformed('trace result');
    // Walked with a stack, not recursion: the EVM allows 1024 nested calls.
    const stack: Array<{ frame: CallFrame; path: number[] }> = [{ frame: result as CallFrame, path: [] }];
    while (stack.length > 0) {
      const { frame, path } = stack.pop() as { frame: CallFrame; path: number[] };
      if (frame.error !== undefined && frame.error !== null) continue;
      if (path.length > 0) {
        const type = typeof frame.type === 'string' ? frame.type.toUpperCase() : '';
        const value = type === 'CALL' || type === 'CREATE' || type === 'CREATE2' || type === 'SELFDESTRUCT' ? wei(frame.value) : 0n;
        if (value > 0n) {
          const kind = type === 'CALL' ? 'call' : type === 'SELFDESTRUCT' ? 'selfdestruct' : 'create';
          calls.push({ txHash: hash, path: path.join('.'), kind, from: address(frame.from), to: address(frame.to), valueWei: value });
        }
      }
      if (frame.calls === undefined || frame.calls === null) continue;
      if (!Array.isArray(frame.calls)) throw new Malformed('calls');
      frame.calls.forEach((child, i) => stack.push({ frame: (child ?? {}) as CallFrame, path: [...path, i] }));
    }
  });
  const order = new Map(txHashes.map((hash, i) => [hash, i]));
  return calls.sort((a, b) =>
    a.txHash === b.txHash ? comparePath(a.path, b.path) : (order.get(a.txHash) as number) - (order.get(b.txHash) as number),
  );
}

function comparePath(a: string, b: string): number {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.min(x.length, y.length); i += 1) if (x[i] !== y[i]) return (x[i] as number) - (y[i] as number);
  return x.length - y.length;
}

/**
 * The node's own limit on tracing one block, kept under the trace client's timeout so a slow trace comes back as the
 * node's error answer (stored as not traced) rather than a dropped request.
 */
export const TRACER_TIMEOUT = '20s';

/** A null trace is a node that has not seen the block yet: the block is read again, within `TRACE_ATTEMPTS`. */
function seen(answer: unknown, block: { hash: string }, rpcUrl: string): unknown {
  if (answer === null || answer === undefined) {
    throw new ChainUnavailableError('indexer.chain_unreachable', `${rpcUrl} answered no trace for block ${block.hash}.`);
  }
  return answer;
}

async function ask(
  client: PublicClient,
  method: string,
  params: unknown[],
  what: string,
  rpcUrl: string,
): Promise<{ answer: unknown } | null> {
  try {
    return { answer: await client.request({ method, params } as never) };
  } catch (err) {
    if (isTraceDeclined(err)) return null;
    throw classifyChainError(err, what, rpcUrl);
  }
}

/**
 * The block's internal value moves, or why the node did not trace it. `txHashes` are lowercase, in block order.
 * `failures` counts, per block hash, the reads that failed without a node's answer; the caller keeps it across passes.
 */
export async function readBlockInternal(
  client: PublicClient,
  block: { hash: string; height: number },
  txHashes: readonly string[],
  rpcUrl: string,
  failures: Map<string, number> = new Map(),
): Promise<ChainBlockInternal> {
  if (txHashes.length === 0) return { read: true, calls: [] };
  try {
    const answer = await traceBlock(client, block, txHashes, rpcUrl);
    failures.delete(block.hash);
    return answer;
  } catch (err) {
    if (isRateLimited(err)) throw err;
    const failed = (failures.get(block.hash) ?? 0) + 1;
    if (failed < TRACE_ATTEMPTS) {
      if (!failures.has(block.hash) && failures.size >= FAILURES_TRACKED) failures.clear();
      failures.set(block.hash, failed);
      throw err;
    }
    failures.delete(block.hash);
    return { read: false, reason: TRACE_UNAVAILABLE };
  }
}

async function traceBlock(
  client: PublicClient,
  block: { hash: string; height: number },
  txHashes: readonly string[],
  rpcUrl: string,
): Promise<ChainBlockInternal> {
  try {
    const parity = await ask(client, 'trace_block', [`0x${block.height.toString(16)}`], `traceBlock(${block.hash})`, rpcUrl);
    if (parity) return { read: true, calls: internalFromParity(seen(parity.answer, block, rpcUrl), block.hash, txHashes) };
    const geth = await ask(
      client,
      'debug_traceBlockByHash',
      [block.hash as Hex, { tracer: 'callTracer', timeout: TRACER_TIMEOUT }],
      `debugTraceBlock(${block.hash})`,
      rpcUrl,
    );
    if (geth) return { read: true, calls: internalFromCallTracer(seen(geth.answer, block, rpcUrl), txHashes) };
    return { read: false, reason: TRACE_UNAVAILABLE };
  } catch (err) {
    if (err instanceof Malformed) return { read: false, reason: TRACE_MALFORMED };
    if (err instanceof Declined) return { read: false, reason: TRACE_UNAVAILABLE };
    throw err;
  }
}
