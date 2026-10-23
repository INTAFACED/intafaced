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
import {
  GOVERNANCE_SPACE_ID,
  decideProposer,
  normalizeProposalTitle,
  proposalSearchPattern,
  proposerGateFromEnv,
  type ProposerGate,
} from './governance-home.js';
import { TokenError, TokenService } from './token-service.js';

/**
 * MC-token-01. One space, follow, a stored proposer rule, and draft open.
 * PG-hard: no skip. Blank rule and blank cap refuse. A retry handle stores one row.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(drizzleDir, file), 'utf8'));

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const OPENS = new Date('2026-07-15T00:00:00.000Z');
const CLOSES = new Date('2026-07-22T00:00:00.000Z');
const NOW = new Date('2026-07-15T12:00:00.000Z');
const H8A_IMAGE = 'postgres:16-alpine';

const stakeGate: ProposerGate = {
  kind: 'stake',
  minStake: amt('1000'),
  accounts: null,
  periodLimit: 2,
  periodMs: 86_400_000n,
};

describe('proposer rule decisions', () => {
  it('refuses a blank env rule and a blank cap, and keeps a deliberate zero', () => {
    const blank = proposerGateFromEnv({});
    const spaces = proposerGateFromEnv({ TOKEN_PROPOSER_RULE: '   ' });
    const noCap = proposerGateFromEnv({ TOKEN_PROPOSER_RULE: 'stake:1000' });
    expect(blank.ok).toBe(false);
    expect(spaces.ok).toBe(false);
    expect(noCap.ok).toBe(false);
    if (!blank.ok) expect(blank.code).toBe('token.proposer_rule_unset');
    if (!spaces.ok) expect(spaces.code).toBe('token.proposer_rule_unset');
    if (!noCap.ok) expect(noCap.code).toBe('token.proposal_limit_unset');
    const zero = proposerGateFromEnv({ TOKEN_PROPOSER_RULE: 'stake:0', TOKEN_PROPOSAL_LIMIT: '0:0' });
    expect(zero.ok).toBe(true);
    if (zero.ok) {
      expect(zero.gate.minStake).toBe(0n);
      expect(zero.gate.periodLimit).toBe(0);
      expect(zero.gate.periodMs).toBe(0n);
    }
  });

  it('refuses a rule that is not stake, authors, or listed', () => {
    expect(() => proposerGateFromEnv({ TOKEN_PROPOSER_RULE: 'tier:1000', TOKEN_PROPOSAL_LIMIT: '1:1000' })).toThrow(TokenError);
  });

  it('stake below the published minimum is refused; the published minimum is not a guess', () => {
    expect(decideProposer(stakeGate, { userId: USER_A, staked: amt('999'), asAdmin: false, existing: 0 }).code).toBe(
      'token.proposal_not_allowed',
    );
    expect(decideProposer(stakeGate, { userId: USER_A, staked: amt('1000'), asAdmin: false, existing: 0 })).toEqual({
      code: null,
      minStake: '1000',
    });
    expect(decideProposer(stakeGate, { userId: USER_A, staked: 0n, asAdmin: true, existing: 2 }).code).toBe('token.proposal_limit_reached');
  });

  it('authors and listed are the published accounts, and an empty list is nobody', () => {
    const authors: ProposerGate = { ...stakeGate, kind: 'authors', minStake: null, accounts: [USER_A] };
    expect(decideProposer(authors, { userId: USER_B, staked: amt('5000'), asAdmin: false, existing: 0 }).code).toBe(
      'token.proposal_not_allowed',
    );
    expect(decideProposer(authors, { userId: USER_A, staked: 0n, asAdmin: false, existing: 0 }).code).toBeNull();
    const nobody: ProposerGate = { ...authors, kind: 'listed', accounts: [] };
    expect(decideProposer(nobody, { userId: USER_A, staked: amt('5000'), asAdmin: false, existing: 0 }).code).toBe(
      'token.proposal_not_allowed',
    );
  });

  it('rejects an empty title and escapes search wildcards', () => {
    expect(normalizeProposalTitle(undefined)).toBeNull();
    expect(normalizeProposalTitle('  Alpha  ')).toBe('Alpha');
    expect(() => normalizeProposalTitle('   ')).toThrow(TokenError);
    expect(proposalSearchPattern('  ')).toBeNull();
    expect(proposalSearchPattern('100%_off')).toBe('%100\\%\\_off%');
  });
});

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  try {
    const container = await new PostgreSqlContainer(H8A_IMAGE)
      .withDatabase('intafaced_h8a_test')
      .withUsername('intafaced')
      .withPassword('intafaced')
      .start();
    return { url: container.getConnectionUri(), stop: async () => container.stop() };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`MC-token-01 is PG-hard. TEST_DATABASE_URL unset and Testcontainers failed: ${msg}`);
  }
}

async function publish(
  sql: Sql,
  row: { kind: string | null; minStake: string | null; accounts: string[] | null; limit: number | null; periodMs: bigint | null },
) {
  await sql`
    UPDATE token.governance_proposer
       SET kind = ${row.kind},
           min_stake = ${row.minStake}::numeric,
           accounts = ${row.accounts == null ? null : sql.json(row.accounts)},
           period_limit = ${row.limit},
           period_ms = ${row.periodMs == null ? null : row.periodMs.toString()}::bigint
     WHERE id = true
  `;
}

describe('MC-token-01 governance home', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase;
  let sql: Sql;
  let token: TokenService;
  let ledger: MemoryLedger;

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
    });
    await sql`TRUNCATE token.governance_votes, token.proposals, token.governance_follows, token.stakes RESTART IDENTITY CASCADE`;
    await publish(sql, { kind: 'stake', minStake: '1000', accounts: null, limit: 100, periodMs: 604_800_000n });
    delete process.env.TOKEN_PROPOSER_RULE;
    delete process.env.TOKEN_PROPOSAL_LIMIT;
  });

  async function fundStake(userId: string, amount: string) {
    await ledger.post(
      recipes.deposit({
        userId,
        assetId: 'IFC',
        amount: amt(amount),
        rail: 'test',
        railRef: `${userId}:${amount}:gov`,
      }),
    );
    await token.stake({ userId, amount: amt(amount), tier: 'flex', stakeId: crypto.randomUUID() });
  }

  it('follows the one space once, and a second follow changes nothing', async () => {
    const home = await token.governanceHome(USER_A, false);
    expect(home.spaceId).toBe(GOVERNANCE_SPACE_ID);
    expect(home.following).toBe(false);

    const first = await token.followSpace(USER_A, true);
    const stamped = await sql<Array<{ updated_at: Date }>>`
      SELECT updated_at FROM token.governance_follows WHERE account_id = ${USER_A}
    `;
    const second = await token.followSpace(USER_A, true);
    const again = await sql<Array<{ updated_at: Date }>>`
      SELECT updated_at FROM token.governance_follows WHERE account_id = ${USER_A}
    `;
    expect(first).toEqual({ spaceId: GOVERNANCE_SPACE_ID, following: true });
    expect(second).toEqual(first);
    expect(again[0]?.updated_at.toISOString()).toBe(stamped[0]?.updated_at.toISOString());
    expect((await sql`SELECT account_id FROM token.governance_follows`).length).toBe(1);

    expect(await token.followSpace(USER_A, false)).toEqual({ spaceId: GOVERNANCE_SPACE_ID, following: false });
    expect((await token.governanceHome(USER_A, false)).following).toBe(false);
  });

  it('refuses a blank rule and a blank cap, including for an admin', async () => {
    await publish(sql, { kind: null, minStake: null, accounts: null, limit: null, periodMs: null });
    await expect(
      token.createProposal({ kind: 'listing', createdBy: USER_A, asAdmin: true, opensAt: OPENS, closesAt: CLOSES, now: NOW }),
    ).rejects.toMatchObject({ code: 'token.proposer_rule_unset' });

    await publish(sql, { kind: 'stake', minStake: '1000', accounts: null, limit: null, periodMs: null });
    await expect(
      token.createProposal({ kind: 'listing', createdBy: USER_A, asAdmin: true, opensAt: OPENS, closesAt: CLOSES, now: NOW }),
    ).rejects.toMatchObject({ code: 'token.proposal_limit_unset' });
    expect(await sql`SELECT id FROM token.proposals`).toHaveLength(0);
  });

  it('refuses a stake under the published minimum and stores one row for one handle', async () => {
    await fundStake(USER_A, '999');
    await expect(
      token.createProposal({ kind: 'listing', createdBy: USER_A, opensAt: OPENS, closesAt: CLOSES, now: NOW, title: 'Too small' }),
    ).rejects.toMatchObject({ code: 'token.proposal_not_allowed' });

    await fundStake(USER_A, '1');
    const handle = 'draft-1';
    const first = await token.createProposal({
      kind: 'fee_param',
      createdBy: USER_A,
      opensAt: OPENS,
      closesAt: CLOSES,
      now: NOW,
      handle,
      title: 'Alpha',
      bodyMd: 'The body',
      discussionLink: 'https://example.com/thread',
    });
    const second = await token.createProposal({
      kind: 'grant',
      createdBy: USER_A,
      opensAt: OPENS,
      closesAt: CLOSES,
      now: NOW,
      handle,
      title: 'Replaced',
    });
    expect(second.id).toBe(first.id);
    expect(second.title).toBe('Alpha');
    expect(first.businessKey).toBe(`gov:proposal:${GOVERNANCE_SPACE_ID}:${USER_A}:1`);
    expect(first.revision).toBe(1);
    expect(await sql`SELECT id FROM token.proposals`).toHaveLength(1);

    const other = await token.createProposal({
      kind: 'listing',
      createdBy: USER_A,
      opensAt: OPENS,
      closesAt: CLOSES,
      now: NOW,
      handle: 'draft-2',
      title: 'Beacon',
    });
    expect(other.businessKey).toBe(`gov:proposal:${GOVERNANCE_SPACE_ID}:${USER_A}:2`);
  });

  it('keeps the caller proposal id as the row id and still mints the business key', async () => {
    await fundStake(USER_A, '1000');
    const proposalId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
    const created = await token.createProposal({
      kind: 'curriculum',
      createdBy: USER_A,
      proposalId,
      opensAt: OPENS,
      closesAt: CLOSES,
      now: NOW,
    });
    expect(created.id).toBe(proposalId);
    expect(created.businessKey).toBe(`gov:proposal:${GOVERNANCE_SPACE_ID}:${USER_A}:1`);
    const retry = await token.createProposal({
      kind: 'grant',
      createdBy: USER_A,
      proposalId,
      opensAt: OPENS,
      closesAt: CLOSES,
      now: NOW,
      title: 'Ignored',
    });
    expect(retry.id).toBe(proposalId);
    expect(retry.title).toBeNull();
  });

  it('edits a draft once per change, then the open job makes a repeat a no-op', async () => {
    await fundStake(USER_A, '1000');
    const futureOpen = new Date('2026-08-01T00:00:00.000Z');
    const futureClose = new Date('2026-08-08T00:00:00.000Z');
    const draft = await token.createProposal({
      kind: 'fee_param',
      createdBy: USER_A,
      opensAt: futureOpen,
      closesAt: futureClose,
      now: NOW,
      title: 'Alpha',
      bodyMd: 'First',
    });
    expect(draft.status).toBe('draft');
    const edited = await token.editProposal({ proposalId: draft.id, authorId: USER_A, title: 'Alpha revised', bodyMd: 'Second' });
    expect(edited.revision).toBe(2);
    expect(edited.status).toBe('draft');
    const same = await token.editProposal({ proposalId: draft.id, authorId: USER_A, title: 'Alpha revised', bodyMd: 'Second' });
    expect(same.revision).toBe(2);

    await expect(token.editProposal({ proposalId: draft.id, authorId: USER_B, title: 'Stolen' })).rejects.toMatchObject({
      code: 'token.proposal_not_allowed',
    });
    await expect(token.editProposal({ proposalId: draft.id, authorId: USER_A, title: '  ' })).rejects.toMatchObject({
      code: 'token.proposal_title_invalid',
    });

    expect(await token.openDueProposals(NOW)).toEqual({ opened: 0 });
    expect((await token.getProposal(draft.id)).status).toBe('draft');
    const openedAt = new Date('2026-08-02T00:00:00.000Z');
    expect(await token.openDueProposals(openedAt)).toEqual({ opened: 1 });
    expect(await token.openDueProposals(openedAt)).toEqual({ opened: 0 });
    expect((await token.getProposal(draft.id)).status).toBe('open');
    await expect(token.editProposal({ proposalId: draft.id, authorId: USER_A, title: 'Too late' })).rejects.toMatchObject({
      code: 'token.proposal_not_editable',
    });
    const vote = await token.castVote({ proposalId: draft.id, userId: USER_A, choice: 'for', now: openedAt });
    expect(vote.proposalId).toBe(draft.id);
  });

  it('searches by title and returns ballot counts, not weights', async () => {
    await fundStake(USER_A, '1000');
    await fundStake(USER_B, '2000');
    await token.createProposal({ kind: 'listing', createdBy: USER_A, opensAt: OPENS, closesAt: CLOSES, now: NOW, title: 'Alpha' });
    const beacon = await token.createProposal({
      kind: 'grant',
      createdBy: USER_A,
      opensAt: OPENS,
      closesAt: CLOSES,
      now: NOW,
      title: 'Beacon',
      bodyMd: 'notes',
    });
    await token.castVote({ proposalId: beacon.id, userId: USER_A, choice: 'for', now: NOW });
    await token.castVote({ proposalId: beacon.id, userId: USER_B, choice: 'against', now: NOW });

    const found = await token.listProposals({ q: 'alpha', limit: 50 });
    expect(found.map((row) => row.title).sort()).toEqual(['Alpha']);
    const cards = await token.listProposals({ q: 'Beacon', limit: 50 });
    expect(cards).toHaveLength(1);
    expect(cards[0]?.counts).toEqual({ votes: 2, for: 1, against: 1, abstain: 0 });
    expect(await token.listProposals({ q: 'missing', limit: 50 })).toEqual([]);
  });

  it('admits one of two concurrent creates when the cap is one', async () => {
    await publish(sql, { kind: 'stake', minStake: '1000', accounts: null, limit: 1, periodMs: 604_800_000n });
    await fundStake(USER_A, '1000');
    const results = await Promise.all(
      ['a', 'b'].map((handle) =>
        token
          .createProposal({
            kind: 'listing',
            createdBy: USER_A,
            opensAt: OPENS,
            closesAt: CLOSES,
            now: NOW,
            handle,
            title: handle,
          })
          .then(() => 'ok' as const)
          .catch((err: { code?: string }) => err.code ?? 'other'),
      ),
    );
    expect(results.filter((row) => row === 'ok')).toHaveLength(1);
    expect(results.filter((row) => row === 'token.proposal_limit_reached')).toHaveLength(1);
    expect(await sql`SELECT id FROM token.proposals`).toHaveLength(1);
  });

  it('uses the stored row when env names a different rule', async () => {
    process.env.TOKEN_PROPOSER_RULE = 'stake:1';
    process.env.TOKEN_PROPOSAL_LIMIT = '100:1000';
    await fundStake(USER_A, '1000');
    await expect(
      token.createProposal({ kind: 'listing', createdBy: USER_B, opensAt: OPENS, closesAt: CLOSES, now: NOW }),
    ).rejects.toMatchObject({ code: 'token.proposal_not_allowed' });
    const home = await token.governanceHome(USER_A, false);
    expect(home.proposal.code).toBeNull();
    expect(home.proposal.minStake).toBe('1000');
  });
});
