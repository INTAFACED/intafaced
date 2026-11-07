import { protocolSessionsListSchema, type ProtocolSessionKey, type ProtocolSessionsList, type SessionKeyStatus } from '@intafaced/contracts/protocol-sessions';
import { getAddress, parseAbi, parseAbiItem, type Address, type PublicClient } from 'viem';

/**
 * `sessions.list` (D-portfolio-wallet-02): every session key a smart account granted, rebuilt from the account's own logs
 * and checked against its on-chain record, all at one block. The scope (targets, selectors, cap, window) is the grant's own
 * log; the status is the record's: revoked by itself, ended by "Revoke all" (the record's epoch is older than the
 * account's), expired by the block's clock, or active. Logs are read over a bounded window, and the answer says where it
 * starts, so a key granted before it is named as unread rather than absent. This plane holds no key and signs nothing.
 */
export const SESSION_LOG_BLOCKS = 10_000n;

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
export function sessionStatus(grant: Pick<Grant, 'validAfter' | 'validUntil'>, record: Record, epoch: bigint, now: number): SessionKeyStatus {
  if (record.revoked || record.epoch !== epoch) return 'revoked';
  if (now >= grant.validUntil) return 'expired';
  if (now < grant.validAfter) return 'not_yet_valid';
  return 'active';
}

export async function listSessions(client: SessionListClient, input: { account: string; chainId: number }): Promise<ProtocolSessionsList> {
  const account = getAddress(input.account);
  const block = await client.getBlock({ blockTag: 'latest' });
  const blockNumber = block.number!;
  const fromBlock = blockNumber >= SESSION_LOG_BLOCKS ? blockNumber - SESSION_LOG_BLOCKS + 1n : 0n;
  const base = {
    account,
    chainId: input.chainId,
    blockNumber: blockNumber.toString(),
    blockTime: new Date(Number(block.timestamp) * 1000).toISOString(),
    logsFromBlock: fromBlock.toString(),
  };
  const code = await client.getCode({ address: account, blockNumber });
  if (!code || code === '0x') return protocolSessionsListSchema.parse({ ...base, deployed: false, keys: [] });

  const [grants, uses, epoch] = await Promise.all([
    client.getLogs({ address: account, event: granted, fromBlock, toBlock: blockNumber }),
    client.getLogs({ address: account, event: executed, fromBlock, toBlock: blockNumber }),
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
  for (const log of uses) if (log.args.sessionKey && log.blockNumber !== null) lastUse.set(log.args.sessionKey.toLowerCase(), log.blockNumber);
  const times = new Map<bigint, string>();
  for (const used of new Set(lastUse.values()))
    times.set(used, new Date(Number((await client.getBlock({ blockNumber: used })).timestamp) * 1000).toISOString());

  const now = Number(block.timestamp);
  const keys: ProtocolSessionKey[] = [];
  for (const grant of latest.values()) {
    const record = await client.readContract({ address: account, abi: accountAbi, functionName: 'getSession', args: [grant.key], blockNumber });
    // A log whose commitment is not the record's is not the key's current grant; the record wins and the row is not shown.
    if (record.specHash !== grant.specHash) continue;
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
  }
  keys.sort((a, b) => Number(BigInt(b.grantedBlock) - BigInt(a.grantedBlock)) || a.key.localeCompare(b.key));
  return protocolSessionsListSchema.parse({ ...base, deployed: true, keys });
}
