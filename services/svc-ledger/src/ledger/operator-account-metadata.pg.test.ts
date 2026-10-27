import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createTestDb, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { parseAmount as amt, recipes } from '@intafaced/ledger-client';
import type { ActionApprovalConsumeInput } from '@intafaced/contracts';
import { PostgresLedger } from './postgres-ledger.js';
import { recordOperatorAccess } from './operator-owner-balances.js';
import { stubApprovalConsumer, type ActionApprovalConsumer } from './action-approval-consume.js';
import {
  ACCOUNT_METADATA_APPROVAL_SPENT,
  ACCOUNT_METADATA_DELETE_TARGET,
  ACCOUNT_METADATA_INVALID,
  ACCOUNT_METADATA_KEY_ABSENT,
  ACCOUNT_METADATA_STALE,
  ACCOUNT_NOT_FOUND,
  LEDGER_FROZEN,
  deleteAccountMetadata,
  readAccountMetadata,
  setAccountMetadata,
} from './operator-account-metadata.js';

/**
 * Operator metadata on a ledger account against a real book (OPS-ledger-desk-01, J-ops-console-03 #6, #7; 0029): set and
 * overwrite with the value before and after; a delete that spends a second founder's approval once; a stale revision
 * refused; every write refused `ledger.frozen` under the posting freeze while the read still answers; and the change
 * record append-only. TEST amounts and labels only.
 *
 * PG-hard: this file never skips. CI uses TEST_DATABASE_URL. Local without that env starts Testcontainers.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'))
  .map((body) => (schema: string) => rewriteSchemaSql(body, 'ledger', schema));

const IMAGE = 'postgres:16-alpine';
const CUSTOMER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FOUNDER_A = 'requester';
const FOUNDER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const REASON = 'LOCAL TEST label for the desk';

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  try {
    const container = await new PostgreSqlContainer(IMAGE)
      .withDatabase('intafaced_meta_test')
      .withUsername('intafaced')
      .withPassword('intafaced')
      .start();
    return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Account metadata is PG-hard (no skip-green). TEST_DATABASE_URL unset and Testcontainers could not start ${IMAGE}: ${msg}`,
    );
  }
}

/** The stand-in identity: a consumed four-eyes row naming founder B as approver; counts and keeps every consume. */
function approvals(approverId = FOUNDER_B): ActionApprovalConsumer & { calls: ActionApprovalConsumeInput[] } {
  const stub = stubApprovalConsumer(approverId);
  const calls: ActionApprovalConsumeInput[] = [];
  return {
    calls,
    consume: async (input) => {
      calls.push(input);
      return stub.consume(input);
    },
  };
}

describe('account metadata PG-hard (source)', () => {
  it('is not skip-green', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

describe('account metadata on a real book', () => {
  let stop: () => Promise<void> = async () => undefined;
  let db: TestDb | undefined;
  let account = '';
  const d = () => db as TestDb;
  const freeze = (frozen: boolean) =>
    d()
      .sql`UPDATE posting_freeze SET frozen = ${frozen}, reason = ${frozen ? 'LOCAL TEST freeze' : null}, actor = ${frozen ? 'test' : null} WHERE id = true`;

  beforeAll(async () => {
    const admin = await openAdmin();
    stop = admin.stop;
    db = await createTestDb({ service: 'ledger_meta', url: admin.url, migrations });
    await new PostgresLedger(db.sql).post(
      recipes.deposit({ userId: CUSTOMER, assetId: 'USDT', amount: amt('1'), rail: 'meta-test', railRef: 'meta-1' }),
    );
    const [row] = await db.sql<Array<{ id: string }>>`SELECT id FROM accounts WHERE owner_type = 'user' AND owner_id = ${CUSTOMER}`;
    account = row!.id;
  }, 180_000);

  afterAll(async () => {
    await db?.drop();
    await stop();
  });

  it('sets a key, overwrites it with the value before and after, and reads both back newest first', async () => {
    const first = await setAccountMetadata(d().sql, FOUNDER_A, {
      accountId: account,
      key: 'desk.label',
      value: 'one',
      reason: REASON,
      revision: 0,
    });
    expect(first.change).toMatchObject({
      action: 'set',
      before: null,
      after: 'one',
      revision: 1,
      requesterId: FOUNDER_A,
      approverId: null,
    });
    const second = await setAccountMetadata(d().sql, FOUNDER_A, {
      accountId: account,
      key: 'desk.label',
      value: 'two',
      reason: REASON,
      revision: 1,
    });
    expect(second.change).toMatchObject({ before: 'one', after: 'two', revision: 2 });

    const read = await readAccountMetadata(d().sql, { accountId: account });
    expect(read.address).toBe(`user:${CUSTOMER}`);
    expect(read.entries).toEqual([expect.objectContaining({ key: 'desk.label', value: 'two', revision: 2, updatedBy: FOUNDER_A })]);
    expect(read.changes.map((c) => [c.revision, c.before, c.after])).toEqual([
      [2, 'one', 'two'],
      [1, null, 'one'],
    ]);
    expect(read.frozen).toBe(false);
  });

  it('answers a retried set with its first change, and refuses a set from a revision someone else moved', async () => {
    const input = { accountId: account, key: 'desk.retry', value: 'v', reason: REASON, revision: 0 };
    const first = await setAccountMetadata(d().sql, FOUNDER_A, input);
    const again = await setAccountMetadata(d().sql, FOUNDER_A, input);
    expect(again.change.seq).toBe(first.change.seq);
    await expect(setAccountMetadata(d().sql, FOUNDER_A, { ...input, value: 'other' })).rejects.toMatchObject({
      code: ACCOUNT_METADATA_STALE,
    });
    const [n] = await d().sql<Array<{ n: string }>>`
      SELECT count(*)::text AS n FROM account_metadata_changes WHERE account_id = ${account} AND key = 'desk.retry'
    `;
    expect(n!.n).toBe('1');
  });

  it('deletes a key with a second founder: one consume bound to the key and revision, the change names both', async () => {
    await setAccountMetadata(d().sql, FOUNDER_A, { accountId: account, key: 'desk.gone', value: 'bye', reason: REASON, revision: 0 });
    const identity = approvals();
    const cmd = { accountId: account, key: 'desk.gone', reason: REASON, revision: 1, approvalId: 'appr-del-1', operationId: 'op-del-1' };
    const done = await deleteAccountMetadata(d().sql, identity, FOUNDER_A, cmd);
    expect(done.change).toMatchObject({
      action: 'delete',
      before: 'bye',
      after: null,
      revision: 2,
      requesterId: FOUNDER_A,
      approverId: FOUNDER_B,
      reason: REASON,
    });
    expect(identity.calls).toEqual([
      expect.objectContaining({
        approvalId: 'appr-del-1',
        operationId: 'op-del-1',
        targetService: 'svc-ledger',
        targetId: ACCOUNT_METADATA_DELETE_TARGET,
        expectedVersion: '1',
      }),
    ]);

    // A lost reply: the same approval answers the same change and identity is not asked again.
    const again = await deleteAccountMetadata(d().sql, identity, FOUNDER_A, cmd);
    expect(again.change.seq).toBe(done.change.seq);
    expect(identity.calls).toHaveLength(1);

    const read = await readAccountMetadata(d().sql, { accountId: account });
    expect(read.entries.map((e) => e.key)).not.toContain('desk.gone');
    expect(read.deleted).toContainEqual({ key: 'desk.gone', revision: 2 });
    // Deleting it again has nothing to delete; setting it again starts from the revision the ledger holds.
    await expect(
      deleteAccountMetadata(d().sql, approvals(), FOUNDER_A, { ...cmd, revision: 2, approvalId: 'appr-del-2', operationId: 'op-del-2' }),
    ).rejects.toMatchObject({ code: ACCOUNT_METADATA_KEY_ABSENT });
    const back = await setAccountMetadata(d().sql, FOUNDER_A, {
      accountId: account,
      key: 'desk.gone',
      value: 'back',
      reason: REASON,
      revision: 2,
    });
    expect(back.change).toMatchObject({ before: null, after: 'back', revision: 3 });
  });

  it('refuses a delete whose key moved after approval, and one approved by the person who asked, changing nothing', async () => {
    await setAccountMetadata(d().sql, FOUNDER_A, { accountId: account, key: 'desk.moved', value: 'a', reason: REASON, revision: 0 });
    await setAccountMetadata(d().sql, FOUNDER_A, { accountId: account, key: 'desk.moved', value: 'b', reason: REASON, revision: 1 });
    const identity = approvals();
    await expect(
      deleteAccountMetadata(d().sql, identity, FOUNDER_A, {
        accountId: account,
        key: 'desk.moved',
        reason: REASON,
        revision: 1,
        approvalId: 'appr-moved',
        operationId: 'op-moved',
      }),
    ).rejects.toMatchObject({ code: ACCOUNT_METADATA_STALE });
    expect(identity.calls).toHaveLength(0);

    // The stand-in names its requester 'requester'; an approver of the same name is the same person twice.
    await expect(
      deleteAccountMetadata(d().sql, approvals('requester'), FOUNDER_A, {
        accountId: account,
        key: 'desk.moved',
        reason: REASON,
        revision: 2,
        approvalId: 'appr-self',
        operationId: 'op-self',
      }),
    ).rejects.toMatchObject({ code: 'action_approval.not_founders' });
    const read = await readAccountMetadata(d().sql, { accountId: account });
    expect(read.entries).toContainEqual(expect.objectContaining({ key: 'desk.moved', value: 'b', revision: 2 }));
  });

  it('under the posting freeze: the read answers, a set and a delete refuse ledger.frozen, and the approval is not spent', async () => {
    await setAccountMetadata(d().sql, FOUNDER_A, { accountId: account, key: 'desk.frozen', value: 'kept', reason: REASON, revision: 0 });
    await freeze(true);
    try {
      const read = await readAccountMetadata(d().sql, { accountId: account });
      expect(read.frozen).toBe(true);
      expect(read.entries).toContainEqual(expect.objectContaining({ key: 'desk.frozen', value: 'kept' }));
      await expect(
        setAccountMetadata(d().sql, FOUNDER_A, { accountId: account, key: 'desk.frozen', value: 'new', reason: REASON, revision: 1 }),
      ).rejects.toMatchObject({ code: LEDGER_FROZEN });
      const identity = approvals();
      const cmd = { accountId: account, key: 'desk.frozen', reason: REASON, revision: 1, approvalId: 'appr-frz', operationId: 'op-frz' };
      await expect(deleteAccountMetadata(d().sql, identity, FOUNDER_A, cmd)).rejects.toMatchObject({ code: LEDGER_FROZEN });
      expect(identity.calls).toHaveLength(0);
      await freeze(false);
      // After the unfreeze the same approval deletes it.
      const done = await deleteAccountMetadata(d().sql, identity, FOUNDER_A, cmd);
      expect(done.change).toMatchObject({ action: 'delete', before: 'kept' });
    } finally {
      await freeze(false);
    }
  });

  it('a freeze that lands after the check while identity spends the approval refuses as spent, changing nothing', async () => {
    await setAccountMetadata(d().sql, FOUNDER_A, { accountId: account, key: 'desk.race', value: 'kept', reason: REASON, revision: 0 });
    const stub = approvals();
    const racing: ActionApprovalConsumer = {
      consume: async (input) => {
        const answer = await stub.consume(input);
        await freeze(true);
        return answer;
      },
    };
    try {
      await expect(
        deleteAccountMetadata(d().sql, racing, FOUNDER_A, {
          accountId: account,
          key: 'desk.race',
          reason: REASON,
          revision: 1,
          approvalId: 'appr-race',
          operationId: 'op-race',
        }),
      ).rejects.toMatchObject({ code: ACCOUNT_METADATA_APPROVAL_SPENT });
    } finally {
      await freeze(false);
    }
    const read = await readAccountMetadata(d().sql, { accountId: account });
    expect(read.entries).toContainEqual(expect.objectContaining({ key: 'desk.race', value: 'kept', revision: 1 }));
  });

  it('refuses an unknown account, a malformed key and a short reason, and keeps the change record append-only', async () => {
    await expect(readAccountMetadata(d().sql, { accountId: '99999999-9999-4999-8999-999999999999' })).rejects.toMatchObject({
      code: ACCOUNT_NOT_FOUND,
    });
    await expect(
      setAccountMetadata(d().sql, FOUNDER_A, {
        accountId: '99999999-9999-4999-8999-999999999999',
        key: 'desk.label',
        value: 'x',
        reason: REASON,
        revision: 0,
      }),
    ).rejects.toMatchObject({ code: ACCOUNT_NOT_FOUND });
    for (const bad of [
      { key: 'Desk Label', reason: REASON },
      { key: 'desk.label', reason: 'too short' },
      { key: 'desk.label', reason: REASON, revision: '0' },
      { key: 'desk.label', reason: REASON, revision: null },
    ]) {
      await expect(setAccountMetadata(d().sql, FOUNDER_A, { accountId: account, value: 'x', revision: 0, ...bad })).rejects.toMatchObject({
        code: ACCOUNT_METADATA_INVALID,
      });
    }
    await expect(d().sql`UPDATE account_metadata_changes SET after = 'forged' WHERE account_id = ${account}`).rejects.toThrow(
      /append-only/,
    );
    await expect(d().sql`DELETE FROM account_metadata_changes WHERE account_id = ${account}`).rejects.toThrow(/append-only/);
  });

  it('0029 lets the access log take a metadata read', async () => {
    await recordOperatorAccess(d().sql, {
      actorId: FOUNDER_A,
      requestId: null,
      ownerType: 'account',
      ownerId: account,
      action: 'account_metadata.read',
    });
    const [row] = await d().sql<Array<{ action: string }>>`
      SELECT action FROM operator_access_log WHERE target_owner_id = ${account} ORDER BY id DESC LIMIT 1
    `;
    expect(row!.action).toBe('account_metadata.read');
  });
});
