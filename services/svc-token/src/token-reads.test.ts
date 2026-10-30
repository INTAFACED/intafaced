import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, formatAmount, parseAmount as amt, recipes, rewardsEngine } from '@intafaced/ledger-client';
import { epochReward, type EmissionParams } from './economics/emission.js';
import { STAKE_TIERS, stakeWeight, unlockDate } from './economics/staking.js';
import { createTokenRouter } from './router.js';
import { publishedStakeTiers, stakingAssetPublication } from './terms.js';
import { TokenService, previewStakeTerms, type TokenError } from './token-service.js';

/**
 * Owner reads: published terms, stake/unstake preview, yield and revenue-share
 * history, vote history, emission schedule. Reads do not mint, stake, or unstake.
 *
 * Postgres is the shared test server (TEST_DATABASE_URL). This file does not
 * start Docker when that variable is set. The admin database name must end in
 * `_test` — `assertTestDatabase` refuses the shared name `test`.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const EDGE_SECRET = 'a-token-owner-reads-test-edge-secret-long';
const edgeContext = createEdgeContext({ secret: EDGE_SECRET, serviceName: 'svc-token' });

/** A signed edge context for `userId` holding token:read, so a read goes through the router and its output check. */
function signedReader(userId: string) {
  const raw = encodePrincipal({
    sub: userId,
    userId,
    sid: '33333333-3333-4333-8333-333333333333',
    scopes: ['token:read'],
    tier: 'basic',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal);
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, EDGE_SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-token-owner-reads',
  });
}

describe('published terms', () => {
  it('imports the stake-path tier constants and does not publish a minimum', () => {
    const tiers = publishedStakeTiers();
    expect(tiers.map((tier) => tier.name)).toEqual(['flex', 'm3', 'm12']);
    for (const tier of tiers) {
      expect(tier.lockDays).toBe(STAKE_TIERS[tier.name].lockDays);
      expect(tier.multiplierBps).toBe(STAKE_TIERS[tier.name].multiplierBps);
      expect(tier.label).toBe(STAKE_TIERS[tier.name].label);
      expect(tier.minimumStake).toBeNull();
      expect(tier.minimumStakeReason).toBe('stake_minimum_unpublished');
    }
  });

  it('treats a missing or blank TOKEN_ASSET_ID as unpublished and a set value as published', () => {
    expect(stakingAssetPublication({})).toEqual({
      published: false,
      assetId: null,
      reason: 'staking_asset_unpublished',
    });
    expect(stakingAssetPublication({ TOKEN_ASSET_ID: '   ' }).published).toBe(false);
    expect(stakingAssetPublication({ TOKEN_ASSET_ID: 'TST' })).toEqual({ published: true, assetId: 'TST' });
  });

  it('refuses an unknown tier, a non-positive amount, or an unpublished asset', () => {
    const at = new Date('2026-04-01T00:00:00.000Z');
    expect(() => previewStakeTerms({ amount: amt('1'), tier: 'nope', at, stakingAssetPublished: true })).toThrow(
      expect.objectContaining({ code: 'token.stake_tier_unknown' }),
    );
    expect(() => previewStakeTerms({ amount: amt('0'), tier: 'flex', at, stakingAssetPublished: true })).toThrow(
      expect.objectContaining({ code: 'token.stake_amount_invalid' }),
    );
    expect(() => previewStakeTerms({ amount: amt('1'), tier: 'm3', at, stakingAssetPublished: false })).toThrow(
      expect.objectContaining({ code: 'token.staking_asset_unpublished' }),
    );
  });
});

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_h8a_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return {
    url: container.getConnectionUri(),
    stop: async () => {
      await container.stop();
    },
  };
}

describe('token owner reads', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase;
  let sql: TestDatabase['sql'];
  let ledger: MemoryLedger;
  let token: TokenService;
  let scheduled: TokenService;

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
    await sql`TRUNCATE token.governance_votes, token.proposals, token.stakes, token.buyback_runs, token.emission_epochs, token.yield_payouts, token.yield_windows RESTART IDENTITY CASCADE`;
    await sql`
      UPDATE token.token_params
         SET total_supply = NULL,
             emission_curve = NULL,
             halving_interval = NULL,
             fee_discount_schedule = NULL,
             buyback_bps = NULL,
             burn_split_bps = NULL
       WHERE id = true
    `;
    ledger = new MemoryLedger();
    const bus = new MemoryEventBus('svc-token');
    token = new TokenService(sql, ledger, bus, {
      assetId: 'IFC',
      loadParamsFromDb: false,
      emission: { initialEpochReward: amt('1'), halvingIntervalEpochs: 2, maxSupply: amt('10') },
      buyback: { buybackBps: 5_000, burnSplitBps: 6_000 },
      feeScheduleTtlMs: 0,
      emissionEpochMs: 0,
    });
    scheduled = new TokenService(sql, ledger, bus, { assetId: 'IFC', loadParamsFromDb: true, feeScheduleTtlMs: 0, emissionEpochMs: 0 });
  });

  async function fund(userId: string, amount: string) {
    await ledger.post(
      recipes.deposit({
        userId,
        assetId: 'IFC',
        amount: amt(amount),
        rail: 'test',
        railRef: `${userId}:${amount}:${Math.random()}`,
      }),
    );
  }

  it('preview numbers match what stake stores, and neither preview writes', async () => {
    const at = new Date('2026-04-01T00:00:00.000Z');
    const amount = amt('250.5');
    const beforeStakes = await sql`SELECT id FROM token.stakes`;
    const beforeJournal = ledger.journal().length;
    const preview = token.previewStake({ amount, tier: 'm3', at, stakingAssetPublished: true });
    expect(beforeStakes).toHaveLength(0);
    expect(ledger.journal()).toHaveLength(beforeJournal);
    expect(preview.multiplierBps).toBe(STAKE_TIERS.m3.multiplierBps);
    expect(preview.unlocksAt).toBe(unlockDate('m3', at)!.toISOString());
    expect(preview.effectiveWeight).toBe(formatAmount(stakeWeight(amount, 'm3')));

    await fund(USER_A, '1000');
    const opened = await token.stake({ userId: USER_A, amount, tier: 'm3', stakeId: crypto.randomUUID() });
    const rows = await sql<Array<{ multiplier_bps: string; started_at: Date; unlocks_at: Date; amount: string }>>`
      SELECT multiplier_bps::text, started_at, unlocks_at, amount::text AS amount FROM token.stakes WHERE id = ${opened.id}
    `;
    const row = rows[0]!;
    expect(Number(row.multiplier_bps)).toBe(preview.multiplierBps);
    const stored = previewStakeTerms({
      amount: amt(row.amount),
      tier: 'm3',
      at: row.started_at,
      stakingAssetPublished: true,
    });
    expect(stored.unlocksAt).toBe(row.unlocks_at.toISOString());
    expect(stored.multiplierBps).toBe(Number(row.multiplier_bps));
    expect(stored.effectiveWeight).toBe(formatAmount(stakeWeight(amt(row.amount), 'm3')));
    expect(preview.effectiveWeight).toBe(stored.effectiveWeight);

    const stakesBeforePreview = await sql`SELECT id, status, amount::text FROM token.stakes`;
    const journalBeforePreview = ledger.journal().length;
    const locked = await token.previewUnstake(opened.id, USER_A, row.started_at);
    expect(locked.status).toBe('locked_until');
    expect(locked.unlocksAt).toBe(row.unlocks_at.toISOString());
    expect(locked.refusal).toBe('token.stake_locked');
    expect(locked.afterUnlock).toBe('full_principal');
    expect(locked.amount).toBe(formatAmount(amount));
    await expect(token.previewUnstake(opened.id, USER_B, row.started_at)).rejects.toMatchObject({
      code: 'token.stake_not_found',
    } satisfies Partial<TokenError>);
    expect(await sql`SELECT id, status, amount::text FROM token.stakes`).toEqual(stakesBeforePreview);
    expect(ledger.journal()).toHaveLength(journalBeforePreview);

    const flexAt = new Date('2026-05-01T00:00:00.000Z');
    const flexPreview = previewStakeTerms({ amount: amt('1'), tier: 'flex', at: flexAt, stakingAssetPublished: true });
    expect(flexPreview.unlocksAt).toBeNull();
    const flex = await token.stake({ userId: USER_A, amount: amt('1'), tier: 'flex', stakeId: crypto.randomUUID() });
    const ready = await token.previewUnstake(flex.id, USER_A, flexAt);
    expect(ready.status).toBe('ready');
    expect(ready.refusal).toBeNull();
    expect(ready.afterUnlock).toBe('full_principal');
    expect(await sql`SELECT status FROM token.stakes WHERE id = ${flex.id}`).toEqual([{ status: 'active' }]);
  });

  it('lists the caller yield and the ledger revenue share, paged without gaps', async () => {
    await ledger.post(recipes.mintEmission({ epoch: 0, assetId: 'IFC', amount: amt('100'), destination: rewardsEngine('IFC') }));
    const planned = [
      { windowId: 'w1', userId: USER_A, amount: '1.25', at: '2026-01-01T00:00:00.000001Z' },
      { windowId: 'w2', userId: USER_A, amount: '2.50', at: '2026-02-01T00:00:00.000001Z' },
      { windowId: 'w3', userId: USER_A, amount: '3.75', at: '2026-03-01T00:00:00.000001Z' },
      { windowId: 'b1', userId: USER_B, amount: '9', at: '2026-04-01T00:00:00.000001Z' },
    ];
    const posted = new Map<string, { id: string; amount: string }>();
    for (const row of planned) {
      const tx = await ledger.post(
        recipes.rewardPay({
          rewardId: `yield:${row.windowId}:${row.userId}`,
          userId: row.userId,
          assetId: 'IFC',
          amount: amt(row.amount),
          reason: 'token.yield.distributed',
        }),
      );
      posted.set(`${row.userId}:${row.windowId}`, { id: tx.id, amount: formatAmount(amt(row.amount)) });
      await sql`
        INSERT INTO token.yield_payouts (window_id, user_id, amount, ledger_tx_id, paid_at, planned_at)
        VALUES (
          ${row.windowId}, ${row.userId}, ${row.amount}::numeric, ${tx.id}, ${row.at}::timestamptz, ${row.at}::timestamptz
        )
      `;
    }

    await expect(token.yieldHistory(USER_A, undefined)).rejects.toMatchObject({ code: 'token.history_list_limit_unset' });
    await expect(token.revenueShareHistory(USER_A, 0)).rejects.toMatchObject({ code: 'token.history_list_limit_unset' });

    const first = await token.yieldHistory(USER_A, 2);
    const second = await token.yieldHistory(USER_A, 2, first.nextCursor ?? undefined);
    const yieldIds = [...first.items, ...second.items].map((item) => item.windowId);
    expect(yieldIds).toEqual(['w3', 'w2', 'w1']);
    expect(new Set(yieldIds).size).toBe(yieldIds.length);
    expect(second.nextCursor).toBeNull();
    expect(first.items[0]).toMatchObject({
      windowId: 'w3',
      amount: '3.75',
      assetId: 'IFC',
      ledgerTxId: posted.get(`${USER_A}:w3`)!.id,
      reason: null,
    });
    const bee = await token.yieldHistory(USER_B, 10);
    expect(bee.items.map((item) => item.windowId)).toEqual(['b1']);
    expect(bee.items.some((item) => item.windowId.startsWith('w'))).toBe(false);

    const shareFirst = await token.revenueShareHistory(USER_A, 2);
    const shareSecond = await token.revenueShareHistory(USER_A, 2, shareFirst.nextCursor ?? undefined);
    const shareIds = [...shareFirst.items, ...shareSecond.items].map((item) => item.windowId);
    expect(shareIds).toEqual(['w3', 'w2', 'w1']);
    expect(new Set(shareIds).size).toBe(3);
    expect(shareSecond.nextCursor).toBeNull();
    for (const item of [...shareFirst.items, ...shareSecond.items]) {
      const book = posted.get(`${USER_A}:${item.windowId}`)!;
      expect(item.amount).toBe(book.amount);
      expect(item.ledgerTxId).toBe(book.id);
      expect(item.assetId).toBe('IFC');
      expect(item.reason).toBeNull();
    }
    const shareB = await token.revenueShareHistory(USER_B, 10);
    expect(shareB.items.map((item) => item.windowId)).toEqual(['b1']);
    expect(shareB.items[0]!.ledgerTxId).toBe(posted.get(`${USER_B}:b1`)!.id);

    await sql`UPDATE token.yield_payouts SET amount = '999'::numeric WHERE window_id = 'w1' AND user_id = ${USER_A}`;
    const drifted = await token.revenueShareHistory(USER_A, 10);
    expect(drifted.items.find((item) => item.windowId === 'w1')!.amount).toBe('1.25');
    const tableYield = await token.yieldHistory(USER_A, 10);
    expect(tableYield.items.find((item) => item.windowId === 'w1')!.amount).toBe('999');
  });

  it('lists recorded vote weight after the stake changes, and hides another user', async () => {
    const proposals = [
      { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', title: 'Alpha', weight: '12.5', choice: 'for', at: '2026-06-01T00:00:00.000001Z' },
      { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', title: 'Beta', weight: '7', choice: 'against', at: '2026-06-02T00:00:00.000001Z' },
      { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3', title: 'Gamma', weight: '1', choice: 'abstain', at: '2026-06-03T00:00:00.000001Z' },
    ] as const;
    for (const proposal of proposals) {
      await sql`
        INSERT INTO token.proposals (id, kind, body, status, opens_at, closes_at)
        VALUES (
          ${proposal.id}, 'fee_param', ${sql.json({ title: proposal.title })}, 'open',
          '2026-06-01T00:00:00Z', '2026-07-01T00:00:00Z'
        )
      `;
      await sql`
        INSERT INTO token.governance_votes (id, proposal_id, user_id, weight, choice, cast_at)
        VALUES (${crypto.randomUUID()}, ${proposal.id}, ${USER_A}, ${proposal.weight}::numeric, ${proposal.choice}, ${proposal.at}::timestamptz)
      `;
    }
    const hidden = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4';
    await sql`
      INSERT INTO token.proposals (id, kind, body, status, opens_at, closes_at)
      VALUES (${hidden}, 'grant', ${sql.json({ title: 'Hidden' })}, 'open', '2026-06-01T00:00:00Z', '2026-07-01T00:00:00Z')
    `;
    await sql`
      INSERT INTO token.governance_votes (id, proposal_id, user_id, weight, choice, cast_at)
      VALUES (${crypto.randomUUID()}, ${hidden}, ${USER_B}, '99'::numeric, 'for', '2026-06-04T00:00:00.000001Z')
    `;
    await sql`
      INSERT INTO token.stakes (id, user_id, amount, tier, multiplier_bps, started_at, unlocks_at, status)
      VALUES (${crypto.randomUUID()}, ${USER_A}, '1'::numeric, 'flex', 10000, now(), NULL, 'active')
    `;
    await sql`UPDATE token.stakes SET amount = '999'::numeric WHERE user_id = ${USER_A}`;

    const first = await token.myVotes(USER_A, 2);
    const second = await token.myVotes(USER_A, 2, first.nextCursor ?? undefined);
    const votes = [...first.items, ...second.items];
    expect(votes.map((vote) => vote.proposalId)).toEqual([proposals[2]!.id, proposals[1]!.id, proposals[0]!.id]);
    expect(new Set(votes.map((vote) => vote.proposalId)).size).toBe(3);
    expect(second.nextCursor).toBeNull();
    expect(votes.map((vote) => [vote.title, vote.weight, vote.choice])).toEqual([
      ['Gamma', '1', 'abstain'],
      ['Beta', '7', 'against'],
      ['Alpha', '12.5', 'for'],
    ]);
    const other = await token.myVotes(USER_B, 10);
    expect(other.items.map((vote) => vote.proposalId)).toEqual([hidden]);
    expect(other.items[0]!.weight).toBe('99');
  });

  it('lists an approval, a weighted and a ranked ballot through the router, each with its stored ballot and no basic choice', async () => {
    const votes = [
      { n: 1, type: 'approval', choice: null, ballot: { kind: 'pick', choices: [0, 2] } },
      {
        n: 2,
        type: 'weighted',
        choice: null,
        ballot: {
          kind: 'split',
          parts: [
            { choice: 0, bps: 6_000 },
            { choice: 1, bps: 4_000 },
          ],
        },
      },
      { n: 3, type: 'ranked_choice', choice: null, ballot: { kind: 'pick', choices: [2, 0, 1] } },
      { n: 4, type: 'approval', choice: null, ballot: { kind: 'abstain' } },
      { n: 5, type: 'basic', choice: 'for', ballot: null },
    ] as const;
    const idOf = (n: number) => `bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb${n}`;
    for (const vote of votes) {
      await sql`
        INSERT INTO token.proposals (id, kind, body, status, opens_at, closes_at, voting_type, choices)
        VALUES (
          ${idOf(vote.n)}, 'fee_param', ${sql.json({ title: `TEST ${vote.type} ${vote.n}` })}, 'open',
          '2026-06-01T00:00:00Z', '2026-07-01T00:00:00Z', ${vote.type}, ${vote.type === 'basic' ? null : sql.json(['A', 'B', 'C'])}
        )
      `;
      await sql`
        INSERT INTO token.governance_votes (id, proposal_id, user_id, weight, choice, ballot, cast_at)
        VALUES (
          ${crypto.randomUUID()}, ${idOf(vote.n)}, ${USER_A}, '3'::numeric, ${vote.choice},
          ${vote.ballot === null ? null : sql.json(vote.ballot)}, ${`2026-06-0${vote.n}T00:00:00.000001Z`}::timestamptz
        )
      `;
    }

    const page = await createTokenRouter(token).createCaller(signedReader(USER_A)).myVotes({ limit: 10 });
    expect(page.nextCursor).toBeNull();
    expect(page.items.map((vote) => [vote.proposalId, vote.title, vote.votingType, vote.choice, vote.ballot, vote.weight])).toEqual(
      [...votes].reverse().map((vote) => [idOf(vote.n), `TEST ${vote.type} ${vote.n}`, vote.type, vote.choice, vote.ballot, '3']),
    );
  });

  it('refuses my vote history with a typed precondition, not a 500 or a bad request, when a stored ballot cannot be read', async () => {
    const id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb9';
    await sql`
      INSERT INTO token.proposals (id, kind, body, status, opens_at, closes_at, voting_type, choices)
      VALUES (${id}, 'fee_param', ${sql.json({ title: 'TEST unreadable' })}, 'open', '2026-06-01T00:00:00Z', '2026-07-01T00:00:00Z',
              'approval', ${sql.json(['A', 'B'])})
    `;
    await sql`
      INSERT INTO token.governance_votes (id, proposal_id, user_id, weight, choice, ballot, cast_at)
      VALUES (${crypto.randomUUID()}, ${id}, ${USER_A}, '3'::numeric, NULL, ${sql.json({ kind: 'pick', choices: 'A' })}, now())
    `;
    await expect(createTokenRouter(token).createCaller(signedReader(USER_A)).myVotes({ limit: 10 })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'A vote recorded by this service could not be read.',
      cause: { code: 'token.vote_history_unreadable' },
    });
  });

  it('returns blank emission parameters as null and projects epochs with epochReward without writing a row', async () => {
    await expect(scheduled.emissionSchedule(undefined)).rejects.toMatchObject({ code: 'token.emission_schedule_count_unset' });
    const blank = await scheduled.emissionSchedule(3);
    expect(blank.params).toBeNull();
    expect(blank.epochs).toBeNull();
    expect(blank.reason).toBe('token.params_unset');
    expect(blank.missing).toBe('token_params.total_supply');
    expect(await sql`SELECT epoch FROM token.emission_epochs`).toHaveLength(0);

    const params: EmissionParams = {
      initialEpochReward: amt('10.5'),
      halvingIntervalEpochs: 4,
      maxSupply: amt('100'),
    };
    await sql`
      UPDATE token.token_params
         SET total_supply = ${formatAmount(params.maxSupply)}::numeric,
             halving_interval = ${params.halvingIntervalEpochs},
             emission_curve = ${sql.json({ initialEpochReward: formatAmount(params.initialEpochReward) })}
       WHERE id = true
    `;
    await sql`
      INSERT INTO token.emission_epochs (epoch, scheduled_amount, mined_amount, closed)
      VALUES (0, '1'::numeric, '1'::numeric, true)
    `;
    const before = await sql`SELECT epoch FROM token.emission_epochs`;
    const view = await scheduled.emissionSchedule(2);
    expect(await sql`SELECT epoch FROM token.emission_epochs`).toEqual(before);
    expect(view.reason).toBeNull();
    expect(view.missing).toBeNull();
    expect(view.params).toEqual({
      initialEpochReward: formatAmount(params.initialEpochReward),
      halvingIntervalEpochs: params.halvingIntervalEpochs,
      maxSupply: formatAmount(params.maxSupply),
    });
    expect(view.epochs).toEqual([
      { epoch: 1, reward: formatAmount(epochReward(1, params)) },
      { epoch: 2, reward: formatAmount(epochReward(2, params)) },
    ]);
  });
});
