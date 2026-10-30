import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, parseAmount as amt, recipes } from '@intafaced/ledger-client';
import { DEFAULT_BUYBACK_PARAMS } from './economics/buyback.js';
import { DEFAULT_EMISSION_PARAMS } from './economics/emission.js';
import { checkGovernanceSettings, proposalWindow } from './governance-settings.js';
import { TokenError, TokenService } from './token-service.js';
import { TEST_VOTE_SIGNATURE, testVoteSignatures } from './vote-signature.testkit.js';

/**
 * MC-token-02 (J-more-catalogue-10). The founders' voting delay and period, governance roles, and a moderator's cancel.
 * PG-hard: no skip. A blank setting refuses a proposal that gives no time; every change is one audited row.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(drizzleDir, file), 'utf8'));

const FOUNDER_A = 'founder-a';
const FOUNDER_B = 'founder-b';
const AUTHOR = '11111111-1111-4111-8111-111111111111';
const OTHER_AUTHOR = '22222222-2222-4222-8222-222222222222';
const MODERATOR = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-07-15T12:00:00.000Z');
const DAY = 86_400_000n;

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  try {
    const container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('intafaced_gov_settings_test')
      .withUsername('intafaced')
      .withPassword('intafaced')
      .start();
    return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`MC-token-02 is PG-hard. TEST_DATABASE_URL unset and Testcontainers failed: ${msg}`);
  }
}

async function codeOf(work: Promise<unknown> | (() => unknown)): Promise<string | null> {
  try {
    await (typeof work === 'function' ? work() : work);
    return null;
  } catch (err) {
    return err instanceof TokenError ? err.code : `untyped: ${String(err)}`;
  }
}

describe('proposal window from the settings', () => {
  it('keeps the times the author gives and refuses a missing one while its setting is blank', () => {
    const opensAt = new Date('2026-07-16T00:00:00.000Z');
    const closesAt = new Date('2026-07-20T00:00:00.000Z');
    const blank = { votingDelayMs: null, votingPeriodMs: null };
    expect(proposalWindow(blank, { opensAt, closesAt, now: NOW })).toEqual({ opensAt, closesAt });
    expect(() => proposalWindow(blank, { now: NOW })).toThrow(expect.objectContaining({ code: 'token.proposal_window_unset' }));
    expect(() => proposalWindow(blank, { opensAt, now: NOW })).toThrow(expect.objectContaining({ code: 'token.proposal_window_unset' }));
    expect(() => proposalWindow(blank, { closesAt, now: NOW })).toThrow(expect.objectContaining({ code: 'token.proposal_window_unset' }));
  });

  it('a delay of 0 opens now and the period sets the close', () => {
    const window = proposalWindow({ votingDelayMs: 0n, votingPeriodMs: DAY }, { now: NOW });
    expect(window.opensAt.toISOString()).toBe(NOW.toISOString());
    expect(window.closesAt.toISOString()).toBe('2026-07-16T12:00:00.000Z');
  });

  it('refuses a negative delay, a zero period and anything past a year', () => {
    for (const bad of [
      { votingDelayMs: -1n, votingPeriodMs: DAY },
      { votingDelayMs: 0n, votingPeriodMs: 0n },
      { votingDelayMs: 366n * DAY, votingPeriodMs: DAY },
      { votingDelayMs: 0n, votingPeriodMs: 366n * DAY },
    ]) {
      expect(() => checkGovernanceSettings(bad)).toThrow(expect.objectContaining({ code: 'token.settings_invalid' }));
    }
    expect(() => checkGovernanceSettings({ votingDelayMs: null, votingPeriodMs: null })).not.toThrow();
  });
});

describe('MC-token-02 governance settings, roles and cancel', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase;
  let sql: Sql;
  let ledger: MemoryLedger;
  let token: TokenService;

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'token', url: admin.url, migrations });
    sql = db.sql;
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  beforeEach(async () => {
    ledger = new MemoryLedger();
    token = new TokenService(sql, ledger, new MemoryEventBus('svc-token'), {
      assetId: 'IFC',
      emission: DEFAULT_EMISSION_PARAMS,
      buyback: DEFAULT_BUYBACK_PARAMS,
      loadParamsFromDb: false,
      // Test fixture only — production env has no default vote rule.
      voteRule: 'power:0',
      voteSignatures: testVoteSignatures(),
    });
    await sql`
      TRUNCATE token.governance_votes, token.governance_snapshots, token.proposals, token.stakes,
               token.governance_settings, token.governance_settings_moves, token.governance_roles, token.governance_role_moves
      RESTART IDENTITY CASCADE
    `;
    await sql`
      UPDATE token.governance_proposer
         SET kind = 'stake', min_stake = 0, accounts = NULL, period_limit = 100, period_ms = 604800000
       WHERE id = true
    `;
  });

  async function fundStake(userId: string, amount: string): Promise<void> {
    const stakeId = crypto.randomUUID();
    await ledger.post(recipes.deposit({ userId, assetId: 'IFC', amount: amt(amount), rail: 'test', railRef: `${userId}:${stakeId}` }));
    await token.stake({ userId, amount: amt(amount), tier: 'flex', stakeId });
  }

  async function settle(delay: bigint | null, period: bigint | null, expectedRevision: number) {
    return token.setGovernanceSettings({
      votingDelayMs: delay,
      votingPeriodMs: period,
      expectedRevision,
      actorId: FOUNDER_A,
      approverId: FOUNDER_B,
    });
  }

  it("reads not set, refuses a proposal with neither time, and a founders' change stores one audit row", async () => {
    expect(await token.governanceSettings()).toEqual({ votingDelayMs: null, votingPeriodMs: null, revision: 0 });
    await fundStake(AUTHOR, '10');
    expect(await codeOf(token.createProposal({ kind: 'listing', createdBy: AUTHOR, handle: 'w1', now: NOW }))).toBe(
      'token.proposal_window_unset',
    );
    expect((await sql`SELECT id FROM token.proposals`).length).toBe(0);

    const stored = await settle(0n, DAY, 0);
    expect(stored).toEqual({ votingDelayMs: 0n, votingPeriodMs: DAY, revision: 1 });
    const history = await token.governanceSettingsHistory();
    expect(history.map((m) => [m.ordinal, m.votingDelayMs, m.votingPeriodMs, m.actorId, m.approverId])).toEqual([
      [1, 0n, DAY, FOUNDER_A, FOUNDER_B],
    ]);

    const proposal = await token.createProposal({ kind: 'listing', createdBy: AUTHOR, handle: 'w2', now: NOW });
    expect(proposal.status).toBe('open');
    expect(proposal.opensAt.toISOString()).toBe(NOW.toISOString());
    expect(proposal.closesAt.toISOString()).toBe('2026-07-16T12:00:00.000Z');
  });

  it('the proposer rule refuses before a blank window does, and a retried handle replays without the settings', async () => {
    await sql`UPDATE token.governance_proposer SET min_stake = 1000 WHERE id = true`;
    await fundStake(AUTHOR, '10');
    expect(await codeOf(token.createProposal({ kind: 'listing', createdBy: AUTHOR, handle: 'r1', now: NOW }))).toBe(
      'token.proposal_not_allowed',
    );
    await sql`UPDATE token.governance_proposer SET min_stake = 0 WHERE id = true`;
    await settle(0n, DAY, 0);
    const first = await token.createProposal({ kind: 'listing', createdBy: AUTHOR, handle: 'r2', now: NOW });
    await settle(null, null, 1);
    const again = await token.createProposal({ kind: 'listing', createdBy: AUTHOR, handle: 'r2', now: NOW });
    expect(again.id).toBe(first.id);
  });

  it('a retry of the same change writes nothing more, and a stale change refuses', async () => {
    await settle(0n, DAY, 0);
    expect(await settle(0n, DAY, 0)).toEqual({ votingDelayMs: 0n, votingPeriodMs: DAY, revision: 1 });
    expect(await codeOf(settle(DAY, DAY, 0))).toBe('token.settings_stale');
    expect(await codeOf(settle(DAY, DAY, 5))).toBe('token.settings_stale');
    await settle(null, null, 1);
    expect(await token.governanceSettings()).toEqual({ votingDelayMs: null, votingPeriodMs: null, revision: 2 });
    expect((await token.governanceSettingsHistory()).length).toBe(2);
  });

  it('a delayed retry answers what its own change stored, and the prechecks refuse without writing', async () => {
    await settle(0n, DAY, 0);
    await settle(0n, 2n * DAY, 1);
    expect(await settle(0n, DAY, 0)).toEqual({ votingDelayMs: 0n, votingPeriodMs: DAY, revision: 1 });
    expect(await codeOf(token.precheckGovernanceSettings({ votingDelayMs: DAY, votingPeriodMs: DAY, expectedRevision: 1 }))).toBe(
      'token.settings_stale',
    );
    expect(await codeOf(token.precheckGovernanceSettings({ votingDelayMs: 0n, votingPeriodMs: 0n, expectedRevision: 2 }))).toBe(
      'token.settings_invalid',
    );
    expect(await codeOf(token.precheckGovernanceSettings({ votingDelayMs: DAY, votingPeriodMs: DAY, expectedRevision: 2 }))).toBeNull();
    expect((await token.governanceSettingsHistory()).length).toBe(2);

    await token.setGovernanceRole({ userId: MODERATOR, role: 'moderator', expectedRevision: 0, actorId: FOUNDER_A, approverId: FOUNDER_B });
    await token.setGovernanceRole({ userId: MODERATOR, role: 'admin', expectedRevision: 1, actorId: FOUNDER_A, approverId: FOUNDER_B });
    expect(
      await token.setGovernanceRole({
        userId: MODERATOR,
        role: 'moderator',
        expectedRevision: 0,
        actorId: FOUNDER_A,
        approverId: FOUNDER_B,
      }),
    ).toEqual({ userId: MODERATOR, role: 'moderator', revision: 1 });
    const pre = (role: 'admin' | 'author', expectedRevision: number) =>
      codeOf(token.precheckGovernanceRole({ userId: MODERATOR, role, expectedRevision, actorId: FOUNDER_A }));
    expect(await pre('author', 1)).toBe('token.role_stale');
    expect(await pre('admin', 2)).toBe('token.role_invalid');
    expect(await pre('author', 2)).toBeNull();
    expect(await token.governanceRoleOf(MODERATOR)).toBe('admin');
  });

  it('the database refuses a change asked and approved by one person', async () => {
    await expect(
      token.setGovernanceSettings({
        votingDelayMs: 0n,
        votingPeriodMs: DAY,
        expectedRevision: 0,
        actorId: FOUNDER_A,
        approverId: FOUNDER_A,
      }),
    ).rejects.toThrow();
    expect(await token.governanceSettings()).toEqual({ votingDelayMs: null, votingPeriodMs: null, revision: 0 });
  });

  it('grants, replays and revokes a role over its revision, and never to the account that asks', async () => {
    const granted = await token.setGovernanceRole({
      userId: MODERATOR,
      role: 'moderator',
      expectedRevision: 0,
      actorId: FOUNDER_A,
      approverId: FOUNDER_B,
    });
    expect(granted).toEqual({ userId: MODERATOR, role: 'moderator', revision: 1 });
    const replay = await token.setGovernanceRole({
      userId: MODERATOR,
      role: 'moderator',
      expectedRevision: 0,
      actorId: FOUNDER_A,
      approverId: FOUNDER_B,
    });
    expect(replay).toEqual(granted);
    expect(
      await codeOf(
        token.setGovernanceRole({ userId: MODERATOR, role: 'admin', expectedRevision: 0, actorId: FOUNDER_A, approverId: FOUNDER_B }),
      ),
    ).toBe('token.role_stale');
    expect(
      await codeOf(
        token.setGovernanceRole({ userId: FOUNDER_A, role: 'admin', expectedRevision: 0, actorId: FOUNDER_A, approverId: FOUNDER_B }),
      ),
    ).toBe('token.role_invalid');
    expect(
      await codeOf(
        token.setGovernanceRole({ userId: FOUNDER_B, role: 'admin', expectedRevision: 0, actorId: FOUNDER_A, approverId: FOUNDER_B }),
      ),
    ).toBe('token.role_invalid');
    expect(
      await codeOf(
        token.setGovernanceRole({ userId: MODERATOR, role: 'moderator', expectedRevision: 1, actorId: FOUNDER_A, approverId: FOUNDER_B }),
      ),
    ).toBe('token.role_invalid');

    await token.setGovernanceRole({ userId: MODERATOR, role: null, expectedRevision: 1, actorId: FOUNDER_B, approverId: FOUNDER_A });
    expect(await token.governanceRoleOf(MODERATOR)).toBeNull();
    expect(await token.governanceRoles(50)).toEqual([{ userId: MODERATOR, role: null, revision: 2 }]);
    const moves = await sql`SELECT ordinal, from_role, to_role, actor_id, approver_id FROM token.governance_role_moves ORDER BY ordinal`;
    expect(moves.map((m) => [m.ordinal, m.from_role, m.to_role, m.actor_id, m.approver_id])).toEqual([
      [1, null, 'moderator', FOUNDER_A, FOUNDER_B],
      [2, 'moderator', null, FOUNDER_B, FOUNDER_A],
    ]);
  });

  it('a moderator cancels an open proposal with a reason; its votes stay and later votes refuse', async () => {
    await settle(0n, DAY, 0);
    await fundStake(AUTHOR, '10');
    await fundStake(OTHER_AUTHOR, '10');
    await token.setGovernanceRole({ userId: MODERATOR, role: 'moderator', expectedRevision: 0, actorId: FOUNDER_A, approverId: FOUNDER_B });
    await token.setGovernanceRole({ userId: OTHER_AUTHOR, role: 'author', expectedRevision: 0, actorId: FOUNDER_A, approverId: FOUNDER_B });
    const proposal = await token.createProposal({ kind: 'listing', createdBy: AUTHOR, handle: 'c1', now: NOW });
    await token.castVote({ signature: TEST_VOTE_SIGNATURE, proposalId: proposal.id, userId: AUTHOR, choice: 'for', now: NOW });

    const reason = 'Duplicate of an earlier listing proposal';
    expect(await codeOf(token.cancelProposal({ proposalId: proposal.id, reason, actorId: OTHER_AUTHOR, now: NOW }))).toBe(
      'token.permission_denied',
    );
    expect(await codeOf(token.cancelProposal({ proposalId: proposal.id, reason, actorId: AUTHOR, now: NOW }))).toBe(
      'token.permission_denied',
    );
    expect(await codeOf(token.cancelProposal({ proposalId: proposal.id, reason: 'too short', actorId: MODERATOR, now: NOW }))).toBe(
      'token.cancel_reason_invalid',
    );
    expect((await token.getProposal(proposal.id)).status).toBe('open');

    const cancelled = await token.cancelProposal({ proposalId: proposal.id, reason: `  ${reason}  `, actorId: MODERATOR, now: NOW });
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancel).toEqual({ reason, at: NOW });
    expect(cancelled.counts.votes).toBe(1);
    const stored = await sql`SELECT cancelled_by FROM token.proposals WHERE id = ${proposal.id}`;
    expect(stored[0]?.cancelled_by).toBe(MODERATOR);

    expect(
      await codeOf(
        token.castVote({ signature: TEST_VOTE_SIGNATURE, proposalId: proposal.id, userId: OTHER_AUTHOR, choice: 'against', now: NOW }),
      ),
    ).toBe('token.proposal_not_open');
    expect(await codeOf(token.cancelProposal({ proposalId: proposal.id, reason, actorId: MODERATOR, now: NOW }))).toBe(
      'token.proposal_not_cancellable',
    );
    // A proposal whose voting has ended waits for its close: a cancel never overturns a finished vote.
    const ended = await token.createProposal({ kind: 'listing', createdBy: AUTHOR, handle: 'c2', now: NOW });
    const after = new Date(ended.closesAt.getTime());
    expect(await codeOf(token.cancelProposal({ proposalId: ended.id, reason, actorId: MODERATOR, now: after }))).toBe(
      'token.proposal_not_cancellable',
    );
    expect((await token.getProposal(ended.id)).status).toBe('open');
    expect(await codeOf(token.cancelProposal({ proposalId: 'gov:proposal:none', reason, actorId: MODERATOR, now: NOW }))).toBe(
      'token.proposal_not_found',
    );
  });
});
