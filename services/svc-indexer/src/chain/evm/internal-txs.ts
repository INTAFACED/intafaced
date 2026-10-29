import type { Hex, PublicClient } from 'viem';
import { ChainUnavailableError, classifyChainError } from './availability.js';
import type { ChainBlockInternal, ChainInternalCall } from '../source.js';

/**
 * D-explorer-03. The value a block's contracts moved inside its transactions ("internal transactions"), read from the
 * node's own trace of the whole block: `trace_block` where the node has it, else `debug_traceBlockByHash` with the call
 * tracer. Only moves that stood are kept: a call with value, a contract created with value, a self-destruct sending its
 * balance; a reverted call and everything under it moved nothing. A delegate or static call moves no value of its own.
 *
 * A node that will not trace the block (no such method, history gone, tracer timed out) is the node's answer, the same on
 * every retry, so the block is stored as "trace not read" with a code, never held back: a contract that makes its trace
 * slow cannot stall ingest. Only a transport failure or a rate limit throws, so the block is read again.
 */

export const TRACE_UNAVAILABLE = 'indexer.trace_unavailable';
export const TRACE_MALFORMED = 'indexer.trace_malformed';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const QUANTITY = /^0x[0-9a-fA-F]{1,64}$/;

/** Busy or rate-limited: asking again later gets an answer, so the block waits. */
const TRANSIENT = /rate limit|too many requests|limit exceeded|request limit|capacity|try again/i;

/**
 * The node answered the trace with an error response (a JSON-RPC error, or an HTTP 4xx other than 408 and 429) that is
 * not a rate limit. That answer is the node's for this block, so the block is stored as not traced.
 */
export function isTraceDeclined(err: unknown): boolean {
  let declined = false;
  let current = err;
  for (let depth = 0; current !== undefined && current !== null && depth < 12; depth += 1) {
    const { code, status, message, details } = current as { code?: unknown; status?: unknown; message?: unknown; details?: unknown };
    if (code === -32005 || status === 429 || status === 408) return false;
    if ([message, details].some((text) => typeof text === 'string' && TRANSIENT.test(text))) return false;
    if (typeof code === 'number' && Number.isInteger(code) && code < 0) declined = true;
    if (typeof status === 'number' && status >= 400 && status < 500) declined = true;
    current = (current as { cause?: unknown }).cause;
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
    if (path.some((_, depth) => failed.has(`${hash}:${path.slice(0, depth).join('.')}`))) continue;
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
  return calls.sort((a, b) =>
    a.txHash === b.txHash ? comparePath(a.path, b.path) : txHashes.indexOf(a.txHash) - txHashes.indexOf(b.txHash),
  );
}

function comparePath(a: string, b: string): number {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.min(x.length, y.length); i += 1) if (x[i] !== y[i]) return (x[i] as number) - (y[i] as number);
  return x.length - y.length;
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

/** The block's internal value moves, or why the node did not trace it. `txHashes` are lowercase, in block order. */
export async function readBlockInternal(
  client: PublicClient,
  block: { hash: string; height: number },
  txHashes: readonly string[],
  rpcUrl: string,
): Promise<ChainBlockInternal> {
  if (txHashes.length === 0) return { read: true, calls: [] };
  try {
    const parity = await ask(client, 'trace_block', [`0x${block.height.toString(16)}`], `traceBlock(${block.hash})`, rpcUrl);
    if (parity) return { read: true, calls: internalFromParity(parity.answer, block.hash, txHashes) };
    const geth = await ask(
      client,
      'debug_traceBlockByHash',
      [block.hash as Hex, { tracer: 'callTracer' }],
      `debugTraceBlock(${block.hash})`,
      rpcUrl,
    );
    if (geth) return { read: true, calls: internalFromCallTracer(geth.answer, txHashes) };
    return { read: false, reason: TRACE_UNAVAILABLE };
  } catch (err) {
    if (err instanceof Malformed) return { read: false, reason: TRACE_MALFORMED };
    if (err instanceof Declined) return { read: false, reason: TRACE_UNAVAILABLE };
    throw err;
  }
}
