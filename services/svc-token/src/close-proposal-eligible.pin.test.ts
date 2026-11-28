import { describe, expect, it } from 'vitest';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, parseAmount as amt, recipes } from '@intafaced/ledger-client';
import { DEFAULT_BUYBACK_PARAMS } from './economics/buyback.js';
import { DEFAULT_EMISSION_PARAMS } from './economics/emission.js';
import { recordingSql, type RecordedQuery } from './sql-recorder.testkit.js';
import { TokenService } from './token-service.js';

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const STAKE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const STAKE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const UNFUNDED = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const PROPOSAL_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OPENS_AT = new Date('2026-07-15T00:00:00.000Z');
const CLOSES_AT = new Date('2026-07-22T00:00:00.000Z');

const PROPOSAL = {
  id: PROPOSAL_ID,
  kind: 'fee_param' as const,
  body: {},
  status: 'open' as const,
  opens_at: OPENS_AT,
  closes_at: CLOSES_AT,
  created_at: OPENS_AT,
};

/** Pots on the ledger: A 1000, B 500. The table's active rows and the ballot's snapshot are what each test claims. */
async function closeWith(opts: {
  active: Array<{ id: string; user_id: string; amount: string }>;
  eligible: string;
  votes: Array<{ choice: string; weight: string; n: string }>;
}) {
  const ledger = new MemoryLedger();
  for (const [stakeId, userId, amount] of [
    [STAKE_A, USER_A, '1000'],
    [STAKE_B, USER_B, '500'],
  ] as const) {
    await ledger.post(recipes.deposit({ userId, assetId: 'IFC', amount: amt(amount), rail: 'test', railRef: `${userId}:${amount}` }));
    await ledger.post(recipes.stake({ stakeId, userId, assetId: 'IFC', amount: amt(amount), tier: 'flex' }));
  }
  const updates: string[] = [];
  const answer = (q: RecordedQuery): unknown[] => {
    if (q.text.includes('UPDATE token.proposals')) {
      updates.push(String(q.values[0]));
      return [];
    }
    if (q.text.includes('FROM token.proposals')) return [PROPOSAL];
    if (q.text.includes('eligible_stake')) return [{ missing: '0', eligible: opts.eligible }];
    if (q.text.includes('FROM token.governance_votes')) return opts.votes;
    if (q.text.includes('FROM token.stakes')) return opts.active;
    throw new Error(`unexpected query: ${q.text}`);
  };
  const { sql, queries } = recordingSql(answer);
  const token = new TokenService(sql, ledger, new MemoryEventBus('svc-token'), {
    assetId: 'IFC',
    emission: DEFAULT_EMISSION_PARAMS,
    buyback: DEFAULT_BUYBACK_PARAMS,
    loadParamsFromDb: false,
    feeScheduleTtlMs: 0,
    governanceQuorumBps: 1000,
    governanceThresholdBps: 5000,
  });
  return { close: () => token.closeProposal({ proposalId: PROPOSAL_ID, now: CLOSES_AT }), updates, queries };
}

const AGREEING = [
  { id: STAKE_A, user_id: USER_A, amount: '1000' },
  { id: STAKE_B, user_id: USER_B, amount: '500' },
];

describe('token.closeProposal eligible is ledger-backed', () => {
  it('refuses table/ledger drift in either direction, or a claim with no pot, and writes no outcome', async () => {
    for (const active of [
      [AGREEING[0]!, { ...AGREEING[1]!, amount: '10000' }],
      [AGREEING[0]!, { ...AGREEING[1]!, amount: '499' }],
      [{ ...AGREEING[0]!, amount: '999' }],
      [...AGREEING, { id: UNFUNDED, user_id: USER_B, amount: '1' }],
    ]) {
      const run = await closeWith({ active, eligible: '1500', votes: [{ choice: 'for', weight: '1000', n: '1' }] });
      await expect(run.close(), JSON.stringify(active)).rejects.toMatchObject({ code: 'token.stake_ledger_mismatch' });
      expect(run.updates).toEqual([]);
    }
  });

  it('reads the quorum bar from the ballot snapshot, not from a sum of the live rows', async () => {
    // Live pots total 1500; the snapshot says 10000, so 10% quorum needs 1000 voted. 900 misses it.
    const missed = await closeWith({ active: AGREEING, eligible: '10000', votes: [{ choice: 'for', weight: '900', n: '1' }] });
    await expect(missed.close()).resolves.toMatchObject({ status: 'rejected' });
    expect(missed.updates).toEqual(['rejected']);

    // The same ballot with 1000 voted meets the snapshot's bar.
    const met = await closeWith({ active: AGREEING, eligible: '10000', votes: [{ choice: 'for', weight: '1000', n: '1' }] });
    await expect(met.close()).resolves.toMatchObject({ status: 'passed' });
    expect(met.updates).toEqual(['passed']);

    // It checks every active claim (all users), not only voters, against its pot.
    const read = met.queries.find((q) => q.text.includes('FROM token.stakes'));
    expect(read?.text).toMatch(/SELECT id, user_id, amount/);
    expect(read?.text).toMatch(/status = 'active'/);
  });
});
