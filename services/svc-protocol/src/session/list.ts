import {
  protocolSessionsListSchema,
  type ProtocolSessionKey,
  type ProtocolSessionsList,
  type SessionKeyStatus,
} from '@intafaced/contracts/protocol-sessions';
import { getAddress, parseAbi, parseAbiItem, type Address, type PublicClient } from 'viem';

/**
 * `sessions.list` (D-portfolio-wallet-02): every session key a smart account granted, rebuilt from the account's own logs
 * and checked against its on-chain record, all at one block. The scope (targets, selectors, cap, window) is the grant's own
 * log; the status is the record's: revoked by itself, ended by "Revoke all" (the record's epoch is older than the
 * account's), expired by the block's clock, or active. Logs are read from the account's creation block, or from 30 days
 * back if the account is older: no key may live longer than 30 days (SessionKeyLib.MAX_SESSION_DURATION), so every key
 * that can still act is read. They are read in chunks a node accepts. This plane holds no key and signs nothing.
 */
/** Blocks per getLogs call. */
export const SESSION_LOG_BLOCKS = 10_000n;
/** SessionKeyLib.MAX_SESSION_DURATION: no key can still act once granted longer ago than this. */
export const MAX_SESSION_SECONDS = 30 * 86_400;
const LOG_CONCURRENCY = 4;

const granted = parseAbiItem(
  'event SessionGranted(address indexed sessionKey, bytes32 specHash, uint48 validAfter, uint48 validUntil, uint128 spendLimitWei, address[] targets, bytes4[] selectors)',
);
const executed = parseAbiItem(
  'event SessionCallExecuted(address indexed sessionKey, address indexed target, bytes4 selector, uint256 value, uint128 spentWei)',
);
const accountAbi = parseAbi([
  'function sessionEpoch() view returns (uint64)',
  'function getSession(address sessionKey) view returns ((bytes32 specHash, uint48 validAfter, uint48 validUntil, uint128 spentWei, uint64 epoch, bool revoked))',
]);

export type SessionListClient = Pick<PublicClient, 'getBlock' | 'getCode' | 'getLogs' | 'readContract'>;

type Grant = {
  key: Address;
  specHash: `0x${string}`;
  validAfter: number;
  validUntil: number;
  spendLimitWei: bigint;
  targets: readonly Address[];
  selectors: readonly `0x${string}`[];
  block: bigint;
};
type Record = { specHash: `0x${string}`; spentWei: bigint; epoch: bigint; revoked: boolean };

/** Pure: a key's status from its on-chain record, the account's epoch and the block's clock. */
export function sessionStatus(
  grant: Pick<Grant, 'validAfter' | 'validUntil'>,
  record: Record,
  epoch: bigint,
  now: number,
): SessionKeyStatus {
  if (record.revoked || record.epoch !== epoch) return 'revoked';
  if (now >= grant.validUntil) return 'expired';
  if (now < grant.validAfter) return 'not_yet_valid';
  return 'active';
}

/** The first block at or below `head` where `account` has code (binary search); null when it has none at `head`. */
async function creationBlock(client: SessionListClient, account: Address, head: bigint): Promise<bigint | null> {
  const has = async (blockNumber: bigint) => {
    const code = await client.getCode({ address: account, blockNumber });
    return Boolean(code && code !== '0x');
  };
  if (!(await has(head))) return null;
  let lo = 0n;
  let hi = head;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    if (await has(mid)) hi = mid;
    else lo = mid + 1n;
  }
  return lo;
}

/** The first block in [lo, hi] whose timestamp is at least `at` (binary search). */
async function firstBlockAt(client: SessionListClient, at: number, lo: bigint, hi: bigint): Promise<bigint> {
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    if (Number((await client.getBlock({ blockNumber: mid })).timestamp) >= at) hi = mid;
    else lo = mid + 1n;
  }
  return lo;
}

/** One event's logs over [from, to], in chunks of SESSION_LOG_BLOCKS, a few at a time, in block order. */
async function chunkedLogs<E>(read: (fromBlock: bigint, toBlock: bigint) => Promise<E[]>, from: bigint, to: bigint): Promise<E[]> {
  const ranges: [bigint, bigint][] = [];
  for (let start = from; start <= to; start += SESSION_LOG_BLOCKS) {
    const end = start + SESSION_LOG_BLOCKS - 1n;
    ranges.push([start, end < to ? end : to]);
  }
  const out: E[][] = new Array(ranges.length);
  for (let i = 0; i < ranges.length; i += LOG_CONCURRENCY)
    await Promise.all(ranges.slice(i, i + LOG_CONCURRENCY).map(async ([a, b], j) => (out[i + j] = await read(a, b))));
  return out.flat();
}

export async function listSessions(client: SessionListClient, input: { account: string; chainId: number }): Promise<ProtocolSessionsList> {
  const account = getAddress(input.account);
  const block = await client.getBlock({ blockTag: 'latest' });
  const blockNumber = block.number!;
  const base = {
    account,
    chainId: input.chainId,
    blockNumber: blockNumber.toString(),
    blockTime: new Date(Number(block.timestamp) * 1000).toISOString(),
  };
  const created = await creationBlock(client, account, blockNumber);
  if (created === null)
    return protocolSessionsListSchema.parse({ ...base, logsFromBlock: blockNumber.toString(), deployed: false, keys: [] });
  const oldest = Number(block.timestamp) - MAX_SESSION_SECONDS;
  const createdAt = Number((await client.getBlock({ blockNumber: created })).timestamp);
  const fromBlock = createdAt >= oldest ? created : await firstBlockAt(client, oldest, created, blockNumber);

  const [grants, uses, epoch] = await Promise.all([
    chunkedLogs((a, b) => client.getLogs({ address: account, event: granted, fromBlock: a, toBlock: b }), fromBlock, blockNumber),
    chunkedLogs((a, b) => client.getLogs({ address: account, event: executed, fromBlock: a, toBlock: b }), fromBlock, blockNumber),
    client.readContract({ address: account, abi: accountAbi, functionName: 'sessionEpoch', blockNumber }),
  ]);
  // The latest grant of each key is its scope (a re-grant replaces the old one on chain too).
  const latest = new Map<string, Grant>();
  for (const log of grants) {
    const a = log.args;
    if (!a.sessionKey || a.specHash === undefined || a.validUntil === undefined) continue;
    latest.set(a.sessionKey.toLowerCase(), {
      key: getAddress(a.sessionKey),
      specHash: a.specHash,
      validAfter: Number(a.validAfter ?? 0),
      validUntil: Number(a.validUntil),
      spendLimitWei: a.spendLimitWei ?? 0n,
      targets: a.targets ?? [],
      selectors: a.selectors ?? [],
      block: log.blockNumber ?? 0n,
    });
  }
  const lastUse = new Map<string, bigint>();
  for (const log of uses)
    if (log.args.sessionKey && log.blockNumber !== null) lastUse.set(log.args.sessionKey.toLowerCase(), log.blockNumber);
  const usedBlocks = [...new Set(lastUse.values())];
  const stamps = await Promise.all(usedBlocks.map((used) => client.getBlock({ blockNumber: used })));
  const times = new Map(usedBlocks.map((used, i) => [used, new Date(Number(stamps[i]!.timestamp) * 1000).toISOString()]));
  const grantsList = [...latest.values()];
  const records = await Promise.all(
    grantsList.map((grant) =>
      client.readContract({ address: account, abi: accountAbi, functionName: 'getSession', args: [grant.key], blockNumber }),
    ),
  );
  const logsFrom = { logsFromBlock: fromBlock.toString() };

  const now = Number(block.timestamp);
  const keys: ProtocolSessionKey[] = [];
  grantsList.forEach((grant, i) => {
    const record = records[i]!;
    // A log whose commitment is not the record's is not the key's current grant; the record wins and the row is not shown.
    if (record.specHash !== grant.specHash) return;
    const used = lastUse.get(grant.key.toLowerCase());
    keys.push({
      key: grant.key,
      targets: grant.targets.map((target) => getAddress(target)),
      selectors: [...grant.selectors],
      spendLimitWei: grant.spendLimitWei.toString(),
      spentWei: record.spentWei.toString(),
      validAfter: grant.validAfter,
      validUntil: grant.validUntil,
      status: sessionStatus(grant, record, epoch, now),
      grantedBlock: grant.block.toString(),
      lastUsedAt: used === undefined ? null : times.get(used)!,
    });
  });
  keys.sort((a, b) => Number(BigInt(b.grantedBlock) - BigInt(a.grantedBlock)) || a.key.localeCompare(b.key));
  return protocolSessionsListSchema.parse({ ...base, ...logsFrom, deployed: true, keys });
}
