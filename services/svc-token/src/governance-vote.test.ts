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
import { parseVoteRule, snapshotHash } from './governance-vote.js';
import { TokenError, TokenService, type TokenServiceOptions } from './token-service.js';

/**
 * MC-token-03. Voting power is fixed when a proposal is created, who may vote
 * is a published rule, the signed vote refuses, and every voting type tallies.
 * PG-hard: no skip.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(drizzleDir, file), 'utf8'));

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const USER_C = '33333333-3333-4333-8333-333333333333';
const OPENS = new Date('2026-07-15T00:00:00.000Z');
const CLOSES = new Date('2026-07-22T00:00:00.000Z');
const NOW = new Date('2026-07-15T12:00:00.000Z');
const LATER = new Date('2026-07-16T12:00:00.000Z');
const AFTER = new Date('2026-07-23T00:00:00.000Z');

describe('vote rule', () => {
  it('blank refuses token.vote_rule_unset and a deliberate zero is kept', () => {
    for (const raw of [undefined, '', '   ', 'power:', 'power:  ']) {
      expect(() => parseVoteRule(raw)).toThrow(expect.objectContaining({ code: 'token.vote_rule_unset' }));
    }
    expect(parseVoteRule('power:0').minPower).toBe(0n);
    expect(parseVoteRule('power:1500').minPower).toBe(amt('1500'));
    expect(() => parseVoteRule('tier:1')).toThrow(expect.objectContaining({ code: 'token.params_invalid' }));
    expect(() => parseVoteRule('power:-1')).toThrow(expect.objectContaining({ code: 'token.params_invalid' }));
    expect(() => parseVoteRule('power:abc')).toThrow(expect.objectContaining({ code: 'token.params_invalid' }));
  });

  it('the snapshot seal does not depend on row order', () => {
    const a = snapshotHash([
      { userId: USER_B, power: amt('2') },
      { userId: USER_A, power: amt('1') },
    ]);
    const b = snapshotHash([
      { userId: USER_A, power: amt('1') },
      { userId: USER_B, power: amt('2') },
    ]);
    expect(a).toBe(b);
    expect(a).not.toBe(snapshotHash([{ userId: USER_A, power: amt('1') }]));
  });
});

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  try {
    const container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('intafaced_vote_test')
      .withUsername('intafaced')
      .withPassword('intafaced')
      .start();
    return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`MC-token-03 is PG-hard. TEST_DATABASE_URL unset and Testcontainers failed: ${msg}`);
  }
}

async function codeOf(work: Promise<unknown>): Promise<string | null> {
  try {
    await work;
    return null;
  } catch (err) {
    return err instanceof TokenError ? err.code : `untyped: ${String(err)}`;
  }
}

describe('MC-token-03 voting power and voting types', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase;
  let sql: Sql;
  let ledger: MemoryLedger;
  let token: TokenService;
  const options: TokenServiceOptions = {
    assetId: 'IFC',
    emission: DEFAULT_EMISSION_PARAMS,
    buyback: DEFAULT_BUYBACK_PARAMS,
    loadParamsFromDb: false,
    // Test fixture only — production env has no default bar or vote rule.
    governanceQuorumBps: 1000,
    governanceThresholdBps: 5000,
    voteRule: 'power:0',
  };

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
    token = new TokenService(sql, ledger, new MemoryEventBus('svc-token'), options);
    await sql`TRUNCATE token.governance_votes, token.governance_snapshots, token.proposals, token.stakes RESTART IDENTITY CASCADE`;
    await sql`
      UPDATE token.governance_proposer
         SET kind = 'stake', min_stake = 0, accounts = NULL, period_limit = 100, period_ms = 604800000
       WHERE id = true
    `;
  });

  async function fundStake(userId: string, amount: string, stakeId = crypto.randomUUID()): Promise<string> {
    await ledger.post(
      recipes.deposit({ userId, assetId: 'IFC', amount: amt(amount), rail: 'test', railRef: `${userId}:${amount}:${stakeId}` }),
    );
    await token.stake({ userId, amount: amt(amount), tier: 'flex', stakeId });
    return stakeId;
  }

  function create(handle: string, extra: { votingType?: string; choices?: string[] } = {}) {
    return token.createProposal({
      kind: 'fee_param',
      createdBy: USER_A,
      opensAt: OPENS,
      closesAt: CLOSES,
      now: NOW,
      handle,
      title: `Proposal ${handle}`,
      ...extra,
    });
  }

  async function votesOn(proposalId: string) {
    return sql<Array<{ user_id: string; weight: string; eligible_stake: string; choice: string | null; ballot: unknown }>>`
      SELECT user_id, weight::text AS weight, eligible_stake::text AS eligible_stake, choice, ballot
        FROM token.governance_votes WHERE proposal_id = ${proposalId} ORDER BY user_id
    `;
  }

  it('fixes voting power when the proposal is created: later stake has none, a later unstake keeps it', async () => {
    const stakeA = await fundStake(USER_A, '1000');
    await fundStake(USER_B, '2000');
    const proposal = await create('fixed');
    expect(proposal.snapshot).toMatchObject({ count: 2, total: amt('3000') });
    expect(await token.proposalPower(proposal.id, USER_A)).toMatchObject({ power: amt('1000'), reason: null, takenAt: proposal.createdAt });

    // Stake opened after creation: zero power, with the reason, and no ballot.
    await fundStake(USER_C, '5000');
    expect(await token.proposalPower(proposal.id, USER_C)).toEqual({
      proposalId: proposal.id,
      power: 0n,
      reason: 'no_stake_at_creation',
      takenAt: null,
      rule: { minPower: 0n, code: null },
    });
    expect(await codeOf(token.castVote({ proposalId: proposal.id, userId: USER_C, choice: 'for', now: LATER }))).toBe(
      'token.no_voting_weight',
    );

    // Unstake after creation: the ballot still weighs the power fixed at creation.
    await token.unstake(stakeA, LATER);
    const vote = await token.castVote({ proposalId: proposal.id, userId: USER_A, choice: 'for', now: LATER });
    expect(vote.weight).toBe(amt('1000'));
    expect(await votesOn(proposal.id)).toEqual([
      { user_id: USER_A, weight: '1000.000000000000000000', eligible_stake: '3000.000000000000000000', choice: 'for', ballot: null },
    ]);

    // A repeat vote is refused and the stored ballot is unchanged.
    expect(await codeOf(token.castVote({ proposalId: proposal.id, userId: USER_A, choice: 'against', now: LATER }))).toBe(
      'token.already_voted',
    );
    expect((await votesOn(proposal.id)).map((row) => row.choice)).toEqual(['for']);
  });

  it('lists the stored voting power per proposal, newest first, and refuses a list with no page size', async () => {
    await fundStake(USER_A, '1000');
    const first = await create('h1');
    await fundStake(USER_A, '500');
    const second = await token.createProposal({
      kind: 'grant',
      createdBy: USER_A,
      opensAt: OPENS,
      closesAt: CLOSES,
      now: LATER,
      handle: 'h2',
      title: 'Second',
    });
    const history = await token.votingPowerHistory(USER_A, 10);
    expect(history).toEqual([
      { proposalId: second.id, title: 'Second', takenAt: second.createdAt, power: amt('1500') },
      { proposalId: first.id, title: 'Proposal h1', takenAt: first.createdAt, power: amt('1000') },
    ]);
    expect(await token.votingPowerHistory(USER_B, 10)).toEqual([]);
    expect(await codeOf(token.votingPowerHistory(USER_A, undefined))).toBe('token.history_list_limit_unset');
  });

  it('a blank vote rule refuses token.vote_rule_unset and stores nothing', async () => {
    await fundStake(USER_A, '1000');
    const proposal = await create('blank-rule');
    const saved = process.env.TOKEN_VOTE_RULE;
    delete process.env.TOKEN_VOTE_RULE;
    try {
      const blank = new TokenService(sql, ledger, new MemoryEventBus('svc-token'), { ...options, voteRule: undefined });
      expect(await codeOf(blank.castVote({ proposalId: proposal.id, userId: USER_A, choice: 'for', now: NOW }))).toBe(
        'token.vote_rule_unset',
      );
      const spaces = new TokenService(sql, ledger, new MemoryEventBus('svc-token'), { ...options, voteRule: '  ' });
      expect(await codeOf(spaces.castVote({ proposalId: proposal.id, userId: USER_A, choice: 'for', now: NOW }))).toBe(
        'token.vote_rule_unset',
      );
      expect(blank.voteRuleState()).toEqual({ minPower: null, code: 'token.vote_rule_unset' });
      expect((await blank.proposalPower(proposal.id, USER_A)).rule).toEqual({ minPower: null, code: 'token.vote_rule_unset' });
    } finally {
      if (saved === undefined) delete process.env.TOKEN_VOTE_RULE;
      else process.env.TOKEN_VOTE_RULE = saved;
    }
    expect(await votesOn(proposal.id)).toEqual([]);
  });

  it('power under the published rule is refused token.vote_rule_not_met; the rule reads the snapshot', async () => {
    await fundStake(USER_A, '1000');
    await fundStake(USER_B, '2000');
    const proposal = await create('rule');
    const ruled = new TokenService(sql, ledger, new MemoryEventBus('svc-token'), { ...options, voteRule: 'power:1500' });
    expect(await codeOf(ruled.castVote({ proposalId: proposal.id, userId: USER_A, choice: 'for', now: NOW }))).toBe(
      'token.vote_rule_not_met',
    );
    expect((await ruled.proposalPower(proposal.id, USER_A)).rule).toEqual({ minPower: amt('1500'), code: null });
    // Stake added after creation does not lift A over the rule.
    await fundStake(USER_A, '1000');
    expect(await codeOf(ruled.castVote({ proposalId: proposal.id, userId: USER_A, choice: 'for', now: NOW }))).toBe(
      'token.vote_rule_not_met',
    );
    await ruled.castVote({ proposalId: proposal.id, userId: USER_B, choice: 'for', now: NOW });
    expect((await votesOn(proposal.id)).map((row) => row.user_id)).toEqual([USER_B]);
  });

  it('a signed vote refuses token.signed_vote_unavailable and stores nothing', async () => {
    await fundStake(USER_A, '1000');
    const proposal = await create('signed');
    expect(await codeOf(token.castVote({ proposalId: proposal.id, userId: USER_A, choice: 'for', signature: '0xsigned', now: NOW }))).toBe(
      'token.signed_vote_unavailable',
    );
    expect(await votesOn(proposal.id)).toEqual([]);
  });

  it('refuses a ballot when the stored power no longer matches its seal', async () => {
    await fundStake(USER_A, '1000');
    await fundStake(USER_B, '2000');
    const proposal = await create('tamper');
    await sql`UPDATE token.governance_snapshots SET power = 9000 WHERE proposal_id = ${proposal.id} AND user_id = ${USER_A}`;
    expect(await codeOf(token.castVote({ proposalId: proposal.id, userId: USER_A, choice: 'for', now: NOW }))).toBe(
      'token.governance_snapshot_missing',
    );
    expect(await votesOn(proposal.id)).toEqual([]);
  });

  it('approval: three choices, totals per choice, and close stores the ranking only', async () => {
    await fundStake(USER_A, '1000');
    await fundStake(USER_B, '400');
    await fundStake(USER_C, '50');
    const proposal = await create('approval', { votingType: 'approval', choices: ['North', 'South', 'East'] });
    expect(proposal).toMatchObject({ votingType: 'approval', choices: ['North', 'South', 'East'], ranking: null });

    await token.castVote({ proposalId: proposal.id, userId: USER_A, ballot: { kind: 'pick', choices: [2, 0] }, now: NOW });
    await token.castVote({ proposalId: proposal.id, userId: USER_B, ballot: { kind: 'pick', choices: [1] }, now: NOW });
    await token.castVote({ proposalId: proposal.id, userId: USER_C, choice: 'abstain', now: NOW });
    expect(await codeOf(token.castVote({ proposalId: proposal.id, userId: USER_A, choice: 'for', now: NOW }))).toBe('token.ballot_invalid');

    const detail = await token.getProposal(proposal.id);
    expect(detail.choiceTally).toEqual({
      totals: [amt('1000'), amt('400'), amt('1000')],
      abstainWeight: amt('50'),
      participatingWeight: amt('1450'),
      voterCount: 3,
      ranking: [0, 2, 1],
      rounds: null,
    });
    expect(detail.counts).toEqual({ votes: 3, for: 0, against: 0, abstain: 1 });
    expect((await votesOn(proposal.id)).find((row) => row.user_id === USER_A)?.ballot).toEqual({ kind: 'pick', choices: [0, 2] });

    const closed = await token.closeProposal({ proposalId: proposal.id, now: AFTER });
    expect(closed).toMatchObject({ status: 'closed_ranked', ranking: [0, 2, 1], execute: null });
    const stored = await sql<
      Array<{ status: string; ranking: unknown }>
    >`SELECT status, ranking FROM token.proposals WHERE id = ${proposal.id}`;
    expect(stored).toEqual([{ status: 'closed_ranked', ranking: [0, 2, 1] }]);
  });

  it('weighted: 9999 basis points are refused, 10000 are stored and tallied', async () => {
    await fundStake(USER_A, '1000');
    const proposal = await create('weighted', { votingType: 'weighted', choices: ['Yes', 'No'] });
    const short = {
      kind: 'split' as const,
      parts: [
        { choice: 0, bps: 5000 },
        { choice: 1, bps: 4999 },
      ],
    };
    expect(await codeOf(token.castVote({ proposalId: proposal.id, userId: USER_A, ballot: short, now: NOW }))).toBe('token.ballot_invalid');
    expect(await votesOn(proposal.id)).toEqual([]);
    await token.castVote({
      proposalId: proposal.id,
      userId: USER_A,
      ballot: {
        kind: 'split',
        parts: [
          { choice: 1, bps: 2500 },
          { choice: 0, bps: 7500 },
        ],
      },
      now: NOW,
    });
    expect((await token.getProposal(proposal.id)).choiceTally?.totals).toEqual([amt('750'), amt('250')]);
  });

  it('refuses an unknown voting type, a choice list on basic, and a ballot on basic', async () => {
    await fundStake(USER_A, '1000');
    expect(await codeOf(create('bad-type', { votingType: 'conviction', choices: ['a', 'b'] }))).toBe('token.voting_type_unsupported');
    expect(await codeOf(create('basic-choices', { choices: ['a', 'b'] }))).toBe('token.ballot_invalid');
    expect(await codeOf(create('one-choice', { votingType: 'approval', choices: ['only'] }))).toBe('token.ballot_invalid');
    expect(await sql`SELECT id FROM token.proposals`).toEqual([]);

    const basic = await create('basic');
    expect(basic.votingType).toBe('basic');
    expect(await codeOf(token.castVote({ proposalId: basic.id, userId: USER_A, ballot: { kind: 'pick', choices: [0] }, now: NOW }))).toBe(
      'token.ballot_invalid',
    );
    expect(await votesOn(basic.id)).toEqual([]);
  });

  it('basic: the tally and close read the same as before snapshots', async () => {
    await fundStake(USER_A, '1000');
    await fundStake(USER_B, '400');
    const proposal = await create('basic-close');
    await token.castVote({ proposalId: proposal.id, userId: USER_A, choice: 'for', now: NOW });
    await token.castVote({ proposalId: proposal.id, userId: USER_B, choice: 'against', now: NOW });
    const detail = await token.getProposal(proposal.id);
    expect(detail.choiceTally).toBeNull();
    expect(detail.tally).toEqual({
      forWeight: amt('1000'),
      againstWeight: amt('400'),
      abstainWeight: 0n,
      totalWeight: amt('1400'),
      voterCount: 2,
    });
    const closed = await token.closeProposal({ proposalId: proposal.id, now: AFTER });
    expect(closed.status).toBe('passed');
    expect(closed.ranking).toBeNull();
  });
});
