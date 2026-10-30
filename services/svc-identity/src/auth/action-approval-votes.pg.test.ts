/**
 * OPS-change-control-01 CR-1 on Postgres: concurrent approvers of one governed request are counted exactly, one person
 * counts once, and the consume CAS refuses a governed row whose votes fall short. The migration reverses cleanly.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { postgresAvailable, rewriteSchemaSql } from '@intafaced/db';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { approvalPolicySource } from './action-approval-policy.js';
import { ActionApprovalService } from './action-approval-service.js';
import { SqlActionApprovalStore, type StoredApproval } from './action-approval-store.js';

const NOW = new Date('2026-10-30T10:00:00.000Z');
const REQ = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const APPROVERS = Array.from({ length: 6 }, (_, i) => `0000000${i}-0000-4000-8000-00000000000${i}`);
const HASH = `sha256:${'a'.repeat(64)}`;

function governed(overrides: Partial<StoredApproval> = {}): StoredApproval {
  return {
    approvalId: 'gov-1',
    actionType: 'ops.ledger.reverse',
    targetService: 'svc-ops',
    targetId: 'reverse:tx-1',
    expectedVersion: '1',
    payloadHash: 'sha256:rev',
    requesterId: REQ,
    approverId: null,
    policyVersion: 'desk-v1',
    operationId: 'op-gov-1',
    status: 'PENDING',
    createdAt: NOW,
    expiresAt: new Date(NOW.getTime() + 600_000),
    approvedAt: null,
    consumedAt: null,
    approvalsRequired: 3,
    policyHash: HASH,
    ...overrides,
  };
}

const consumeInput = (id: string, op: string) => ({
  approvalId: id,
  operationId: op,
  payloadHash: 'sha256:rev',
  targetService: 'svc-ops',
  targetId: 'reverse:tx-1',
  expectedVersion: '1',
  now: NOW,
});

const URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '../../drizzle');
const files = readdirSync(drizzleDir).sort();
const migrations = files.filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql')).map((f) => readFileSync(join(drizzleDir, f), 'utf8'));
const THIS = files.find((f) => f.endsWith('_action_approval_policy_votes.sql'))!;
const available = await postgresAvailable(URL);

if (!available) {
  describe.skip('governed approval votes (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db = await createTestDb({
    service: 'identity',
    url: URL,
    migrations: migrations.map((body) => (schema: string) => rewriteSchemaSql(body, 'identity', schema)),
  });
  const store = new SqlActionApprovalStore(db.sql);

  beforeEach(async () => {
    await db.truncateAll();
  });

  afterAll(async () => {
    await db.drop();
  });

  describe('SqlActionApprovalStore.casVote', () => {
    it('six approvers at once on a count of three: exactly three votes, APPROVED once, the rest not_pending', async () => {
      await store.insert(governed());
      const results = await Promise.all(APPROVERS.map((who) => new SqlActionApprovalStore(db.sql).casVote('gov-1', who, NOW)));
      const recorded = results.filter((r) => r.kind === 'recorded');
      expect(recorded).toHaveLength(3);
      expect(results.filter((r) => r.kind === 'not_pending')).toHaveLength(3);
      const approvedNow = recorded.filter((r) => r.kind === 'recorded' && r.row.status === 'APPROVED');
      expect(approvedNow).toHaveLength(1);
      const row = await store.get('gov-1');
      expect(row).toMatchObject({ status: 'APPROVED', approvalsGiven: 3, approvalsRequired: 3 });
      expect(await store.listVotes('gov-1')).toHaveLength(3);
      expect(APPROVERS).toContain(row?.approverId);
    });

    it('one approver five times at once counts once; any other case of the id is the same person', async () => {
      await store.insert(governed());
      const results = await Promise.all(
        [0, 1, 2, 3, 4].map((i) => store.casVote('gov-1', i % 2 === 0 ? APPROVERS[0]! : APPROVERS[0]!.toUpperCase(), NOW)),
      );
      expect(results.filter((r) => r.kind === 'recorded')).toHaveLength(1);
      expect(results.filter((r) => r.kind === 'already_approved')).toHaveLength(4);
      expect(await store.get('gov-1')).toMatchObject({ status: 'PENDING', approvalsGiven: 1, approverId: null });
    });

    it('the requester, an expired row and an ungoverned row are not_pending; fixed CAS never approves a governed row', async () => {
      await store.insert(governed());
      expect(await store.casVote('gov-1', REQ, NOW)).toEqual({ kind: 'not_pending' });
      expect(await store.casVote('gov-1', APPROVERS[0]!, new Date(NOW.getTime() + 600_000))).toEqual({ kind: 'not_pending' });
      expect(await store.casApprove('gov-1', APPROVERS[0]!, NOW)).toBeNull();
      await store.insert(governed({ approvalId: 'plain', operationId: 'op-plain', approvalsRequired: null, policyHash: null }));
      expect(await store.casVote('plain', APPROVERS[0]!, NOW)).toEqual({ kind: 'not_pending' });
      expect((await store.casApprove('plain', APPROVERS[0]!, NOW))?.status).toBe('APPROVED');
    });

    it('consume CAS refuses a governed row forced to APPROVED without enough votes, and takes one with them', async () => {
      await store.insert(governed());
      await store.casVote('gov-1', APPROVERS[0]!, NOW);
      await db.sql`UPDATE action_approvals SET status = 'APPROVED', approver_id = ${APPROVERS[0]!}, approved_at = ${NOW} WHERE approval_id = 'gov-1'`;
      expect(await store.casConsume(consumeInput('gov-1', 'op-gov-1'))).toBeNull();
      await db.sql`UPDATE action_approvals SET status = 'PENDING', approver_id = NULL, approved_at = NULL WHERE approval_id = 'gov-1'`;
      await store.casVote('gov-1', APPROVERS[1]!, NOW);
      await store.casVote('gov-1', APPROVERS[2]!, NOW);
      expect((await store.casConsume(consumeInput('gov-1', 'op-gov-1')))?.status).toBe('CONSUMED');
    });

    it('the table refuses a governed row without a policy version and a count below one', async () => {
      await expect(store.insert(governed({ policyHash: null }))).rejects.toThrow();
      await expect(store.insert(governed({ approvalsRequired: 0 }))).rejects.toThrow();
    });
  });

  describe('ActionApprovalService on Postgres', () => {
    it('concurrent approvers through the service: exactly N counted, consumable once', async () => {
      const raw = JSON.stringify({
        'ops.ledger.reverse': { requiredApprovals: '2', approverAudience: 'operator', applier: 'svc-ops', maxAgeSeconds: '600' },
      });
      const svc = new ActionApprovalService(store, { ttlSeconds: 600, policies: approvalPolicySource(() => raw) }, () => NOW);
      const p = await svc.propose(REQ, {
        actionType: 'ops.ledger.reverse',
        targetService: 'svc-ops',
        targetId: 'reverse:tx-1',
        expectedVersion: '1',
        payloadHash: 'sha256:rev',
        policyVersion: 'desk-v1',
      });
      const outcomes = await Promise.allSettled(APPROVERS.slice(0, 4).map((who) => svc.approve(who, p.approvalId, p.payloadHash)));
      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(2);
      for (const o of outcomes.filter((x) => x.status === 'rejected')) {
        expect((o as PromiseRejectedResult).reason).toMatchObject({ code: 'action_approval.not_pending' });
      }
      const consumed = await svc.consume('svc-ops', consumeInput(p.approvalId, p.operationId));
      expect(consumed).toMatchObject({ status: 'CONSUMED', approvalsGiven: 2, approvalsRequired: 2 });
    });
  });

  describe('migration', () => {
    it('reverses and re-applies cleanly', async () => {
      const down = readFileSync(join(drizzleDir, THIS.replace(/\.sql$/, '.down.sql')), 'utf8');
      const up = readFileSync(join(drizzleDir, THIS), 'utf8');
      await db.sql.unsafe(rewriteSchemaSql(down, 'identity', db.schema));
      const cols = await db.sql`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = ${db.schema} AND table_name = 'action_approvals' AND column_name = 'approvals_required'
      `;
      expect(cols).toHaveLength(0);
      await db.sql.unsafe(rewriteSchemaSql(up, 'identity', db.schema));
      await db.sql.unsafe(rewriteSchemaSql(up, 'identity', db.schema));
      await store.insert(governed());
      expect((await store.casVote('gov-1', APPROVERS[0]!, NOW)).kind).toBe('recorded');
    });
  });
}
