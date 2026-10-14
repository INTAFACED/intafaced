/**
 * Unit card — bank.step_up_uses (migration 0033) records which operation spent an approval
 *
 * 1. Promise: one row per approval, written once; a second writer gets the first row back, so two
 *    racing requests cannot both claim an approval for different operations.
 * 2. Break: no unique key would let the same approval back two transfers.
 * 3. Done bar: record returns the winner; a different operation's record returns the earlier row; blank
 *    ids are rejected; the gate replays the same operation against Postgres and refuses another.
 * 4. Class M
 * 5. Paths: services/svc-bank/drizzle/0033_step_up_uses.sql, step-up/step-up-store.ts, step-up-gate.ts
 * 6. RED before: no table
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import type { ActionApproval } from '@intafaced/contracts';
import { createStepUpGate } from './step-up-gate.js';
import { SqlStepUpUseStore } from './step-up-store.js';

const adminUrl = process.env.TEST_DATABASE_URL;
if (adminUrl === undefined || adminUrl.trim() === '') throw new Error('TEST_DATABASE_URL is unset');
const adminDatabase = decodeURIComponent(new URL(adminUrl).pathname.replace(/^\//, ''));
if (adminDatabase === '' || adminDatabase === 'postgres') throw new Error('refusing to connect to a database named postgres');

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const MIGRATIONS = readdirSync(drizzle)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(drizzle, file), 'utf8'));

let db: TestDatabase | undefined;
beforeAll(async () => {
  db = await createTestDatabase({ service: 'bank', url: adminUrl, migrations: MIGRATIONS });
}, 120_000);
afterAll(async () => {
  await db?.drop();
});

const EXPIRES = new Date('2026-10-14T12:05:00.000Z');
const use = (over: Record<string, unknown> = {}) => ({
  approvalId: 'ap-1',
  userId: 'u1',
  actionType: 'bank.step_up.transfers.toUser',
  payloadHash: 'sha256:aaa',
  operationKey: 'transfer-0001',
  expiresAt: EXPIRES,
  ...over,
});

describe('SqlStepUpUseStore', () => {
  it('stores once and hands a racing writer the first row', async () => {
    const store = new SqlStepUpUseStore(db!.sql);
    const first = await store.record(use());
    expect(first).toMatchObject({ approvalId: 'ap-1', operationKey: 'transfer-0001' });
    const second = await store.record(use({ operationKey: 'transfer-0002', payloadHash: 'sha256:bbb' }));
    expect(second.operationKey).toBe('transfer-0001');
    expect(await store.get('ap-1')).toMatchObject({ userId: 'u1', expiresAt: EXPIRES });
    expect(await store.get('missing')).toBeNull();
  });

  it('rejects blank ids at the database', async () => {
    const store = new SqlStepUpUseStore(db!.sql);
    await expect(store.record(use({ approvalId: ' ' }))).rejects.toThrow();
    await expect(store.record(use({ approvalId: 'ap-x', operationKey: '' }))).rejects.toThrow();
  });

  it('the gate replays the same operation from Postgres and refuses another', async () => {
    const store = new SqlStepUpUseStore(db!.sql);
    let consumes = 0;
    const gate = createStepUpGate({
      mode: 'required',
      store,
      clock: () => new Date('2026-10-14T12:00:00.000Z'),
      approvals: {
        async consume(input) {
          consumes += 1;
          return {
            ...input,
            actionType: input.targetId,
            requesterId: 'u9',
            approverId: 'u9',
            policyVersion: 'step-up-v1',
            createdAt: '2026-10-14T12:00:00.000Z',
            expiresAt: EXPIRES.toISOString(),
            status: 'CONSUMED',
            kind: 'same_person',
          } as ActionApproval;
        },
      },
    });
    const req = {
      userId: 'u9',
      sessionId: 's9',
      actionType: 'bank.step_up.transfers.toUser' as const,
      fields: { transferId: 't-1', amount: '5' },
      operationKey: 't-1',
      approvalId: 'ap-gate',
      replay: true,
    };
    await gate.require(req);
    await gate.require(req);
    expect(consumes).toBe(1);
    await expect(gate.require({ ...req, fields: { transferId: 't-2', amount: '5' }, operationKey: 't-2' })).rejects.toMatchObject({
      code: 'bank.step_up_mismatch',
    });
    await expect(gate.require({ ...req, replay: false })).rejects.toMatchObject({ code: 'bank.step_up_used' });
  });
});
