import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { listSessions, sessionStatus, SESSION_LOG_BLOCKS, type SessionListClient } from './list.js';

const ACCOUNT = '0x1111111111111111111111111111111111111111' as Address;
const KEY_A = '0x000000000000000000000000000000000000a001' as Address;
const KEY_B = '0x000000000000000000000000000000000000b002' as Address;
const ROUTER = '0x2222222222222222222222222222222222222222' as Address;
const HASH_A = `0x${'aa'.repeat(32)}` as const;
const HASH_B = `0x${'bb'.repeat(32)}` as const;
const NOW = 1_800_000_000;

type Sess = { specHash: `0x${string}`; validAfter: number; validUntil: number; spentWei: bigint; epoch: bigint; revoked: boolean };
type Log = { args: Record<string, unknown>; blockNumber: bigint };
/** A chain of 2-second blocks whose head is at NOW; the account has code from `created` on. */
function fakeChain(opts: {
  created?: bigint | null;
  head?: bigint;
  epoch?: bigint;
  sessions: Record<string, Sess>;
  grants: Log[];
  uses?: Log[];
}) {
  const head = opts.head ?? 100n;
  const created = opts.created === undefined ? 5n : opts.created;
  const calls: { fromBlock: bigint; toBlock: bigint }[] = [];
  const stamp = (n: bigint) => BigInt(NOW) - (head - n) * 2n;
  const client = {
    getBlock: async (args: { blockNumber?: bigint }) => ({ number: args.blockNumber ?? head, timestamp: stamp(args.blockNumber ?? head) }),
    getCode: async (args: { blockNumber: bigint }) => (created !== null && args.blockNumber >= created ? '0x6001' : '0x'),
    getLogs: async (args: { event: { name: string }; fromBlock: bigint; toBlock: bigint }) => {
      calls.push(args);
      const all = args.event.name === 'SessionGranted' ? opts.grants : (opts.uses ?? []);
      return all.filter((log) => log.blockNumber >= args.fromBlock && log.blockNumber <= args.toBlock);
    },
    readContract: async (args: { functionName: string; args?: [Address] }) =>
      args.functionName === 'sessionEpoch' ? (opts.epoch ?? 0n) : opts.sessions[args.args![0].toLowerCase()],
  } as unknown as SessionListClient;
  return { client, calls, stamp };
}
const grant = (key: Address, specHash: `0x${string}`, validUntil: number, blockNumber = 10n) => ({
  args: {
    sessionKey: key,
    specHash,
    validAfter: 0,
    validUntil,
    spendLimitWei: 5n * 10n ** 16n,
    targets: [ROUTER],
    selectors: ['0x38ed1739'],
  },
  blockNumber,
});
const record = (specHash: `0x${string}`, over: Partial<Sess> = {}): Sess => ({
  specHash,
  validAfter: 0,
  validUntil: NOW + 3600,
  spentWei: 0n,
  epoch: 0n,
  revoked: false,
  ...over,
});

describe('sessions.list (D-portfolio-wallet-02)', () => {
  it('lists each key with its scope, cap, expiry and last use, from the grant log and the on-chain record', async () => {
    const { client, stamp } = fakeChain({
      sessions: { [KEY_A.toLowerCase()]: record(HASH_A, { spentWei: 7n }), [KEY_B.toLowerCase()]: record(HASH_B) },
      grants: [grant(KEY_A, HASH_A, NOW + 3600, 10n), grant(KEY_B, HASH_B, NOW + 7200, 12n)],
      uses: [{ args: { sessionKey: KEY_A }, blockNumber: 40n }],
    });
    const list = await listSessions(client, { account: ACCOUNT, chainId: 84532 });
    expect(list.deployed).toBe(true);
    expect(list.keys.map((k) => [k.key.toLowerCase(), k.status])).toEqual([
      [KEY_B.toLowerCase(), 'active'],
      [KEY_A.toLowerCase(), 'active'],
    ]);
    const a = list.keys.find((k) => k.key.toLowerCase() === KEY_A.toLowerCase())!;
    expect(a).toMatchObject({ targets: [ROUTER], selectors: ['0x38ed1739'], spendLimitWei: '50000000000000000', spentWei: '7' });
    expect(a.lastUsedAt).toBe(new Date(Number(stamp(40n)) * 1000).toISOString());
    // A new account: every log from its creation block is read.
    expect(list.logsFromBlock).toBe('5');
    expect(list.keys.find((k) => k.key.toLowerCase() === KEY_B.toLowerCase())!.lastUsedAt).toBeNull();
  });

  it('marks an expired key, a revoked key, and every key ended by Revoke all (an older epoch)', () => {
    const g = { validAfter: 0, validUntil: NOW + 10 };
    expect(sessionStatus(g, record(HASH_A), 0n, NOW + 10)).toBe('expired');
    expect(sessionStatus(g, record(HASH_A, { revoked: true }), 0n, NOW)).toBe('revoked');
    expect(sessionStatus(g, record(HASH_A, { epoch: 0n }), 1n, NOW)).toBe('revoked');
    expect(sessionStatus({ validAfter: NOW + 5, validUntil: NOW + 10 }, record(HASH_A), 0n, NOW)).toBe('not_yet_valid');
    expect(sessionStatus(g, record(HASH_A), 0n, NOW)).toBe('active');
  });

  it('an account with no code has granted nothing, and says so rather than listing nothing as if read', async () => {
    const { client, calls } = fakeChain({ created: null, sessions: {}, grants: [grant(KEY_A, HASH_A, NOW + 1)] });
    const list = await listSessions(client, { account: ACCOUNT, chainId: 84532 });
    expect(list).toMatchObject({ deployed: false, keys: [] });
    expect(calls).toHaveLength(0);
  });

  it('an old account is read from 30 days back, the longest a key can live, in chunks; a log that is not the current grant is not shown', async () => {
    const head = 2_000_000n;
    const { client, calls } = fakeChain({
      head,
      created: 10n,
      sessions: { [KEY_A.toLowerCase()]: record(HASH_B), [KEY_B.toLowerCase()]: record(HASH_B) },
      grants: [grant(KEY_A, HASH_A, NOW + 3600, head - 5n), grant(KEY_B, HASH_B, NOW + 3600, head - 600_000n)],
    });
    const list = await listSessions(client, { account: ACCOUNT, chainId: 84532 });
    // 30 days of 2-second blocks is 1,296,000 blocks.
    const from = head - 1_296_000n;
    expect(list.logsFromBlock).toBe(from.toString());
    expect(calls.every((c) => c.fromBlock >= from && c.toBlock - c.fromBlock < SESSION_LOG_BLOCKS)).toBe(true);
    expect(calls.some((c) => c.toBlock === head)).toBe(true);
    // KEY_B, granted 600,000 blocks ago, is still found; KEY_A's log is not its current grant.
    expect(list.keys.map((k) => k.key.toLowerCase())).toEqual([KEY_B.toLowerCase()]);
  });
});
