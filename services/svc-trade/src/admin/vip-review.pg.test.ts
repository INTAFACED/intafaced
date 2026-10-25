/**
 * Compliance review of VIP applications on Postgres (SP-fees-vip-04 part 2, J-cex-spot-10 #7): a decision needs a second
 * operator's approval bound to it, an approval with no trial published leaves `approved_no_trial` and the grant refuses
 * `vip.trial_unset`, a trial granted is the tier an order is charged at while it lasts, the same approval again answers
 * what it decided, and every refusal writes nothing. TEST rules, a TEST key and TEST people only.
 */
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthError } from '@intafaced/auth';
import type { TestDatabase } from '@intafaced/db';
import { parseFeeScheduleJson, type OwnerFeeSchedule } from '../spot/fee-schedule.js';
import { feeTierAt } from '../spot/fee-tier-store.js';
import { tierSnapshotKey } from '../spot/fee-tiers.js';
import { VipApplicationStore } from '../spot/vip-applications.js';
import { principalFor } from '../spot/testing.js';
import { ALICE, BOB, openTradeDatabase } from '../spot/__tests__/saga-trade-fixture.js';
import { MemoryApprovalBook, payloadHash, TradeOpsError } from './common.js';
import {
  VIP_REVIEW_ACTION,
  VIP_TRIAL_GRANT_ACTION,
  VipReviewAdmin,
  vipReviewPayload,
  vipTrialGrantPayload,
  type VipDecision,
} from './vip-review.js';

const KEY = Buffer.alloc(32, 7);
const PDF = Buffer.from('%PDF-1.7 TEST proof of status, never a real statement');
const OP = '33333333-3333-4333-8333-333333333333';
const APPROVER = '44444444-4444-4444-8444-444444444444';
const writer = () => principalFor(OP, ['admin:read', 'admin:write', 'admin:compliance']);
const compliance = () => principalFor(OP, ['admin:read', 'admin:compliance']);
const REASON = 'TEST statement checked against the venue';
const DAY = 86_400_000;

const schedule = (trial: unknown): OwnerFeeSchedule =>
  parseFeeScheduleJson(
    JSON.stringify({
      published: true,
      version: 'test-vip-review',
      defaultPairGroup: 'g',
      rows: ['regular', 'test-vip-1', 'test-vip-2'].map((tierId, i) => ({
        pairGroup: 'g',
        tierId,
        zeroFee: false,
        makerBps: String(8 - i),
        takerBps: String(10 - i),
        minFee: null,
      })),
      tierProgram: {
        thresholds: [
          { tierId: 'test-vip-1', minVolume30d: '1000' },
          { tierId: 'test-vip-2', minVolume30d: '5000' },
        ],
        volumeQuotes: ['USDT'],
        snapshotTimeUtc: null,
        downgradeGraceDays: null,
        subAccounts: null,
        botsAndCopy: null,
        application: { proofTypes: ['application/pdf'], maxBytes: 4096 },
        trial,
      },
    }),
  );
const NO_TRIAL = schedule(null);
const TRIAL = schedule({ tierId: 'test-vip-2', days: 30 });

let db: TestDatabase | undefined;
let stop: () => Promise<void> = async () => undefined;
const sql = () => {
  if (!db) throw new Error('database not ready');
  return db.sql;
};

beforeAll(async () => {
  const opened = await openTradeDatabase();
  db = opened.db;
  stop = opened.stop;
}, 120_000);
afterAll(async () => {
  await db?.drop();
  await stop();
}, 30_000);
beforeEach(async () => {
  for (const [table, trigger] of [
    ['vip_trials', 'vip_trials_append_only_trg'],
    ['vip_application_events', 'vip_application_events_append_only_trg'],
    ['vip_applications', 'vip_applications_status_only_trg'],
    ['vip_applications', 'vip_applications_status_forward_trg'],
  ] as const) {
    await sql().unsafe(`ALTER TABLE trade.${table} DISABLE TRIGGER ${trigger}`);
  }
  await sql()`TRUNCATE trade.vip_trials, trade.vip_application_events, trade.vip_applications, trade.operator_audit,
    trade.fee_tier_snapshots, trade.fee_tier_snapshot_runs`;
  for (const [table, trigger] of [
    ['vip_trials', 'vip_trials_append_only_trg'],
    ['vip_application_events', 'vip_application_events_append_only_trg'],
    ['vip_applications', 'vip_applications_status_only_trg'],
    ['vip_applications', 'vip_applications_status_forward_trg'],
  ] as const) {
    await sql().unsafe(`ALTER TABLE trade.${table} ENABLE TRIGGER ${trigger}`);
  }
});

let clock = new Date('2026-10-25T03:00:00.000Z');
function desk(fees: OwnerFeeSchedule, approvals = new MemoryApprovalBook(), key: Buffer | null = KEY) {
  return { approvals, admin: new VipReviewAdmin({ sql: sql(), approvals, proofKey: key, scheduleAt: async () => fees, now: () => clock }) };
}

async function apply(userId: string = ALICE, requestId = 'vip-request-1'): Promise<string> {
  const store = new VipApplicationStore(sql(), KEY);
  const { application } = await store.submit(userId, { proofTypes: ['application/pdf'], maxBytes: 4096 }, 'test-vip-review', {
    requestId,
    fileName: 'statement.pdf',
    contentType: 'application/pdf',
    bytesBase64: PDF.toString('base64'),
  });
  return application.id;
}

let approvalSeq = 0;
/** A consumable approval for a review, bound as the door binds it; `approverId` may be overridden to test four eyes. */
function approveReview(
  approvals: MemoryApprovalBook,
  applicationId: string,
  decision: VipDecision,
  trial: unknown,
  { approverId = APPROVER, reason = REASON } = {},
): { approvalId: string; operationId: string } {
  const approvalId = `approval-${++approvalSeq}`;
  const operationId = `operation-${approvalSeq}`;
  approvals.put({
    approvalId,
    actionType: VIP_REVIEW_ACTION,
    targetService: 'svc-trade',
    targetId: applicationId,
    expectedVersion: 'pending',
    payloadHash: payloadHash(vipReviewPayload({ applicationId, decision, reason, trial: trial as never })),
    requesterId: OP,
    approverId,
    operationId,
  });
  return { approvalId, operationId };
}

function approveGrant(approvals: MemoryApprovalBook, applicationId: string, trial: { tierId: string; days: number }) {
  const approvalId = `approval-${++approvalSeq}`;
  const operationId = `operation-${approvalSeq}`;
  approvals.put({
    approvalId,
    actionType: VIP_TRIAL_GRANT_ACTION,
    targetService: 'svc-trade',
    targetId: applicationId,
    expectedVersion: 'approved_no_trial',
    payloadHash: payloadHash(vipTrialGrantPayload({ applicationId, reason: REASON, trial })),
    requesterId: OP,
    approverId: APPROVER,
    operationId,
  });
  return { approvalId, operationId };
}

const counts = async () => {
  const [row] = await sql()<Array<{ events: number; trials: number; audits: number }>>`
    SELECT (SELECT count(*)::int FROM trade.vip_application_events) AS events,
           (SELECT count(*)::int FROM trade.vip_trials) AS trials,
           (SELECT count(*)::int FROM trade.operator_audit) AS audits`;
  return row!;
};

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof TradeOpsError) return error.code;
    if (error instanceof AuthError) return error.code;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('deciding a VIP application', () => {
  it('rejects with a second operator: the event names both, the audit row too, and no trial', async () => {
    const { admin, approvals } = desk(TRIAL);
    const id = await apply();
    const result = await admin.review(writer(), {
      applicationId: id,
      decision: 'reject',
      reason: REASON,
      ...approveReview(approvals, id, 'reject', null),
    });
    expect(result.application.status).toBe('rejected');
    expect(result.application.trial).toBeNull();
    expect(result.trialRefusal).toBeNull();
    expect(result.application.events.map((e) => [e.status, e.actorRole, e.approverId])).toEqual([
      ['pending', 'applicant', null],
      ['rejected', 'compliance', APPROVER],
    ]);
    const [audit] = await sql()<Array<{ kind: string; approver_id: string; account_id: string }>>`
      SELECT kind, approver_id, account_id FROM trade.operator_audit`;
    expect(audit).toEqual({ kind: 'vip_application.review', approver_id: APPROVER, account_id: ALICE });
  });

  it('approves while no trial is published: approved_no_trial, and the grant refuses vip.trial_unset and changes nothing', async () => {
    const { admin, approvals } = desk(NO_TRIAL);
    const id = await apply();
    const result = await admin.review(writer(), {
      applicationId: id,
      decision: 'approve',
      reason: REASON,
      ...approveReview(approvals, id, 'approve', null),
    });
    expect(result.application.status).toBe('approved_no_trial');
    expect(result.trialRefusal).toBe('vip.trial_unset');
    expect(result.application.trial).toBeNull();

    const before = await counts();
    const grant = approveGrant(approvals, id, { tierId: 'test-vip-2', days: 30 });
    expect(await refusal(admin.grantTrial(writer(), { applicationId: id, reason: REASON, ...grant }))).toBe('vip.trial_unset');
    expect(await counts()).toEqual(before);
    const [row] = await sql()<Array<{ status: string }>>`SELECT status FROM trade.vip_applications WHERE id = ${id}`;
    expect(row!.status).toBe('approved_no_trial');
    // The refusal came before the approval: it is still there to use once the owner publishes a trial.
    const later = desk(TRIAL, approvals).admin;
    const granted = await later.grantTrial(writer(), { applicationId: id, reason: REASON, ...grant });
    expect(granted.application.status).toBe('approved');
    expect(granted.trialRefusal).toBeNull();
    expect(granted.application.trial).toMatchObject({ tierId: 'test-vip-2', days: 30, key: `vip-trial:${ALICE}:${id}` });
  });

  it('approves with a trial published: the trial is the tier an order is charged at until it ends', async () => {
    const { admin, approvals } = desk(TRIAL);
    const id = await apply();
    const trial = { tierId: 'test-vip-2', days: 30 };
    const result = await admin.review(writer(), {
      applicationId: id,
      decision: 'approve',
      reason: REASON,
      ...approveReview(approvals, id, 'approve', trial),
    });
    expect(result.application.status).toBe('approved');
    expect(result.application.trial).toMatchObject({
      ...trial,
      startsAt: clock.toISOString(),
      endsAt: new Date(clock.getTime() + 30 * DAY).toISOString(),
    });
    expect(await feeTierAt(sql(), TRIAL, ALICE, new Date(clock.getTime() + 1000))).toBe('test-vip-2');
    expect(await feeTierAt(sql(), TRIAL, ALICE, new Date(clock.getTime() + 30 * DAY))).toBe('regular');
    expect(await feeTierAt(sql(), TRIAL, BOB, new Date(clock.getTime() + 1000))).toBe('regular');
    // A programme that no longer names the trial's tier charges at regular.
    const renamed = schedule(null);
    if (renamed.published !== true || !renamed.tierProgram) throw new Error('no programme');
    const dropped: OwnerFeeSchedule = {
      ...renamed,
      tierProgram: { ...renamed.tierProgram, thresholds: renamed.tierProgram.thresholds.slice(0, 1) },
    };
    expect(await feeTierAt(sql(), dropped, ALICE, new Date(clock.getTime() + 1000))).toBe('regular');
  });

  it('charges the higher of the snapshot tier and the trial tier', async () => {
    const { admin, approvals } = desk(schedule({ tierId: 'test-vip-1', days: 7 }));
    const id = await apply();
    await admin.review(writer(), {
      applicationId: id,
      decision: 'approve',
      reason: REASON,
      ...approveReview(approvals, id, 'approve', { tierId: 'test-vip-1', days: 7 }),
    });
    const at = new Date(clock.getTime() + 1000);
    expect(await feeTierAt(sql(), TRIAL, ALICE, at)).toBe('test-vip-1');
    const day = new Date(clock.getTime() - DAY);
    const instant = day.toISOString();
    await sql()`INSERT INTO trade.fee_tier_snapshot_runs (instant, schedule_version, accounts, completed_at) VALUES (${instant}, 'v', 1, ${instant})`;
    await sql()`INSERT INTO trade.fee_tier_snapshots (key, instant, user_id, tier_id, volume_30d, counted_fills, schedule_version)
      VALUES (${tierSnapshotKey(day, ALICE)}, ${instant}, ${ALICE}, 'test-vip-2', '6000', 3, 'v')`;
    expect(await feeTierAt(sql(), TRIAL, ALICE, at)).toBe('test-vip-2');
  });

  it('answers the same approval again with what it decided, and refuses one consumed for another application', async () => {
    const { admin, approvals } = desk(TRIAL);
    const id = await apply();
    const other = await apply(BOB, 'vip-request-2');
    const ids = approveReview(approvals, id, 'reject', null);
    const first = await admin.review(writer(), { applicationId: id, decision: 'reject', reason: REASON, ...ids });
    const before = await counts();
    expect(await admin.review(writer(), { applicationId: id, decision: 'reject', reason: REASON, ...ids })).toEqual(first);
    expect(await counts()).toEqual(before);
    expect(await refusal(admin.review(writer(), { applicationId: other, decision: 'reject', reason: REASON, ...ids }))).toBe(
      'approval_reused',
    );
  });

  it('refuses an approval for another decision, reason or trial, and one the applier gave themselves, writing nothing', async () => {
    const { admin, approvals } = desk(TRIAL);
    const id = await apply();
    const before = await counts();
    const forReject = approveReview(approvals, id, 'reject', null);
    expect(await refusal(admin.review(writer(), { applicationId: id, decision: 'approve', reason: REASON, ...forReject }))).toBe(
      'approval_mismatch',
    );
    const otherTrial = approveReview(approvals, id, 'approve', { tierId: 'test-vip-1', days: 30 });
    expect(await refusal(admin.review(writer(), { applicationId: id, decision: 'approve', reason: REASON, ...otherTrial }))).toBe(
      'approval_mismatch',
    );
    const otherReason = approveReview(approvals, id, 'reject', null, { reason: 'TEST another reason' });
    expect(await refusal(admin.review(writer(), { applicationId: id, decision: 'reject', reason: REASON, ...otherReason }))).toBe(
      'approval_mismatch',
    );
    const self = approveReview(approvals, id, 'reject', null, { approverId: OP });
    expect(await refusal(admin.review(writer(), { applicationId: id, decision: 'reject', reason: REASON, ...self }))).toBe(
      'approval_mismatch',
    );
    expect(await counts()).toEqual(before);
  });

  it('refuses a decided application, a missing one, a short reason and a reader without admin:write', async () => {
    const { admin, approvals } = desk(TRIAL);
    const id = await apply();
    await admin.review(writer(), {
      applicationId: id,
      decision: 'reject',
      reason: REASON,
      ...approveReview(approvals, id, 'reject', null),
    });
    const again = approveReview(approvals, id, 'approve', { tierId: 'test-vip-2', days: 30 });
    expect(await refusal(admin.review(writer(), { applicationId: id, decision: 'approve', reason: REASON, ...again }))).toBe(
      'vip.application_decided',
    );
    const missing = '99999999-9999-4999-8999-999999999990';
    expect(await refusal(admin.review(writer(), { applicationId: missing, decision: 'reject', reason: REASON, ...again }))).toBe(
      'vip_application_not_found',
    );
    expect(await refusal(admin.review(writer(), { applicationId: id, decision: 'reject', reason: 'no', ...again }))).toBe(
      'reason_required',
    );
    const reader = principalFor(OP, ['admin:read']);
    expect(await refusal(admin.review(reader, { applicationId: id, decision: 'reject', reason: REASON, ...again }))).not.toBe('');
    expect(await refusal(admin.grantTrial(writer(), { applicationId: id, reason: REASON, ...again }))).toBe('vip.trial_not_owed');
  });

  it('refuses a decider without the compliance scope, writing nothing', async () => {
    const { admin, approvals } = desk(TRIAL);
    const id = await apply();
    const before = await counts();
    const ids = approveReview(approvals, id, 'reject', null);
    const writeOnly = principalFor(OP, ['admin:read', 'admin:write']);
    expect(await refusal(admin.review(writeOnly, { applicationId: id, decision: 'reject', reason: REASON, ...ids }))).toBe('scope.denied');
    expect(await counts()).toEqual(before);
  });

  it('answers the same approval sent twice at once with its one decision', async () => {
    const { admin, approvals } = desk(TRIAL);
    const id = await apply();
    const ids = approveReview(approvals, id, 'approve', { tierId: 'test-vip-2', days: 30 });
    // Identity answers a consume of the same approval and operation again, as the real one does.
    const once = approvals.consume.bind(approvals);
    let first: Awaited<ReturnType<typeof once>> | undefined;
    approvals.consume = async (input) => (first ??= await once(input));
    const both = await Promise.all([
      admin.review(writer(), { applicationId: id, decision: 'approve', reason: REASON, ...ids }),
      admin.review(writer(), { applicationId: id, decision: 'approve', reason: REASON, ...ids }),
    ]);
    expect(both.map((r) => r.application.status)).toEqual(['approved', 'approved']);
    expect(await counts()).toMatchObject({ events: 2, trials: 1 });
  });

  it('refuses the same approval sent again for another decision or reason', async () => {
    const { admin, approvals } = desk(TRIAL);
    const id = await apply();
    const ids = approveReview(approvals, id, 'reject', null);
    await admin.review(writer(), { applicationId: id, decision: 'reject', reason: REASON, ...ids });
    expect(await refusal(admin.review(writer(), { applicationId: id, decision: 'approve', reason: REASON, ...ids }))).toBe(
      'approval_mismatch',
    );
    expect(await refusal(admin.review(writer(), { applicationId: id, decision: 'reject', reason: 'TEST another reason', ...ids }))).toBe(
      'approval_mismatch',
    );
  });

  it('grants no second trial while one is in force, before any approval is consumed', async () => {
    const { admin, approvals } = desk(TRIAL);
    const trial = { tierId: 'test-vip-2', days: 30 };
    const first = await apply();
    await admin.review(writer(), {
      applicationId: first,
      decision: 'approve',
      reason: REASON,
      ...approveReview(approvals, first, 'approve', trial),
    });
    const second = await apply(ALICE, 'vip-request-2');
    const before = await counts();
    const ids = approveReview(approvals, second, 'approve', trial);
    expect(await refusal(admin.review(writer(), { applicationId: second, decision: 'approve', reason: REASON, ...ids }))).toBe(
      'vip.trial_active',
    );
    expect(await counts()).toEqual(before);
    // Once it has ended, a fresh review can grant one, with the approval that was not spent.
    clock = new Date(clock.getTime() + 31 * DAY);
    const granted = await admin.review(writer(), { applicationId: second, decision: 'approve', reason: REASON, ...ids });
    expect(granted.application.trial).toMatchObject(trial);
  });

  it('spans whole 24-hour days whatever the session time zone', async () => {
    const id = await apply();
    // A connection whose time zone has a clock change inside the trial: still exactly 30 × 24 hours, and the CHECK holds.
    const newYork = postgres(db!.url, { max: 1, connection: { TimeZone: 'America/New_York' } });
    try {
      const approvals = new MemoryApprovalBook();
      const admin = new VipReviewAdmin({
        sql: newYork,
        approvals,
        proofKey: KEY,
        scheduleAt: async () => schedule({ tierId: 'test-vip-1', days: 30 }),
        now: () => clock,
      });
      const at = clock;
      const result = await admin.review(writer(), {
        applicationId: id,
        decision: 'approve',
        reason: REASON,
        ...approveReview(approvals, id, 'approve', { tierId: 'test-vip-1', days: 30 }),
      });
      expect(Date.parse(result.application.trial!.endsAt) - at.getTime()).toBe(30 * DAY);
    } finally {
      await newYork.end();
    }
  });

  it('keeps the history forward-only: a decision cannot go back, and a trial row never changes', async () => {
    const { admin, approvals } = desk(TRIAL);
    const id = await apply();
    await admin.review(writer(), {
      applicationId: id,
      decision: 'approve',
      reason: REASON,
      ...approveReview(approvals, id, 'approve', { tierId: 'test-vip-2', days: 30 }),
    });
    await expect(sql()`UPDATE trade.vip_applications SET status = 'pending' WHERE id = ${id}`).rejects.toThrow(/cannot become/);
    await expect(sql()`UPDATE trade.vip_trials SET days = 366`).rejects.toThrow(/append-only/);
    await expect(sql()`DELETE FROM trade.vip_trials`).rejects.toThrow(/append-only/);
  });
});

describe('reading applications and proofs', () => {
  it('lists newest first by status, with the trial published now and whether proofs open', async () => {
    const { admin, approvals } = desk(TRIAL);
    const first = await apply();
    clock = new Date(clock.getTime() + 1000);
    const second = await apply(BOB, 'vip-request-2');
    await admin.review(writer(), {
      applicationId: first,
      decision: 'reject',
      reason: REASON,
      ...approveReview(approvals, first, 'reject', null),
    });
    const all = await admin.list(principalFor(OP, ['admin:read']), {});
    expect(all.trialRules).toEqual({ tierId: 'test-vip-2', days: 30 });
    expect(all.proofKeyed).toBe(true);
    expect(all.applications.map((a) => [a.userId, a.status])).toEqual(
      expect.arrayContaining([
        [ALICE, 'rejected'],
        [BOB, 'pending'],
      ]),
    );
    const pending = await admin.list(principalFor(OP, ['admin:read']), { status: 'pending' });
    expect(pending.applications.map((a) => a.id)).toEqual([second]);
    expect(JSON.stringify(pending)).not.toContain(PDF.toString('base64'));
    expect((await desk(NO_TRIAL).admin.list(principalFor(OP, ['admin:read']), {})).trialRules).toBeNull();
  });

  it('opens a proof for a stated reason and audits it; without the key it refuses by name', async () => {
    const { admin } = desk(TRIAL);
    const id = await apply();
    const proof = await admin.proof(compliance(), { applicationId: id, reason: REASON });
    expect(Buffer.from(proof.bytesBase64, 'base64').equals(PDF)).toBe(true);
    expect(proof).toMatchObject({ fileName: 'statement.pdf', contentType: 'application/pdf' });
    const audits = await sql()<
      Array<{ kind: string; object_id: string; reason: string }>
    >`SELECT kind, object_id, reason FROM trade.operator_audit`;
    expect(audits).toEqual([{ kind: 'vip_application.proof_view', object_id: id, reason: REASON }]);
    // An operator without the compliance scope opens nothing, and nothing more is audited.
    const writerOnly = principalFor(OP, ['admin:read', 'admin:write']);
    expect(await refusal(admin.proof(writerOnly, { applicationId: id, reason: REASON }))).toBe('scope.denied');
    expect(await sql()`SELECT 1 FROM trade.operator_audit`).toHaveLength(1);
    expect(await refusal(desk(TRIAL, undefined, null).admin.proof(compliance(), { applicationId: id, reason: REASON }))).toBe(
      'vip.proof_key_unset',
    );
    expect(
      await refusal(desk(TRIAL, undefined, Buffer.alloc(32, 1)).admin.proof(compliance(), { applicationId: id, reason: REASON })),
    ).toBe('vip.proof_unreadable');
  });
});
