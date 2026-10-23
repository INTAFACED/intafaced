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
 * Paged reads of published notices on the real table (SP-api-01). Cleanup deletes only this file's author.
 */

const URL = process.env.TEST_DATABASE_URL_NOTIFY ?? process.env.TEST_DATABASE_URL;
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', 'drizzle');
const AUTHOR = '9a9e5000-1111-4111-8111-111111111111';
const APPROVER = '9a9e5000-2222-4222-8222-222222222222';

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
  if (name[0]?.db !== 'test') await assertTestDatabase(client, 'svc-notify notices-paging.pg.test');
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

describe.skipIf(!URL || !available)('paged published notices on the shared test database', () => {
  it('walks every published notice once, in order, through the cursor, ties on the same instant included', async () => {
    let now = new Date('2026-10-23T10:00:00.000Z');
    const store = new PostgresNoticeStore(db());
    const board = new NoticeBoard(store, new Approvals(), new PostgresCommandLog(db()), () => now);
    const mine: string[] = [];
    for (const [i, at] of ['2026-10-23T10:00:00.000Z', '2026-10-23T11:00:00.000Z', '2026-10-23T11:00:00.000Z'].entries()) {
      now = new Date(at);
      const draft = await board.draft(AUTHOR, {
        kind: 'changelog',
        title: `TEST page ${i}`,
        body: 'TEST',
        clientRequestId: `pg-page-${i}`,
      });
      await board.publish(AUTHOR, {
        id: draft.id,
        clientRequestId: `pg-page-${i}-pub`,
        approvalId: `pg-page-a${i}`,
        operationId: `pg-page-o${i}`,
      });
      mine.push(draft.id);
    }
    // Two rows published in the same microsecond: the cursor must still split them by id.
    await db()`ALTER TABLE notify.notices DISABLE TRIGGER notice_published_immutable`;
    try {
      await db()`UPDATE notify.notices SET published_at = (SELECT published_at FROM notify.notices WHERE id = ${mine[1]!}) WHERE id = ${mine[2]!}`;
    } finally {
      await db()`ALTER TABLE notify.notices ENABLE TRIGGER notice_published_immutable`;
    }

    const all = (await store.listPublished('changelog', 10_000)).map((row) => row.id);
    const walked: string[] = [];
    let after: string | null = null;
    for (let guard = 0; guard < 10_000; guard++) {
      const page: readonly { id: string }[] = await board.notices({ kind: 'changelog', limit: 2, after });
      walked.push(...page.map((n) => n.id));
      if (page.length < 2) break;
      after = page.at(-1)!.id;
    }
    expect(walked).toEqual(all);
    for (const id of mine) expect(walked.filter((w) => w === id)).toHaveLength(1);
    await expect(board.notices({ kind: 'announcement', limit: 2, after: mine[0]! })).rejects.toMatchObject({
      code: 'notify.notices_cursor_unknown',
    });
  });
});
