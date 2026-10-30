import type { Hex, PublicClient } from 'viem';
import { ChainUnavailableError, classifyChainError } from './availability.js';
import { isCallFailedInEvm, TOKEN_CALL_GAS } from './token-meta.js';

/**
 * D-explorer-03. What an address holds, read from the node at one block: its native balance, whether code lives there,
 * and each token's own `balanceOf`. These are live reads, pinned to a height the indexer has stored, so the summary,
 * the holdings and the transactions list all speak of the same block.
 */

/** `balanceOf(address)`. */
const BALANCE_OF = '0x70a08231';

/** Token balances read at once, so one page never fires an unbounded burst of calls at the node. */
const BALANCE_READ_CONCURRENCY = 8;

/** The node no longer holds the state at that block (a pruned, non-archive node). Asking again gets the same answer. */
export const STATE_UNAVAILABLE = 'indexer.state_unavailable';

/**
 * "header not found" and "unknown block" are left out on purpose: a load-balanced node that lags the indexer says them
 * for a block it has not seen yet, which is a busy node, not lost state.
 */
const STATE_GONE = /missing trie node|historical state|state (?:is )?not available|pruned/i;

export class StateUnavailableError extends Error {
  readonly code = STATE_UNAVAILABLE;
  constructor(readonly height: number) {
    super(`The node no longer holds the state at block ${height}.`);
    this.name = 'StateUnavailableError';
  }
}

function stateGone(err: unknown): boolean {
  let current = err;
  for (let depth = 0; current !== undefined && current !== null && depth < 12; depth += 1) {
    const { code, message, details } = current as { code?: unknown; message?: unknown; details?: unknown };
    if (typeof code === 'number' && [message, details].some((text) => typeof text === 'string' && STATE_GONE.test(text))) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function failure(err: unknown, what: string, height: number, rpcUrl: string): Error {
  if (stateGone(err)) return new StateUnavailableError(height);
  return classifyChainError(err, what, rpcUrl);
}

const tag = (height: number) => `0x${height.toString(16)}` as Hex;

function quantity(answer: unknown, what: string, rpcUrl: string): bigint {
  if (typeof answer !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(answer)) {
    throw new ChainUnavailableError('indexer.malformed_block', `${what} at ${rpcUrl} answered ${String(answer)}, not a quantity.`);
  }
  return BigInt(answer);
}

/** The address's native balance in wei and whether contract code lives there, at `height`. */
export async function readAccount(
  client: PublicClient,
  address: string,
  height: number,
  rpcUrl: string,
): Promise<{ balanceWei: bigint; isContract: boolean }> {
  try {
    const [balance, code] = await Promise.all([
      client.request({ method: 'eth_getBalance', params: [address as Hex, tag(height)] }),
      client.request({ method: 'eth_getCode', params: [address as Hex, tag(height)] }),
    ]);
    if (typeof code !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(code)) {
      throw new ChainUnavailableError('indexer.malformed_block', `getCode(${address}) at ${rpcUrl} answered something that is not code.`);
    }
    return { balanceWei: quantity(balance, `getBalance(${address})`, rpcUrl), isContract: code.length > 2 };
  } catch (err) {
    if (err instanceof ChainUnavailableError) throw err;
    throw failure(err, `account(${address})`, height, rpcUrl);
  }
}

/** The address's native balance in wei at `height`. */
export async function readBalance(client: PublicClient, address: string, height: number, rpcUrl: string): Promise<bigint> {
  try {
    return quantity(
      await client.request({ method: 'eth_getBalance', params: [address as Hex, tag(height)] }),
      `getBalance(${address})`,
      rpcUrl,
    );
  } catch (err) {
    if (err instanceof ChainUnavailableError) throw err;
    throw failure(err, `balance(${address})`, height, rpcUrl);
  }
}

/**
 * Each token's `balanceOf(address)` at `height`, in the order given. Null where the contract did not answer as a token
 * (a revert, no such function, out of gas, an answer that is not one word): the contract's answer, never a guessed zero.
 */
export async function readTokenBalances(
  client: PublicClient,
  tokens: readonly string[],
  address: string,
  height: number,
  rpcUrl: string,
): Promise<Array<bigint | null>> {
  const data = `${BALANCE_OF}${address.slice(2).toLowerCase().padStart(64, '0')}` as Hex;
  const out: Array<bigint | null> = new Array(tokens.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < tokens.length; i = next++) {
      const token = tokens[i] as string;
      try {
        const answer = await client.request({
          method: 'eth_call',
          params: [{ to: token as Hex, data, gas: `0x${TOKEN_CALL_GAS.toString(16)}` as Hex }, tag(height)],
        });
        out[i] = typeof answer === 'string' && /^0x[0-9a-fA-F]{64}$/.test(answer) ? BigInt(answer) : null;
      } catch (err) {
        if (isCallFailedInEvm(err)) out[i] = null;
        else throw failure(err, `balanceOf(${token})`, height, rpcUrl);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(BALANCE_READ_CONCURRENCY, tokens.length) }, worker));
  return out;
}
