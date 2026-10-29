/**
 * Applying to lead and the founders' lead desk on Postgres (CB-copy-12, CB-ops-01, J-copy-bots-otc-10): one open
 * application per person, the queue oldest first, approving refuses while the criteria are unset, approval needs a
 * second founder's approval bound to the application and lists the applicant once, a rejection keeps its reason for
 * the applicant, and every refusal writes nothing. TEST people and TEST names only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TestDatabase } from '@intafaced/db';
import { principalFor } from '../spot/testing.js';
import { ALICE, BOB, openTradeDatabase } from '../spot/__tests__/saga-trade-fixture.js';
import { truncateTradeExceptOrderEvents } from '../orders/order-events.js';
import { MemoryApprovalBook, payloadHash } from '../admin/common.js';
import { sqlLeaderDirectory } from './leader-directory.js';
import { COPY_LEAD_APPROVE_ACTION, LeadDesk, leadApprovalPayload } from './lead-applications.js';

const FOUNDER_A = '33333333-3333-4333-8333-333333333333';
const FOUNDER_B = '44444444-4444-4444-8444-444444444444';
const founder = (id: string) => principalFor(id, ['admin:read', 'admin:write']);
const reader = () => principalFor(FOUNDER_A, ['admin:read']);
const customer = (id: string) => principalFor(id, ['trade:read', 'trade:write']);

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
  await truncateTradeExceptOrderEvents(sql());
});

let tick = Date.parse('2026-10-29T00:00:00.000Z');
const now = () => new Date((tick += 1_000));

function harness() {
  const approvals = new MemoryApprovalBook();
  const directory = sqlLeaderDirectory(sql(), { now, feeShareLaw: { published: false } });
  return { approvals, desk: new LeadDesk({ sql: sql(), approvals, directory, now }) };
}

/** Founder A files identity's approval and records it; founder B approves it there. */
function fileApproval(approvals: MemoryApprovalBook, applicationId: string, displayName: string, minTrackRecordDays: number, id: string) {
  approvals.put({
    approvalId: id,
    actionType: COPY_LEAD_APPROVE_ACTION,
    targetService: 'svc-trade',
    targetId: applicationId,
    expectedVersion: 'pending',
    payloadHash: payloadHash(leadApprovalPayload({ applicationId, displayName, minTrackRecordDays })),
    requesterId: FOUNDER_A,
    approverId: FOUNDER_B,
    operationId: `op-${id}`,
  });
}

describe('lead applications', () => {
  it('keeps one open application per person: the same submit answers it, another name refuses', async () => {
    const { desk } = harness();
    const first = await desk.apply(customer(ALICE), { displayName: '  TEST lead   alpha ' });
    expect(first).toMatchObject({ state: 'submitted', displayName: 'TEST lead alpha', reason: null });
    const again = await desk.apply(customer(ALICE), { displayName: 'TEST lead alpha' });
    expect(again.applicationId).toBe(first.applicationId);
    await expect(desk.apply(customer(ALICE), { displayName: 'TEST lead beta' })).rejects.toMatchObject({
      code: 'trade.copy_lead_application_open',
    });
    await expect(desk.apply(customer(ALICE), { displayName: '   ' })).rejects.toMatchObject({ code: 'trade.copy_lead_name_invalid' });
    const [count] = await sql()<Array<{ n: number }>>`SELECT count(*)::int AS n FROM trade.copy_lead_applications`;
    expect(count!.n).toBe(1);
    expect(await desk.mine(customer(ALICE))).toMatchObject({ applicationId: first.applicationId, state: 'submitted' });
    expect(await desk.mine(customer(BOB))).toBeNull();
  });

  it('lists the queue oldest first, to operators only', async () => {
    const { desk } = harness();
    const a = await desk.apply(customer(ALICE), { displayName: 'TEST lead a' });
    const b = await desk.apply(customer(BOB), { displayName: 'TEST lead b' });
    const queue = await desk.queue(reader());
    expect(queue.applications.map((r) => r.id)).toEqual([a.applicationId, b.applicationId]);
    expect(queue.criteria).toBeNull();
    await expect(desk.queue(customer(ALICE))).rejects.toThrow();
  });

  it('refuses to approve while the criteria are unset, and writes nothing', async () => {
    const { desk } = harness();
    const a = await desk.apply(customer(ALICE), { displayName: 'TEST lead a' });
    await expect(desk.propose(founder(FOUNDER_A), { applicationId: a.applicationId, approvalId: 'appr-1' })).rejects.toMatchObject({
      code: 'trade.copy_lead_criteria_unset',
      message: 'The lead criteria are not set',
    });
    const [row] = await sql()<Array<{ status: string; approval_id: string | null }>>`
      SELECT status, approval_id FROM trade.copy_lead_applications WHERE id = ${a.applicationId}`;
    expect(row).toEqual({ status: 'pending', approval_id: null });
  });

  it('approves with a second founder, lists the applicant once, and answers the same confirm again', async () => {
    const { desk, approvals } = harness();
    const a = await desk.apply(customer(ALICE), { displayName: 'TEST lead a' });
    const criteria = await desk.setCriteria(founder(FOUNDER_A), { minTrackRecordDays: 30, clientRequestId: 'crit-1' });
    expect(criteria.minTrackRecordDays).toBe(30);
    await desk.setCriteria(founder(FOUNDER_A), { minTrackRecordDays: 30, clientRequestId: 'crit-1' });
    const [criteriaCount] = await sql()<Array<{ n: number }>>`SELECT count(*)::int AS n FROM trade.copy_lead_criteria`;
    const rows = criteriaCount!.n;
    expect(rows).toBe(1);

    fileApproval(approvals, a.applicationId, 'TEST lead a', 30, 'appr-1');
    const waiting = await desk.propose(founder(FOUNDER_A), { applicationId: a.applicationId, approvalId: 'appr-1' });
    expect(waiting).toMatchObject({ status: 'awaiting_second', proposedBy: FOUNDER_A });

    // The proposer cannot confirm their own approval.
    await expect(
      desk.approve(founder(FOUNDER_A), { applicationId: a.applicationId, approvalId: 'appr-1', operationId: 'op-appr-1' }),
    ).rejects.toMatchObject({ code: 'approval_mismatch' });

    const approved = await desk.approve(founder(FOUNDER_B), {
      applicationId: a.applicationId,
      approvalId: 'appr-1',
      operationId: 'op-appr-1',
    });
    expect(approved).toMatchObject({ status: 'approved', approverId: FOUNDER_B });
    expect(approved.leaderRef).toMatch(/^[0-9a-f]{32}$/);
    const again = await desk.approve(founder(FOUNDER_B), {
      applicationId: a.applicationId,
      approvalId: 'appr-1',
      operationId: 'op-appr-1',
    });
    expect(again.leaderRef).toBe(approved.leaderRef);

    const leads = await desk.leads(reader());
    expect(leads).toEqual([expect.objectContaining({ leaderRef: approved.leaderRef, displayName: 'TEST lead a', state: 'listed' })]);
    expect(await desk.mine(customer(ALICE))).toMatchObject({ state: 'approved' });
    await expect(desk.apply(customer(ALICE), { displayName: 'TEST lead a' })).rejects.toMatchObject({
      code: 'trade.copy_lead_already_leading',
    });
    const audit = await desk.audit(reader());
    expect(audit.map((r) => r.action)).toEqual(
      expect.arrayContaining(['copy_lead.criteria', 'copy_lead.propose', 'copy_lead.approve', 'leader.upsert']),
    );
  });

  it('refuses an approval bound to other criteria, and leaves the application waiting', async () => {
    const { desk, approvals } = harness();
    const a = await desk.apply(customer(ALICE), { displayName: 'TEST lead a' });
    await desk.setCriteria(founder(FOUNDER_A), { minTrackRecordDays: 30, clientRequestId: 'crit-1' });
    fileApproval(approvals, a.applicationId, 'TEST lead a', 7, 'appr-1');
    await desk.propose(founder(FOUNDER_A), { applicationId: a.applicationId, approvalId: 'appr-1' });
    await expect(
      desk.approve(founder(FOUNDER_B), { applicationId: a.applicationId, approvalId: 'appr-1', operationId: 'op-appr-1' }),
    ).rejects.toMatchObject({ code: 'approval_mismatch' });
    expect(await desk.leads(reader())).toEqual([]);
    const [row] = await sql()<Array<{ status: string }>>`SELECT status FROM trade.copy_lead_applications WHERE id = ${a.applicationId}`;
    expect(row?.status).toBe('awaiting_second');

    // A founder files a new approval for the criteria in force; it replaces the stale one, and only it is consumed.
    fileApproval(approvals, a.applicationId, 'TEST lead a', 30, 'appr-2');
    expect(await desk.propose(founder(FOUNDER_A), { applicationId: a.applicationId, approvalId: 'appr-2' })).toMatchObject({
      status: 'awaiting_second',
      approvalId: 'appr-2',
    });
    await expect(
      desk.approve(founder(FOUNDER_B), { applicationId: a.applicationId, approvalId: 'appr-1', operationId: 'op-appr-1' }),
    ).rejects.toMatchObject({ code: 'trade.copy_lead_application_decided' });
    expect(
      await desk.approve(founder(FOUNDER_B), { applicationId: a.applicationId, approvalId: 'appr-2', operationId: 'op-appr-2' }),
    ).toMatchObject({ status: 'approved', approvalId: 'appr-2' });
  });

  it('refuses an approval already spent elsewhere: nobody is listed on it', async () => {
    const { desk, approvals } = harness();
    const a = await desk.apply(customer(ALICE), { displayName: 'TEST lead a' });
    await desk.setCriteria(founder(FOUNDER_A), { minTrackRecordDays: 30, clientRequestId: 'crit-1' });
    fileApproval(approvals, a.applicationId, 'TEST lead a', 30, 'appr-1');
    // Spent by another consumer before this desk confirms it.
    const payload = payloadHash(
      leadApprovalPayload({ applicationId: a.applicationId, displayName: 'TEST lead a', minTrackRecordDays: 30 }),
    );
    const spent = await approvals.consume({
      approvalId: 'appr-1',
      actionType: COPY_LEAD_APPROVE_ACTION,
      targetId: a.applicationId,
      expectedVersion: 'pending',
      payloadHash: payload,
      operationId: 'op-appr-1',
    });
    expect(spent.ok).toBe(true);
    await desk.propose(founder(FOUNDER_A), { applicationId: a.applicationId, approvalId: 'appr-1' });
    await expect(
      desk.approve(founder(FOUNDER_B), { applicationId: a.applicationId, approvalId: 'appr-1', operationId: 'op-appr-1' }),
    ).rejects.toMatchObject({ code: 'approval_reused' });
    expect(await desk.leads(reader())).toEqual([]);
    expect(await desk.mine(customer(ALICE))).toMatchObject({ state: 'submitted' });
  });

  it('refuses before listing when the founder who attached the approval also approved it', async () => {
    const { desk, approvals } = harness();
    const a = await desk.apply(customer(ALICE), { displayName: 'TEST lead a' });
    await desk.setCriteria(founder(FOUNDER_A), { minTrackRecordDays: 30, clientRequestId: 'crit-1' });
    // Identity: A filed, B approved. Here B attaches it and A confirms, so B would be both approver and proposer.
    fileApproval(approvals, a.applicationId, 'TEST lead a', 30, 'appr-1');
    await desk.propose(founder(FOUNDER_B), { applicationId: a.applicationId, approvalId: 'appr-1' });
    await expect(
      desk.approve(founder(FOUNDER_A), { applicationId: a.applicationId, approvalId: 'appr-1', operationId: 'op-appr-1' }),
    ).rejects.toMatchObject({ code: 'approval_mismatch' });
    expect(await desk.leads(reader())).toEqual([]);
    expect(await desk.mine(customer(ALICE))).toMatchObject({ state: 'submitted' });
    // A newly filed approval, attached by the founder who filed it, lists the lead.
    fileApproval(approvals, a.applicationId, 'TEST lead a', 30, 'appr-2');
    await desk.propose(founder(FOUNDER_A), { applicationId: a.applicationId, approvalId: 'appr-2' });
    await desk.approve(founder(FOUNDER_B), { applicationId: a.applicationId, approvalId: 'appr-2', operationId: 'op-appr-2' });
    expect(await desk.leads(reader())).toHaveLength(1);
    expect(await desk.mine(customer(ALICE))).toMatchObject({ state: 'approved' });
  });

  it('never lists again someone already in the leader directory, so a suspension stands', async () => {
    const { desk, approvals } = harness();
    const directory = sqlLeaderDirectory(sql(), { now, feeShareLaw: { published: false } });
    // ALICE applies, then an operator lists and suspends her directly in the directory.
    const a = await desk.apply(customer(ALICE), { displayName: 'TEST lead a' });
    const listed = await directory.upsertListing(founder(FOUNDER_A), {
      clientRequestId: 'op-list-alice',
      leaderUserId: ALICE,
      displayName: 'TEST lead a',
      recordKind: 'self_reported',
      state: 'listed',
    });
    await directory.setLeaderState(founder(FOUNDER_A), {
      leaderRef: listed.leaderRef,
      state: 'suspended',
      reason: 'TEST suspension',
      clientRequestId: 'op-suspend-alice',
    });
    await desk.setCriteria(founder(FOUNDER_A), { minTrackRecordDays: 30, clientRequestId: 'crit-1' });
    fileApproval(approvals, a.applicationId, 'TEST lead a', 30, 'appr-1');
    await desk.propose(founder(FOUNDER_A), { applicationId: a.applicationId, approvalId: 'appr-1' });
    await expect(
      desk.approve(founder(FOUNDER_B), { applicationId: a.applicationId, approvalId: 'appr-1', operationId: 'op-appr-1' }),
    ).rejects.toMatchObject({ code: 'trade.copy_lead_already_leading' });
    expect(await desk.leads(reader())).toEqual([expect.objectContaining({ leaderRef: listed.leaderRef, state: 'suspended' })]);

    // BOB is in the directory without an application: applying refuses, and nothing is written.
    await directory.upsertListing(founder(FOUNDER_A), {
      clientRequestId: 'op-list-bob',
      leaderUserId: BOB,
      displayName: 'TEST lead b',
      recordKind: 'self_reported',
      state: 'listed',
    });
    await expect(desk.apply(customer(BOB), { displayName: 'TEST lead b' })).rejects.toMatchObject({
      code: 'trade.copy_lead_already_leading',
    });
    expect(await desk.mine(customer(BOB))).toBeNull();
  });

  it('rejects with a reason the applicant reads; a decided application stays decided; applying again waits on the unset wait', async () => {
    const { desk } = harness();
    const a = await desk.apply(customer(ALICE), { displayName: 'TEST lead a' });
    await expect(desk.reject(founder(FOUNDER_A), { applicationId: a.applicationId, reason: 'no' })).rejects.toMatchObject({
      code: 'reason_required',
    });
    const rejected = await desk.reject(founder(FOUNDER_A), { applicationId: a.applicationId, reason: 'TEST: track record too short' });
    expect(rejected).toMatchObject({ status: 'rejected', reason: 'TEST: track record too short' });
    expect(await desk.mine(customer(ALICE))).toMatchObject({ state: 'rejected', reason: 'TEST: track record too short' });
    await expect(desk.propose(founder(FOUNDER_A), { applicationId: a.applicationId, approvalId: 'x' })).rejects.toThrow();
    await expect(desk.reject(founder(FOUNDER_A), { applicationId: a.applicationId, reason: 'TEST other reason' })).rejects.toMatchObject({
      code: 'trade.copy_lead_application_decided',
    });
    // Applying again waits on the owner's re-apply wait, which is not set: refused by name, and nothing is written.
    await expect(desk.apply(customer(ALICE), { displayName: 'TEST lead a' })).rejects.toMatchObject({
      code: 'trade.copy_lead_reapply_wait_unset',
    });
    expect(await desk.mine(customer(ALICE))).toMatchObject({ applicationId: a.applicationId, state: 'rejected' });
  });

  it('refuses an unknown application id by name', async () => {
    const { desk } = harness();
    await expect(desk.reject(founder(FOUNDER_A), { applicationId: 'not-a-uuid', reason: 'TEST reason' })).rejects.toMatchObject({
      code: 'trade.copy_lead_application_not_found',
    });
  });
});
