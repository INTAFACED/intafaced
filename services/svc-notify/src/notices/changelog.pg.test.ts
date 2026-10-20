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
 * Changelog fields on the real notices table. Cleanup deletes only this file's author.
 */

const URL = process.env.TEST_DATABASE_URL_NOTIFY ?? process.env.TEST_DATABASE_URL;
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', 'drizzle');
const AUTHOR = 'ch4ng3l0-1111-4111-8111-111111111111';
const APPROVER = 'ch4ng3l0-2222-4222-8222-222222222222';

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
    await sql`DELETE FROM notify.notices WHERE author_id = ${AUTHOR}`;
    await sql`DELETE FROM notify.preference_commands WHERE user_id = ${AUTHOR}`;
  } finally {
    await sql`ALTER TABLE notify.notices ENABLE TRIGGER notice_published_immutable`;
  }
}

beforeAll(async () => {
  if (!client) return;
  const name = await client<{ db: string }[]>`SELECT current_database() AS db`;
  if (name[0]?.db !== 'test') await assertTestDatabase(client, 'svc-notify changelog.pg.test');
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

describe.skipIf(!URL || !available)('changelog on the shared test database', () => {
  it('stores the fields, reads them back by area and as upcoming, and freezes them once published', async () => {
    const now = new Date('2026-10-17T10:00:00.000Z');
    const board = new NoticeBoard(new PostgresNoticeStore(db()), new Approvals(), new PostgresCommandLog(db()), () => now);
    const draft = await board.draft(AUTHOR, {
      kind: 'changelog',
      title: 'Test change',
      body: 'Test body',
      changelog: {
        area: 'trading',
        breaking: true,
        releaseOn: '2026-11-01',
        migrationNote: 'Send the new field.',
        retired: ['/v1/old-test'],
      },
      clientRequestId: 'pg-cl-1',
    });
    await board.publish(AUTHOR, { id: draft.id, clientRequestId: 'pg-cl-1-pub', approvalId: 'pg-cl-appr-1', operationId: 'pg-cl-op-1' });

    const mine = (await board.changelog({ area: 'trading', limit: 50 })).find((e) => e.id === draft.id);
    expect(mine?.changelog).toMatchObject({ area: 'trading', breaking: true, releaseOn: '2026-11-01', retired: ['/v1/old-test'] });
    const read = await board.upcomingChanges();
    expect(read.upcoming.some((e) => e.id === draft.id)).toBe(true);
    expect(read.retired.find((r) => r.endpoint === '/v1/old-test')?.entryId).toBe(draft.id);

    await expect(db()`UPDATE notify.notices SET changelog = '{}'::jsonb WHERE id = ${draft.id}`).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects changelog fields on the wrong kind at the table', async () => {
    await expect(
      db()`INSERT INTO notify.notices (kind, title, body, status, author_id, client_request_id, changelog)
           VALUES ('announcement', 'T', 'B', 'draft', ${AUTHOR}, 'pg-cl-bad-1', '{"area":"fix"}'::jsonb)`,
    ).rejects.toMatchObject({ code: '23514' });
  });
});
