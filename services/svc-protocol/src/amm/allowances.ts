import type { Address } from 'viem';
import type { ProtocolAllowanceRow, ProtocolAllowances, ProtocolSwapPairs } from '@intafaced/contracts';
import { chainDown } from '../chain/availability.js';
import { MAX_UINT256 } from './build.js';

/** The reads `listAllowances` needs; `ProtocolChain` provides them, tests stand them in. */
export interface AllowancesChain {
  /** Every (token, spender) the owner's `Approval(owner, spender, value)` logs name for `tokens`, in `[fromBlock, toBlock]`. */
  approvalSpenders(
    tokens: readonly Address[],
    owner: Address,
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<Array<{ token: Address; spender: Address }>>;
  /** `token.allowance(owner, spender)` at `blockNumber`; null when the token reverts instead of answering. */
  allowanceAt(token: Address, owner: Address, spender: Address, blockNumber: bigint): Promise<bigint | null>;
}

/**
 * How many blocks back the owner's Approval logs are read. A technical read bound for one request, not a product limit:
 * many nodes refuse a wider `eth_getLogs` range. A pool the factory lists is always checked whatever its age; only an
 * approval to some other spender older than this is not found, and the answer names the first block read.
 */
export const APPROVAL_LOG_BLOCKS = 10_000n;

/** The most (token, spender) candidates one read checks. A read bound, not a product limit: the answer says when it was hit. */
export const ALLOWANCE_READ_LIMIT = 500;

/** How many `allowance()` reads run at once: one public request must not flood the service's node. */
export const ALLOWANCE_READ_CONCURRENCY = 16;

/** `Promise.allSettled` over `items`, at most `limit` at a time, results in input order. */
async function settledInBatches<T, R>(items: readonly T[], limit: number, read: (item: T) => Promise<R>) {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = { status: 'fulfilled', value: await read(items[index]!) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * The owner's live allowances for the tokens the factory's pools trade (D-swap-09), all read at the pairs' block.
 * Candidates: every listed pool for both its tokens, then every spender the owner's Approval logs name. Only a non-zero
 * `allowance()` becomes a row; an approval since set back to zero is gone. A token that reverts or whose read fails is
 * counted in `unread`, never shown as zero; only when every read fails with the chain itself down is the whole answer
 * refused. A node that refuses the Approval log range leaves the pool candidates, and the answer says the logs went
 * unread.
 */
export async function listAllowances(chain: AllowancesChain, pairs: ProtocolSwapPairs, owner: Address): Promise<ProtocolAllowances> {
  const block = BigInt(pairs.blockNumber);
  const fromBlock = block >= APPROVAL_LOG_BLOCKS ? block - APPROVAL_LOG_BLOCKS + 1n : 0n;
  const listed = new Map(pairs.tokens.map((token) => [token.address.toLowerCase(), token]));
  const poolOf = new Map(pairs.pools.map((pool) => [pool.pool.toLowerCase(), pool]));
  const candidates = new Map<string, { token: Address; spender: Address }>();
  const add = (token: Address, spender: Address) => {
    if (!listed.has(token.toLowerCase())) return;
    candidates.set(`${token.toLowerCase()}:${spender.toLowerCase()}`, { token, spender });
  };
  for (const pool of pairs.pools) {
    add(pool.token0 as Address, pool.pool as Address);
    add(pool.token1 as Address, pool.pool as Address);
  }
  const tokens = pairs.tokens.map((token) => token.address as Address);
  let approvalLogsUnread = false;
  let logsFailure: unknown = null;
  if (tokens.length > 0) {
    try {
      for (const found of await chain.approvalSpenders(tokens, owner, fromBlock, block)) add(found.token, found.spender);
    } catch (reason) {
      approvalLogsUnread = true;
      logsFailure = reason;
    }
  }

  const all = [...candidates.values()];
  const checked = all.slice(0, ALLOWANCE_READ_LIMIT);
  const reads = await settledInBatches(checked, ALLOWANCE_READ_CONCURRENCY, (entry) =>
    chain.allowanceAt(entry.token, owner, entry.spender, block),
  );
  // One token's failed read is that token's; the chain is down only when nothing at all could be read.
  const failures = reads.filter((entry): entry is PromiseRejectedResult => entry.status === 'rejected');
  if (failures.length === reads.length && failures.length > 0 && chainDown(failures[0]!.reason)) throw failures[0]!.reason;
  if (reads.length === 0 && approvalLogsUnread && chainDown(logsFailure)) throw logsFailure;

  let unread = 0;
  const rows: ProtocolAllowanceRow[] = [];
  reads.forEach((entry, index) => {
    const value = entry.status === 'fulfilled' ? entry.value : null;
    if (value === null) {
      unread += 1;
      return;
    }
    if (value === 0n) return;
    const { token, spender } = checked[index]!;
    const pool = poolOf.get(spender.toLowerCase());
    rows.push({
      token: listed.get(token.toLowerCase())!.address,
      spender,
      allowance: value.toString(),
      unlimited: value === MAX_UINT256,
      pool: pool ? { token0: pool.token0, token1: pool.token1 } : null,
    });
  });
  const name = (address: string) => listed.get(address.toLowerCase())?.name ?? '';
  rows.sort((a, b) => name(a.token).localeCompare(name(b.token)) || a.spender.localeCompare(b.spender));
  return {
    owner,
    blockNumber: block.toString(),
    logsFromBlock: fromBlock.toString(),
    approvalLogsUnread,
    tokens: pairs.tokens,
    rows,
    unread,
    truncated: all.length > checked.length,
  };
}
