import { decodeAbiParameters, hexToString, type Hex, type PublicClient } from 'viem';
import { classifyChainError } from './availability.js';
import { storableReason } from './revert-reason.js';
import type { ChainToken } from '../source.js';

/**
 * D-explorer-03. What a token contract says about itself: `symbol()`, `name()`, `decimals()`, read once per contract at
 * the block where the indexer first sees it emit an ERC-20 Transfer.
 *
 * The node's answer decides: a call that reverts or names no such function is the contract not answering, stored as
 * null, never a guessed symbol. A failure in transit refuses the block, so it is read again.
 */

const SELECTOR = { symbol: '0x95d89b41', name: '0x06fdde03', decimals: '0x313ce567' } as const;

/** Longest symbol and name kept. The contract chooses them, so they are cleaned and capped like a revert reason. */
const SYMBOL_MAX_CHARS = 32;
const NAME_MAX_CHARS = 64;

/** Cached answers kept per process before the cache starts again; a contract is only re-read, never lost. */
const CACHE_MAX = 10_000;

/** A JSON-RPC error answer (a revert is code 3 or a negative code): the contract did not answer the call. */
function isCallRefused(err: unknown): boolean {
  let current = err;
  for (let depth = 0; current !== undefined && current !== null && depth < 12; depth += 1) {
    const { code } = current as { code?: unknown };
    if (typeof code === 'number' && Number.isInteger(code) && (code < 0 || code === 3)) return true;
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

  /** Every one of `addresses`, read at `height` unless already read. Order follows `addresses`. */
  async read(addresses: readonly string[], height: number): Promise<ChainToken[]> {
    const out: ChainToken[] = [];
    for (const raw of addresses) {
      const address = raw.toLowerCase();
      let token = this.#known.get(address);
      if (!token) {
        const [symbol, name, decimals] = [
          await this.#call(address, SELECTOR.symbol, height),
          await this.#call(address, SELECTOR.name, height),
          await this.#call(address, SELECTOR.decimals, height),
        ];
        token = {
          address,
          symbol: symbol === null ? null : decodeTokenText(symbol, SYMBOL_MAX_CHARS),
          name: name === null ? null : decodeTokenText(name, NAME_MAX_CHARS),
          decimals: decimals === null ? null : decodeTokenDecimals(decimals),
        };
        if (this.#known.size >= CACHE_MAX) this.#known.clear();
        this.#known.set(address, token);
      }
      out.push(token);
    }
    return out;
  }

  async #call(to: string, data: string, height: number): Promise<string | null> {
    try {
      const answer = await this.client.request({
        method: 'eth_call',
        params: [{ to: to as Hex, data: data as Hex }, `0x${height.toString(16)}` as Hex],
      });
      return typeof answer === 'string' ? answer : null;
    } catch (err) {
      if (isCallRefused(err)) return null;
      throw classifyChainError(err, `tokenMeta(${to})`, this.rpcUrl);
    }
  }
}
