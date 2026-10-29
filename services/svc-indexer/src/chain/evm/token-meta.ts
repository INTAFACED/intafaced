import { decodeAbiParameters, hexToString, type Hex, type PublicClient } from 'viem';
import { classifyChainError } from './availability.js';
import { storableReason } from './revert-reason.js';
import type { ChainToken } from '../source.js';

/**
 * D-explorer-03. What a token contract says about itself: `symbol()`, `name()`, `decimals()`, read once per contract at
 * the block where the indexer first sees it emit an ERC-20 Transfer.
 *
 * The node's answer decides: a call that fails inside the EVM (a revert, no such function, an invalid opcode, out of
 * gas) is the contract not answering, stored as null, never a guessed symbol. Each call carries its own gas cap, so a
 * contract cannot make it slow. A node that is busy, limited, missing the state or not reachable refuses the block, so
 * it is read again.
 */

const SELECTOR = { symbol: '0x95d89b41', name: '0x06fdde03', decimals: '0x313ce567' } as const;

/** Longest symbol and name kept, in characters (code points). The contract chooses them, so they are cleaned and capped. */
export const SYMBOL_MAX_CHARS = 32;
const NAME_MAX_CHARS = 64;

/** Cached answers kept per process before the cache starts again; a contract is only re-read, never lost. */
const CACHE_MAX = 10_000;

/** Gas each call may burn. A view returning a short string needs a few thousand; a contract that loops runs out fast. */
export const TOKEN_CALL_GAS = 200_000n;

/** New contracts read for one block. Past this, a block that creates thousands of emitters is not read on ingest. */
export const TOKEN_READS_PER_BLOCK = 64;

/** Contracts read at once, so one block never fires an unbounded burst of calls at the node. */
const TOKEN_READ_CONCURRENCY = 8;

/** The EVM ran the call and it failed: the contract's own behaviour, the same on every read at this height. */
const EXECUTION_FAILED =
  /execution reverted|\brevert|invalid opcode|out of gas|gas required exceeds|stack (?:underflow|overflow)|invalid jump|write protection|EVM error|opcode|static call|precompile|code size|insufficient funds for gas/i;

/**
 * The call failed inside the EVM: the contract has no such function, refused it, hit an invalid opcode or ran out of
 * gas, which is its answer. Only a JSON-RPC error answer (code 3, or a numeric code whose words name an execution
 * failure) counts. A busy, limited or lagging node is not the contract's answer, so it throws and the block is read
 * again rather than storing a lasting null.
 */
export function isCallFailedInEvm(err: unknown): boolean {
  let current = err;
  for (let depth = 0; current !== undefined && current !== null && depth < 12; depth += 1) {
    const { code, message, details } = current as { code?: unknown; message?: unknown; details?: unknown };
    if (code === 3) return true;
    if (typeof code === 'number' && [message, details].some((text) => typeof text === 'string' && EXECUTION_FAILED.test(text))) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function cleaned(text: string, max: number): string | null {
  const clean = storableReason(text.replace(/\u0000+$/u, ''));
  if (clean === null) return null;
  const chars = Array.from(clean);
  return chars.length <= max ? clean : null;
}

/** An ABI `string`, or the older `bytes32` some tokens return. Anything else is no answer. */
export function decodeTokenText(data: string, max: number): string | null {
  if (!/^0x([0-9a-fA-F]{2})*$/.test(data) || data.length <= 2) return null;
  try {
    const [text] = decodeAbiParameters([{ type: 'string' }], data as Hex);
    return cleaned(text, max);
  } catch {
    if (data.length !== 66) return null;
    try {
      return cleaned(hexToString(data as Hex), max);
    } catch {
      return null;
    }
  }
}

/** `uint8` decimals. A value over 255 is not a `uint8` answer. */
export function decodeTokenDecimals(data: string): number | null {
  if (!/^0x[0-9a-fA-F]{64}$/.test(data)) return null;
  const value = BigInt(data);
  return value <= 255n ? Number(value) : null;
}

export class TokenMetaReader {
  readonly #known = new Map<string, ChainToken>();

  constructor(
    private readonly client: PublicClient,
    private readonly rpcUrl: string,
  ) {}

  /** Every one of `addresses`, read at `height` unless already read, a few at a time. Order follows `addresses`. */
  async read(addresses: readonly string[], height: number): Promise<ChainToken[]> {
    const out: ChainToken[] = new Array(addresses.length);
    let next = 0;
    const worker = async () => {
      for (let i = next++; i < addresses.length; i = next++) out[i] = await this.#one((addresses[i] as string).toLowerCase(), height);
    };
    await Promise.all(Array.from({ length: Math.min(TOKEN_READ_CONCURRENCY, addresses.length) }, worker));
    return out;
  }

  async #one(address: string, height: number): Promise<ChainToken> {
    const known = this.#known.get(address);
    if (known) return known;
    const [symbol, name, decimals] = await Promise.all([
      this.#call(address, SELECTOR.symbol, height),
      this.#call(address, SELECTOR.name, height),
      this.#call(address, SELECTOR.decimals, height),
    ]);
    const token = {
      address,
      symbol: symbol === null ? null : decodeTokenText(symbol, SYMBOL_MAX_CHARS),
      name: name === null ? null : decodeTokenText(name, NAME_MAX_CHARS),
      decimals: decimals === null ? null : decodeTokenDecimals(decimals),
    };
    if (this.#known.size >= CACHE_MAX) this.#known.clear();
    this.#known.set(address, token);
    return token;
  }

  async #call(to: string, data: string, height: number): Promise<string | null> {
    try {
      const answer = await this.client.request({
        method: 'eth_call',
        params: [{ to: to as Hex, data: data as Hex, gas: `0x${TOKEN_CALL_GAS.toString(16)}` as Hex }, `0x${height.toString(16)}` as Hex],
      });
      return typeof answer === 'string' ? answer : null;
    } catch (err) {
      if (isCallFailedInEvm(err)) return null;
      throw classifyChainError(err, `tokenMeta(${to})`, this.rpcUrl);
    }
  }
}
