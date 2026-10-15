/**
 * Unit card — same-person approval rows in Postgres (migration 0028)
 *
 * 1. Promise: the CAS consume matches user AND session for same_person rows, atomically, once.
 * 2. Break: relaxing the distinct-people CHECK for every row would let a four-eyes row name one
 *    person twice.
 * 3. Done bar: same_person rows insert, consume once for the right principal only; four-eyes rows
 *    still reject approver = requester at the database; a same_person row without a session is rejected.
 * 4. Class M
 * 5. Paths: services/svc-identity/drizzle/0028_action_approval_same_person.sql, action-approval-store.ts
 * 6. RED before: no kind/session_id columns
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, postgresAvailable, rewriteSchemaSql } from '@intafaced/db';
import { SqlActionApprovalStore, type StoredApproval } from './action-approval-store.js';

const NOW = new Date('2026-10-14T12:00:00.000Z');
const LATER = new Date('2026-10-14T12:05:00.000Z');
const A = 'user-a';
const B = 'user-b';
const S1 = 'session-1';

function row(overrides: Partial<StoredApproval> = {}): StoredApproval {
  return {
    approvalId: 'sp-1',
    actionType: 'bank.step_up.transfers.toUser',
    targetService: 'svc-bank',
    targetId: 'bank.step_up.transfers.toUser',
    expectedVersion: '1',
    payloadHash: 'sha256:abc',
    requesterId: A,
    approverId: A,
    policyVersion: 'step-up-v1',
    operationId: 'sp-1',
    status: 'APPROVED',
    createdAt: NOW,
    expiresAt: LATER,
    approvedAt: NOW,
    consumedAt: null,
    kind: 'same_person',
    sessionId: S1,
    ...overrides,
  };
}

function cas(overrides: Record<string, unknown> = {}) {
  return {
    approvalId: 'sp-1',
    operationId: 'sp-1',
    payloadHash: 'sha256:abc',
    targetService: 'svc-bank',
    targetId: 'bank.step_up.transfers.toUser',
    expectedVersion: '1',
    principalUserId: A,
    principalSessionId: S1,
    now: NOW,
    ...overrides,
  };
}

const URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '../../drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

const available = await postgresAvailable(URL);

if (!available) {
  describe.skip('same-person approvals (Postgres unavailable)', () => {
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

  describe('same-person rows in Postgres', () => {
    it('round-trips kind and session, and consumes once for the exact user and session only', async () => {
      const saved = await store.insert(row());
      expect(saved).toMatchObject({ kind: 'same_person', sessionId: S1, requesterId: A, approverId: A });
      expect(await store.casConsume(cas({ principalUserId: B }))).toBeNull();
      expect(await store.casConsume(cas({ principalSessionId: 'session-2' }))).toBeNull();
      expect(await store.casConsume(cas({ principalUserId: undefined, principalSessionId: undefined }))).toBeNull();
      expect((await store.casConsume(cas()))?.status).toBe('CONSUMED');
      expect(await store.casConsume(cas())).toBeNull();
    });

    it('does not consume an expired same-person row', async () => {
      await store.insert(row());
      expect(await store.casConsume(cas({ now: new Date(LATER.getTime() + 1) }))).toBeNull();
    });

    it('a four-eyes row cannot be consumed with a principal, and still needs two people at the database', async () => {
      await store.insert(
        row({
          approvalId: 'fe-1',
          operationId: 'fe-1',
          kind: 'four_eyes',
          sessionId: null,
          approverId: null,
          status: 'PENDING',
          targetService: 'svc-ledger',
        }),
      );
      await store.casApprove('fe-1', B, NOW);
      expect(await store.casConsume(cas({ approvalId: 'fe-1', operationId: 'fe-1', targetService: 'svc-ledger' }))).toBeNull();
      expect(
        (
          await store.casConsume(
            cas({
              approvalId: 'fe-1',
              operationId: 'fe-1',
              targetService: 'svc-ledger',
              principalUserId: undefined,
              principalSessionId: undefined,
            }),
          )
        )?.status,
      ).toBe('CONSUMED');
      await expect(store.insert(row({ approvalId: 'fe-2', operationId: 'fe-2', kind: 'four_eyes', sessionId: null }))).rejects.toThrow();
    });

    it('rejects a same-person row with no session, or with two different people', async () => {
      await expect(store.insert(row({ approvalId: 'x1', operationId: 'x1', sessionId: null }))).rejects.toThrow();
      await expect(store.insert(row({ approvalId: 'x2', operationId: 'x2', approverId: B }))).rejects.toThrow();
    });
  });
}
