import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { assertTestDatabase, postgresAvailable } from '@intafaced/db';
import {
  badgeClaimKey,
  badgeClaimMessage,
  BadgeMintNotSentError,
  claimBadge,
  resolveStuckBadgeMint,
  type BadgeDeps,
  type BadgeMinter,
  type BadgeStuckMintEvidence,
} from './founding-badge.js';
import { PostgresBadgeStore } from './founding-badge.pg.js';

/**
 * RC-more-catalogue-04 review blocker: concurrent claims and retries during a mint must mint once, on a real
 * database. Applies 0001 (idempotent DDL) and deletes only this file's rows.
 */
const URL = process.env.TEST_DATABASE_URL;
const here = dirname(fileURLToPath(import.meta.url));
const migration = join(here, '..', '..', 'drizzle', '0001_protocol_founding_badges.sql');
const clearsMigration = join(here, '..', '..', 'drizzle', '0002_protocol_founding_badge_mint_clears.sql');
const identityMigration = join(here, '..', '..', 'drizzle', '20261031001739_protocol_badge_chain_identity.sql');
const available = URL ? await postgresAvailable(URL) : false;
const sql: Sql | null = URL && available ? postgres(URL, { max: 6, onnotice: () => undefined }) : null;

const RACER = 'bad9e000-4444-4444-8444-444444444444';
const ALPHA = 'bad9e000-5555-4555-8555-555555555555';
const BETA = 'bad9e000-6666-4666-8666-666666666666';
const STUCK = 'bad9e000-8888-4888-8888-888888888888';
const CRASH = 'bad9e000-9999-4999-8999-999999999999';
const REBORN = 'bad9e000-7777-4777-8777-777777777777';
const IDS = [RACER, ALPHA, BETA, STUCK, CRASH, REBORN];
const REBORN_ADDR = '0x00000000000000000000000000000000000000C5' as Address;
const CRASH_ADDR = '0x00000000000000000000000000000000000000C4' as Address;
const STUCK_ADDR = '0x00000000000000000000000000000000000000C3' as Address;
const RACER_ADDR = '0x00000000000000000000000000000000000000C1' as Address;
const SHARED_ADDR = '0x00000000000000000000000000000000000000C2' as Address;
const CHAIN_ID = 31337;
const GENESIS = `0x${'a'.repeat(64)}` as const;
const network = (genesisHash: Hex) => ({ chainId: CHAIN_ID, mainnet: false, identity: async () => ({ chainId: CHAIN_ID, genesisHash }) });
const NET = network(GENESIS);
const OWNER_KEY = privateKeyToAccount(`0x${'44'.repeat(32)}`);
const WINDOW = { opensAt: new Date('2026-10-01T00:00:00Z'), closesAt: new Date('2026-11-01T00:00:00Z') };

function harness(mintDelayMs = 25, fail?: Error) {
  const mints: Array<{ to: Address; key: string }> = [];
  const minter: BadgeMinter = {
    signerFor: () => ({
      mint: async (to, key) => {
        if (fail) throw fail;
        mints.push({ to, key });
        await new Promise((r) => setTimeout(r, mintDelayMs)); // a mint in flight
        return `0x${'cd'.repeat(31)}${String(mints.length).padStart(2, '0')}` as Hex;
      },
    }),
  };
  const deps: BadgeDeps = { store: new PostgresBadgeStore(sql!), minter, window: WINDOW, now: () => new Date('2026-10-22T04:00:00Z') };
  return { deps, mints };
}

async function claimAs(deps: BadgeDeps, accountId: string, address: Address, net = NET) {
  const signature = await OWNER_KEY.signMessage({ message: badgeClaimMessage({ accountId, chainId: CHAIN_ID, address }) });
  return claimBadge(deps, accountId, { address, owner: OWNER_KEY.address }, net, signature);
}
/** The same TEST chain id after the chain was started again. */
const RESTARTED_GENESIS = `0x${'b'.repeat(64)}` as Hex;
const RESTARTED = network(RESTARTED_GENESIS);

async function cleanup() {
  await sql!`DELETE FROM protocol.founding_badge_mint_clears WHERE key IN ${sql!(IDS.map(badgeClaimKey))}`;
  await sql!`DELETE FROM protocol.founding_badge_claims WHERE account_id IN ${sql!(IDS)}`;
  await sql!`DELETE FROM protocol.founding_badge_list WHERE account_id IN ${sql!(IDS)}`;
}

describe.skipIf(!sql)('founding badge single-flight mint (Postgres)', () => {
  beforeAll(async () => {
    await assertTestDatabase(sql!, 'svc-protocol founding-badge.concurrency.pg.test');
    await sql!`CREATE SCHEMA IF NOT EXISTS protocol`;
    await sql!.unsafe(readFileSync(migration, 'utf8'));
    await sql!.unsafe(readFileSync(clearsMigration, 'utf8'));
    await sql!.unsafe(readFileSync(identityMigration, 'utf8'));
    await cleanup();
    await sql!`INSERT INTO protocol.founding_badge_list (account_id) VALUES (${RACER}), (${ALPHA}), (${BETA}), (${STUCK}), (${CRASH}), (${REBORN})`;
  });
  afterAll(async () => {
    await cleanup();
    await sql!.end();
  });

  it('two concurrent claims from one account produce exactly one mint and one stored tx', async () => {
    const { deps, mints } = harness();
    const results = await Promise.all([claimAs(deps, RACER, RACER_ADDR), claimAs(deps, RACER, RACER_ADDR)]);
    expect(mints).toEqual([{ to: RACER_ADDR, key: badgeClaimKey(RACER) }]);
    const rows = await sql!`SELECT tx_hash, minting_at FROM protocol.founding_badge_claims WHERE key = ${badgeClaimKey(RACER)}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tx_hash).not.toBeNull();
    expect(rows[0]!.minting_at).toBeNull();
    for (const r of results) expect([null, rows[0]!.tx_hash]).toContain(r.txHash);

    // A later retry returns the stored tx and still does not mint.
    const again = await claimAs(deps, RACER, RACER_ADDR);
    expect(again.txHash).toBe(rows[0]!.tx_hash);
    expect(mints).toHaveLength(1);
  });

  it('a TEST chain started again: the old claim is replaced in place and minted once on the new chain, even by two racing claims', async () => {
    const first = harness();
    const before = await claimAs(first.deps, REBORN, REBORN_ADDR);
    expect(before.genesisHash).toBe(GENESIS);
    const next = harness();
    const results = await Promise.all([
      claimAs(next.deps, REBORN, REBORN_ADDR, RESTARTED),
      claimAs(next.deps, REBORN, REBORN_ADDR, RESTARTED),
    ]);
    expect(next.mints.map((m) => [m.to.toLowerCase(), m.key])).toEqual([[REBORN_ADDR.toLowerCase(), badgeClaimKey(REBORN)]]);
    const rows = await sql!`SELECT genesis_hash, tx_hash FROM protocol.founding_badge_claims WHERE key = ${badgeClaimKey(REBORN)}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.genesis_hash).toBe(RESTARTED_GENESIS);
    expect(rows[0]!.tx_hash).not.toBeNull();
    for (const r of results) expect([null, rows[0]!.tx_hash]).toContain(r.txHash);
    // A later claim on the new chain returns the stored tx and mints nothing more.
    expect((await claimAs(harness().deps, REBORN, REBORN_ADDR, RESTARTED)).txHash).toBe(rows[0]!.tx_hash);
  });

  it('two accounts racing to one address: one claim, the other badge.already_claimed (not a 500)', async () => {
    const { deps, mints } = harness();
    const settled = await Promise.allSettled([claimAs(deps, ALPHA, SHARED_ADDR), claimAs(deps, BETA, SHARED_ADDR)]);
    const ok = settled.filter((s) => s.status === 'fulfilled');
    const refused = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(String(refused[0]!.reason)).toMatch(/badge\.already_claimed/);
    expect(mints).toHaveLength(1);
    expect(await sql!`SELECT 1 FROM protocol.founding_badge_claims WHERE account_id IN ${sql!([ALPHA, BETA])}`).toHaveLength(1);
  });

  it('stuck pending: an untyped error keeps the slot (mintingSince set, retry pending, no mint); typed error frees it', async () => {
    const key = badgeClaimKey(STUCK);
    await expect(claimAs(harness(0, new BadgeMintNotSentError('refused')).deps, STUCK, STUCK_ADDR)).rejects.toBeInstanceOf(
      BadgeMintNotSentError,
    );
    expect((await sql!`SELECT minting_at FROM protocol.founding_badge_claims WHERE key = ${key}`)[0]!.minting_at).toBeNull();

    await expect(claimAs(harness(0, new Error('rpc timeout')).deps, STUCK, STUCK_ADDR)).rejects.toThrow(/rpc timeout/);
    const ok = harness();
    const pending = await claimAs(ok.deps, STUCK, STUCK_ADDR);
    expect(pending.txHash).toBeNull();
    expect(pending.mintingSince).toBeInstanceOf(Date);
    expect(ok.mints).toHaveLength(0);

    // Operator clear: stale slot + four-eyes approval + chain evidence; "not_minted" frees the slot and the next claim mints once.
    await sql!`UPDATE protocol.founding_badge_claims SET minting_at = now() - interval '1 hour' WHERE key = ${key}`;
    const rd = resolveDeps();
    const cleared = await resolveStuckBadgeMint(
      rd,
      stuckInput(STUCK, { kind: 'not_minted', attestedBy: 'ops:test', checkedAt: new Date() }),
    );
    expect(cleared).toMatchObject({ txHash: null, mintingSince: null });
    expect((await claimAs(ok.deps, STUCK, STUCK_ADDR)).txHash).not.toBeNull();
    expect(ok.mints).toHaveLength(1);
    expect(await resolveStuckBadgeMint(rd, stuckInput(STUCK, { kind: 'minted', txHash: `0x${'11'.repeat(32)}` as Hex }))).toBeNull();
  });

  it('crash after mint submitted: retry does not mint again; after the audited operator clear the stored tx is reused', async () => {
    const key = badgeClaimKey(CRASH);
    const onChain = `0x${'77'.repeat(32)}` as Hex;
    const sent: string[] = [];
    // The signer broadcasts, then the process dies before the tx hash is stored (an untyped error).
    const crashing: BadgeDeps = {
      ...harness().deps,
      minter: { signerFor: () => ({ mint: async (_to, k) => (sent.push(k), Promise.reject(new Error('process died after broadcast'))) }) },
    };
    await expect(claimAs(crashing, CRASH, CRASH_ADDR)).rejects.toThrow(/process died/);
    expect(sent).toEqual([key]);

    const retry = harness();
    expect((await claimAs(retry.deps, CRASH, CRASH_ADDR)).txHash).toBeNull();
    expect(retry.mints).toHaveLength(0);

    await sql!`UPDATE protocol.founding_badge_claims SET minting_at = now() - interval '1 hour' WHERE key = ${key}`;
    await resolveStuckBadgeMint(resolveDeps(), stuckInput(CRASH, { kind: 'minted', txHash: onChain }, 'appr-crash'));
    const audit =
      await sql!`SELECT evidence_kind, tx_hash, actor_id, requester_id, approver_id, reason FROM protocol.founding_badge_mint_clears WHERE key = ${key}`;
    expect(audit).toEqual([
      {
        evidence_kind: 'minted',
        tx_hash: onChain,
        actor_id: 'ops:actor',
        requester_id: 'ops:first',
        approver_id: 'ops:second',
        reason: 'crash mid-mint',
      },
    ]);

    const reused = await claimAs(retry.deps, CRASH, CRASH_ADDR);
    expect(reused.txHash).toBe(onChain);
    expect(await claimAs(retry.deps, CRASH, CRASH_ADDR)).toEqual(reused);
    expect(retry.mints).toHaveLength(0);
    expect(sent).toHaveLength(1);
  });
});

function resolveDeps() {
  return {
    store: new PostgresBadgeStore(sql!),
    approvals: { consume: async () => ({ status: 'CONSUMED', requesterId: 'ops:first', approverId: 'ops:second' }) },
    staleAfterSeconds: 600,
    now: () => new Date(),
  };
}

function stuckInput(accountId: string, evidence: BadgeStuckMintEvidence, approvalId = `appr-${accountId}`) {
  return { accountId, evidence, reason: 'crash mid-mint', actorId: 'ops:actor', approvalId, operationId: `op-${approvalId}` };
}
