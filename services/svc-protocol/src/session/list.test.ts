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
function fakeChain(opts: { code?: string; head?: bigint; epoch?: bigint; sessions: Record<string, Sess>; grants: unknown[]; uses?: unknown[] }) {
  const calls: { fromBlock?: bigint }[] = [];
  const client = {
    getBlock: async (args: { blockNumber?: bigint }) => ({
      number: args.blockNumber ?? opts.head ?? 100n,
      timestamp: BigInt(args.blockNumber ? NOW - 60 : NOW),
    }),
    getCode: async () => opts.code ?? '0x6001',
    getLogs: async (args: { event: { name: string }; fromBlock?: bigint }) => {
      calls.push(args);
      return args.event.name === 'SessionGranted' ? opts.grants : (opts.uses ?? []);
    },
    readContract: async (args: { functionName: string; args?: [Address] }) =>
      args.functionName === 'sessionEpoch' ? (opts.epoch ?? 0n) : opts.sessions[args.args![0].toLowerCase()],
  } as unknown as SessionListClient;
  return { client, calls };
}
const grant = (key: Address, specHash: `0x${string}`, validUntil: number, blockNumber = 10n) => ({
  args: { sessionKey: key, specHash, validAfter: 0, validUntil, spendLimitWei: 5n * 10n ** 16n, targets: [ROUTER], selectors: ['0x38ed1739'] },
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
    const { client } = fakeChain({
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
    expect(a.lastUsedAt).toBe(new Date((NOW - 60) * 1000).toISOString());
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
    const { client, calls } = fakeChain({ code: '0x', sessions: {}, grants: [grant(KEY_A, HASH_A, NOW + 1)] });
    const list = await listSessions(client, { account: ACCOUNT, chainId: 84532 });
    expect(list).toMatchObject({ deployed: false, keys: [] });
    expect(calls).toHaveLength(0);
  });

  it('reads a bounded window of logs and names where it starts; a log that is not the current grant is not shown', async () => {
    const head = SESSION_LOG_BLOCKS + 500n;
    const { client, calls } = fakeChain({
      head,
      sessions: { [KEY_A.toLowerCase()]: record(HASH_B) },
      grants: [grant(KEY_A, HASH_A, NOW + 3600)],
    });
    const list = await listSessions(client, { account: ACCOUNT, chainId: 84532 });
    expect(list.logsFromBlock).toBe('501');
    expect(calls.every((c) => c.fromBlock === 501n)).toBe(true);
    expect(list.keys).toEqual([]);
  });
});
