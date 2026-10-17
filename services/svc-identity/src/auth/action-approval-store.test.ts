import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { postgresAvailable, rewriteSchemaSql } from '@intafaced/db';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { MemoryActionApprovalStore, SqlActionApprovalStore, type StoredApproval } from './action-approval-store.js';

const NOW = new Date('2026-09-09T12:00:00.000Z');
const LATER = new Date('2026-09-09T12:02:00.000Z');

function row(overrides: Partial<StoredApproval> = {}): StoredApproval {
  return {
    approvalId: 'appr-1',
    actionType: 'ledger.freeze',
    targetService: 'svc-ledger',
    targetId: 'posting_freeze',
    expectedVersion: '1',
    payloadHash: 'sha256:abc',
    requesterId: 'user-a',
    approverId: null,
    policyVersion: 'v1',
    operationId: 'op-1',
    status: 'PENDING',
    createdAt: NOW,
    expiresAt: LATER,
    approvedAt: null,
    consumedAt: null,
    ...overrides,
  };
}

describe('MemoryActionApprovalStore', () => {
  it('CAS consume wins once', async () => {
    const store = new MemoryActionApprovalStore();
    await store.insert(row());
    const approved = await store.casApprove('appr-1', 'user-b', NOW);
    expect(approved?.status).toBe('APPROVED');
    const first = await store.casConsume({
      approvalId: 'appr-1',
      operationId: 'op-1',
      payloadHash: 'sha256:abc',
      targetService: 'svc-ledger',
      targetId: 'posting_freeze',
      expectedVersion: '1',
      now: NOW,
    });
    const second = await store.casConsume({
      approvalId: 'appr-1',
      operationId: 'op-1',
      payloadHash: 'sha256:abc',
      targetService: 'svc-ledger',
      targetId: 'posting_freeze',
      expectedVersion: '1',
      now: NOW,
    });
    expect(first?.status).toBe('CONSUMED');
    expect(second).toBeNull();
  });
});

const URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '../../drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

const available = await postgresAvailable(URL);

if (!available) {
  describe.skip('SqlActionApprovalStore (Postgres unavailable)', () => {
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

  describe('SqlActionApprovalStore', () => {
    it('survives process restart: approve then consume from a new store on the same rows', async () => {
      await store.insert(row({ approvalId: 'appr-pg', operationId: 'op-pg' }));
      const other = new SqlActionApprovalStore(db.sql);
      const approved = await other.casApprove('appr-pg', 'user-b', NOW);
      expect(approved?.status).toBe('APPROVED');
      const consumed = await other.casConsume({
        approvalId: 'appr-pg',
        operationId: 'op-pg',
        payloadHash: 'sha256:abc',
        targetService: 'svc-ledger',
        targetId: 'posting_freeze',
        expectedVersion: '1',
        now: NOW,
      });
      expect(consumed?.status).toBe('CONSUMED');
      expect(consumed?.consumedByService).toBeNull();
      expect(consumed?.consumedRequestId).toBeNull();
      expect(
        await store.casConsume({
          approvalId: 'appr-pg',
          operationId: 'op-pg',
          payloadHash: 'sha256:abc',
          targetService: 'svc-ledger',
          targetId: 'posting_freeze',
          expectedVersion: '1',
          now: NOW,
        }),
      ).toBeNull();
    });

    it('records who consumed a row and which request id', async () => {
      await store.insert(row({ approvalId: 'appr-prov', operationId: 'op-prov' }));
      await store.casApprove('appr-prov', 'user-b', NOW);
      const consumed = await store.casConsume({
        approvalId: 'appr-prov',
        operationId: 'op-prov',
        payloadHash: 'sha256:abc',
        targetService: 'svc-ledger',
        targetId: 'posting_freeze',
        expectedVersion: '1',
        now: NOW,
        requestId: 'req-prov',
        consumedByService: 'svc-ledger',
        consumedByPrincipal: 'user-c',
      });
      expect(consumed).toMatchObject({
        status: 'CONSUMED',
        consumedByService: 'svc-ledger',
        consumedByPrincipal: 'user-c',
        consumedRequestId: 'req-prov',
      });
      expect((await store.get('appr-prov'))?.consumedRequestId).toBe('req-prov');
    });

    it('lists a requester’s rows and other people’s pending rows, newest first', async () => {
      await store.insert(row({ approvalId: 'older', requesterId: 'user-a', operationId: 'op-old', createdAt: NOW }));
      await store.insert(
        row({
          approvalId: 'newer',
          requesterId: 'user-a',
          operationId: 'op-new',
          createdAt: LATER,
          expiresAt: new Date('2026-09-09T12:04:00.000Z'),
        }),
      );
      await store.insert(row({ approvalId: 'other', requesterId: 'user-b', operationId: 'op-b', createdAt: LATER }));
      expect((await store.listByRequester('user-a', 10)).map((r) => r.approvalId)).toEqual(['newer', 'older']);
      expect((await store.listPendingExcept('user-a', 10)).map((r) => r.approvalId)).toEqual(['other']);
    });
  });
}
