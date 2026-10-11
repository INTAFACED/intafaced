import { describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, parseAmount as amt, recipes } from '@intafaced/ledger-client';
import { DEFAULT_BUYBACK_PARAMS } from './economics/buyback.js';
import { DEFAULT_EMISSION_PARAMS } from './economics/emission.js';
import { TokenService } from './token-service.js';

/**
 * Ledger-backed closeProposal eligible without PG: MemoryLedger is the book,
 * sql is only the claim index + proposal rows. Fail-first: inflating an
 * active row used to change the quorum bar off a number the book does not hold.
 */

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const STAKE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const STAKE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
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

function sqlClose(opts: {
  active: Array<{ id: string; user_id: string; amount: string }>;
  votes?: Array<{ choice: string; weight: string; n: string }>;
  /** Electorate snapshotted on the ballot. Distinct from the live active rows. */
  eligible?: string;
  onUpdate?: (status: string) => void;
}): Sql {
  const fn = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = strings.join(' ');
    if (q.includes('UPDATE token.proposals')) {
      opts.onUpdate?.(String(values[0]));
      return Promise.resolve([]);
    }
    if (q.includes('FROM token.proposals')) {
      return Promise.resolve([PROPOSAL]);
    }
    if (q.includes('eligible_stake')) {
      return Promise.resolve([{ missing: '0', eligible: opts.eligible ?? '1500' }]);
    }
    if (q.includes('FROM token.governance_votes')) {
      return Promise.resolve(opts.votes ?? [{ choice: 'for', weight: '1000', n: '1' }]);
    }
    if (q.includes('FROM token.stakes')) {
      return Promise.resolve(opts.active);
    }
    throw new Error(`unexpected query: ${q}`);
  };
  return Object.assign(fn, {
    json: (v: unknown) => v,
    begin: async (_isolation: string, cb: (tx: unknown) => Promise<unknown>) => cb(fn),
  }) as unknown as Sql;
}

async function fundedCloseService(
  active: Array<{ id: string; user_id: string; amount: string }>,
  onUpdate?: (status: string) => void,
  ballot?: { eligible?: string; votes?: Array<{ choice: string; weight: string; n: string }> },
) {
  const ledger = new MemoryLedger();
  await ledger.post(
    recipes.deposit({
      userId: USER_A,
      assetId: 'IFC',
      amount: amt('1000'),
      rail: 'test',
      railRef: `${USER_A}:1000`,
    }),
  );
  await ledger.post(
    recipes.stake({
      stakeId: STAKE_A,
      userId: USER_A,
      assetId: 'IFC',
      amount: amt('1000'),
      tier: 'flex',
    }),
  );
  await ledger.post(
    recipes.deposit({
      userId: USER_B,
      assetId: 'IFC',
      amount: amt('500'),
      rail: 'test',
      railRef: `${USER_B}:500`,
    }),
  );
  await ledger.post(
    recipes.stake({
      stakeId: STAKE_B,
      userId: USER_B,
      assetId: 'IFC',
      amount: amt('500'),
      tier: 'flex',
    }),
  );
  const token = new TokenService(
    sqlClose({ active, onUpdate, eligible: ballot?.eligible, votes: ballot?.votes }),
    ledger,
    new MemoryEventBus('svc-token'),
    {
      assetId: 'IFC',
      emission: DEFAULT_EMISSION_PARAMS,
      buyback: DEFAULT_BUYBACK_PARAMS,
      loadParamsFromDb: false,
      feeScheduleTtlMs: 0,
      governanceQuorumBps: 1000,
      governanceThresholdBps: 5000,
    },
  );
  return token;
}

describe('closeProposal eligible gates on ledger pots', () => {
  it('closes from the snapshotted eligible stake when every active row agrees', async () => {
    let written: string | undefined;
    const token = await fundedCloseService(
      [
        { id: STAKE_A, user_id: USER_A, amount: '1000' },
        { id: STAKE_B, user_id: USER_B, amount: '500' },
      ],
      (status) => {
        written = status;
      },
    );
    const closed = await token.closeProposal({ proposalId: PROPOSAL_ID, now: CLOSES_AT });
    expect(closed.status).toBe('passed');
    expect(written).toBe('passed');
  });

  it('refuses close when an active row is inflated — no drifted quorum bar', async () => {
    let written: string | undefined;
    const token = await fundedCloseService(
      [
        { id: STAKE_A, user_id: USER_A, amount: '1000' },
        { id: STAKE_B, user_id: USER_B, amount: '10000' },
      ],
      (status) => {
        written = status;
      },
    );
    await expect(token.closeProposal({ proposalId: PROPOSAL_ID, now: CLOSES_AT })).rejects.toMatchObject({
      code: 'token.stake_ledger_mismatch',
    });
    expect(written).toBeUndefined();
  });

  it('does not let a smaller live pot clear a quorum the snapshot missed', async () => {
    let written: string | undefined;
    const token = await fundedCloseService(
      [{ id: STAKE_A, user_id: USER_A, amount: '1000' }],
      (status) => {
        written = status;
      },
      { eligible: '1500', votes: [{ choice: 'for', weight: '100', n: '1' }] },
    );
    const closed = await token.closeProposal({ proposalId: PROPOSAL_ID, now: CLOSES_AT });
    expect(closed.status).toBe('rejected');
    expect(written).toBe('rejected');
  });

  it('does not let a larger live pot raise the bar over the snapshot', async () => {
    let written: string | undefined;
    const token = await fundedCloseService(
      [
        { id: STAKE_A, user_id: USER_A, amount: '1000' },
        { id: STAKE_B, user_id: USER_B, amount: '500' },
      ],
      (status) => {
        written = status;
      },
      { eligible: '1000', votes: [{ choice: 'for', weight: '120', n: '1' }] },
    );
    const closed = await token.closeProposal({ proposalId: PROPOSAL_ID, now: CLOSES_AT });
    expect(closed.status).toBe('passed');
    expect(written).toBe('passed');
  });
});
