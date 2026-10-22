import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertTestDatabase, postgresAvailable } from '@intafaced/db';
import type { ActionApproval, ActionApprovalConsumeInput } from '@intafaced/contracts';
import { PostgresCommandLog } from '../preferences/account.pg.js';
import { NoticeBoard, type NoticeApprovalConsumer } from './board.js';
import { PostgresNoticeStore } from './board.pg.js';

/**
 * Funding incident scope and phase on the real notices table. Cleanup deletes only this file's author.
 */

const URL = process.env.TEST_DATABASE_URL_NOTIFY ?? process.env.TEST_DATABASE_URL;
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', 'drizzle');
const AUTHOR = 'f4nd1n90-1111-4111-8111-111111111111';
const APPROVER = 'f4nd1n90-2222-4222-8222-222222222222';

const available = URL ? await postgresAvailable(URL) : false;
const client: Sql | null = URL && available ? postgres(URL, { max: 2, onnotice: () => undefined }) : null;

function db(): Sql {
  if (!client) throw new Error('TEST_DATABASE_URL_NOTIFY and TEST_DATABASE_URL are unset');
  return client;
}

class Approvals implements NoticeApprovalConsumer {
  async consume(input: ActionApprovalConsumeInput): Promise<ActionApproval> {
    return {
      approvalId: input.approvalId,
      actionType: 'notify.notice.publish',
      targetService: input.targetService,
      targetId: input.targetId,
      expectedVersion: input.expectedVersion,
      payloadHash: input.payloadHash,
      requesterId: AUTHOR,
      approverId: APPROVER,
      policyVersion: 'v1',
      createdAt: '2026-10-17T00:00:00.000Z',
      expiresAt: '2026-10-17T01:00:00.000Z',
      status: 'CONSUMED',
      operationId: input.operationId,
    };
  }
}

async function cleanup(sql: Sql): Promise<void> {
  await sql`ALTER TABLE notify.notices DISABLE TRIGGER notice_published_immutable`;
  try {
    await sql`DELETE FROM notify.notice_approval_uses WHERE publisher_id = ${AUTHOR}`;
    await sql`DELETE FROM notify.notices WHERE author_id = ${AUTHOR} AND parent_id IS NOT NULL`;
    await sql`DELETE FROM notify.notices WHERE author_id = ${AUTHOR}`;
    await sql`DELETE FROM notify.preference_commands WHERE user_id = ${AUTHOR}`;
  } finally {
    await sql`ALTER TABLE notify.notices ENABLE TRIGGER notice_published_immutable`;
  }
}

beforeAll(async () => {
  if (!client) return;
  const name = await client<{ db: string }[]>`SELECT current_database() AS db`;
  if (name[0]?.db !== 'test') await assertTestDatabase(client, 'svc-notify funding-notices.pg.test');
  const files = readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
    .sort();
  for (const file of files) {
    await client.unsafe(readFileSync(join(migrationsDir, file), 'utf8')).catch(() => undefined);
  }
  await cleanup(client);
});

afterAll(async () => {
  if (!client) return;
  await cleanup(client).catch(() => undefined);
  await client.end({ timeout: 1 }).catch(() => undefined);
});

describe.skipIf(!URL || !available)('funding incident notices on the shared test database (W-compliance-notices-01)', () => {
  it('stores scope and phase, reads by network, and freezes them once published', async () => {
    let now = new Date('2026-10-22T03:00:00.000Z');
    const board = new NoticeBoard(new PostgresNoticeStore(db()), new Approvals(), new PostgresCommandLog(db()), () => now);
    const root = await board.draft(AUTHOR, {
      kind: 'incident',
      title: 'Test incident',
      body: 'Test body',
      impact: 'major',
      asset: 'USDT',
      network: 'ethereum',
      phase: 'investigating',
      clientRequestId: 'pg-fn-root',
    });
    await board.publish(AUTHOR, { id: root.id, clientRequestId: 'pg-fn-root-pub', approvalId: 'pg-fn-appr-1', operationId: 'pg-fn-op-1' });
    now = new Date('2026-10-22T03:30:00.000Z');
    const update = await board.draft(AUTHOR, {
      kind: 'incident',
      title: 'Test incident',
      body: 'Test update',
      parentId: root.id,
      phase: 'monitoring',
      clientRequestId: 'pg-fn-child',
    });
    expect(update).toMatchObject({ asset: 'USDT', network: 'ethereum', phase: 'monitoring' });
    await board.publish(AUTHOR, {
      id: update.id,
      clientRequestId: 'pg-fn-child-pub',
      approvalId: 'pg-fn-appr-2',
      operationId: 'pg-fn-op-2',
    });

    const read = await board.fundingNotices({ asset: 'USDT', network: 'ethereum' });
    const mine = read.incidents.find((i) => i.root.id === root.id);
    expect(mine?.latest).toMatchObject({ id: update.id, phase: 'monitoring' });
    expect((await board.fundingNotices({ asset: 'USDT', network: 'tron' })).incidents.find((i) => i.root.id === root.id)).toBeUndefined();

    await expect(db()`UPDATE notify.notices SET network = 'tron' WHERE id = ${root.id}`).rejects.toMatchObject({ code: '23514' });
    await expect(db()`UPDATE notify.notices SET phase = 'identified' WHERE id = ${root.id}`).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects half a scope, scope on the wrong kind and a phase off the close flag at the table', async () => {
    await expect(
      db()`INSERT INTO notify.notices (kind, title, body, status, author_id, client_request_id, asset)
           VALUES ('incident', 'T', 'B', 'draft', ${AUTHOR}, 'pg-fn-bad-1', 'USDT')`,
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      db()`INSERT INTO notify.notices (kind, title, body, status, author_id, client_request_id, asset, network)
           VALUES ('announcement', 'T', 'B', 'draft', ${AUTHOR}, 'pg-fn-bad-2', 'USDT', 'ethereum')`,
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      db()`INSERT INTO notify.notices (kind, title, body, status, author_id, client_request_id, asset, network, phase)
           VALUES ('incident', 'T', 'B', 'draft', ${AUTHOR}, 'pg-fn-bad-3', 'USDT', 'ethereum', 'resolved')`,
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      db()`INSERT INTO notify.notices (kind, title, body, status, author_id, client_request_id, phase)
           VALUES ('incident', 'T', 'B', 'draft', ${AUTHOR}, 'pg-fn-bad-4', 'investigating')`,
    ).rejects.toMatchObject({ code: '23514' });
  });
});
