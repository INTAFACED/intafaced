import { describe, expect, it } from 'vitest';
import { checkDays, checkLeadReason, parseApplication, parsePooledMasters, parseQueue, splitAccountIds } from './copy-lead';
import { copyLeadPayloadHash } from './copy-lead-hash';

const APPLICATION = '55555555-5555-4555-8555-555555555555';
const ROW = {
  id: APPLICATION,
  kind: 'lead',
  userId: '33333333-3333-4333-8333-333333333333',
  displayName: 'TEST lead',
  status: 'pending',
  appliedAt: '2026-10-29T10:00:00.000Z',
  approvalId: null,
  proposedBy: null,
  reason: null,
  leaderRef: null,
  contact: null,
  style: null,
};
const MASTER = { ...ROW, kind: 'pool_master', displayName: 'TEST master', contact: 'TEST chat', style: 'TEST majors' };
const POOL = {
  poolId: '66666666-6666-4666-8666-666666666666',
  masterUserId: ROW.userId,
  applicationId: APPLICATION,
  name: 'TEST pool',
  strategyType: 'stable',
  limits: { maxLeverage: '3', maxDrawdownPct: '20', maxCapital: '100000' },
  state: 'strategy_creation',
  createdAt: '2026-11-04T10:00:00.000Z',
};

describe('copy lead approval hash', () => {
  // The same vector is pinned in services/svc-trade/src/copy/lead-applications.test.ts: svc-trade recomputes it when the
  // second founder confirms, so the console and the service must agree byte for byte.
  it('matches svc-trade', () => {
    expect(copyLeadPayloadHash({ applicationId: APPLICATION, displayName: 'TEST lead', minTrackRecordDays: 30 })).toBe(
      'sha256:fd978f4c6658cd9c150d2288f77639d25a36bee02de2c72a5247ba15b111f39f',
    );
  });

  it('changes with the criteria and the name it lists under', () => {
    const base = { applicationId: APPLICATION, displayName: 'TEST lead', minTrackRecordDays: 30 };
    expect(copyLeadPayloadHash({ ...base, minTrackRecordDays: 7 })).not.toBe(copyLeadPayloadHash(base));
    expect(copyLeadPayloadHash({ ...base, displayName: 'TEST other' })).not.toBe(copyLeadPayloadHash(base));
  });
});

describe('copy lead reads', () => {
  it('reads a queue with unset criteria and refuses a malformed one', () => {
    expect(parseQueue({ applications: [ROW], criteria: null })).toEqual({ applications: [ROW], criteria: null });
    expect(parseQueue({ applications: [{ ...ROW, status: 'listed' }], criteria: null })).toBeNull();
    expect(parseQueue({ applications: [ROW], criteria: { minTrackRecordDays: '30', setBy: 'a', setAt: 'b' } })).toBeNull();
    expect(parseApplication({ ...ROW, approvalId: 7 })).toBeNull();
  });

  it('takes the minimum track record as whole days, 0 to 3650, and a reason of 3 to 500 characters', () => {
    expect(checkDays('30')).toEqual({ ok: true, days: 30 });
    expect(checkDays('0')).toEqual({ ok: true, days: 0 });
    for (const bad of ['', '3651', '1.5', '-1', '030', 30]) expect(checkDays(bad).ok).toBe(false);
    expect(checkLeadReason('  TEST reason  ')).toEqual({ ok: true, reason: 'TEST reason' });
    expect(checkLeadReason('no').ok).toBe(false);
    expect(checkLeadReason('x'.repeat(501)).ok).toBe(false);
  });
});

describe('pooled masters reads', () => {
  const read = {
    applications: [MASTER],
    pools: [POOL],
    whitelists: [
      {
        poolId: POOL.poolId,
        poolName: 'TEST pool',
        masterUserId: ROW.userId,
        members: [{ userId: ROW.userId, addedAt: 'x', addedBy: 'y' }],
      },
    ],
    batchLimit: 20,
  };

  it('reads master applications, pools, whitelists and the batch limit; unset reads as null; anything malformed is refused', () => {
    expect(parsePooledMasters(read)).toEqual(read);
    expect(parsePooledMasters({ ...read, batchLimit: null })?.batchLimit).toBeNull();
    expect(parsePooledMasters({ ...read, batchLimit: '20' })).toBeNull();
    expect(parsePooledMasters({ ...read, applications: [{ ...MASTER, kind: 'other' }] })).toBeNull();
    expect(parsePooledMasters({ ...read, pools: [{ ...POOL, strategyType: 'wild' }] })).toBeNull();
    expect(parsePooledMasters({ ...read, whitelists: [{ ...read.whitelists[0], members: [{ userId: 1 }] }] })).toBeNull();
  });

  it('splits pasted account ids on lines, commas and spaces, once each, lower case', () => {
    expect(splitAccountIds(' A-1,\nb-2  a-1;;c-3 ')).toEqual(['a-1', 'b-2', 'c-3']);
    expect(splitAccountIds(['x', 'y x'])).toEqual(['x', 'y']);
    expect(splitAccountIds(7)).toEqual([]);
  });
});
