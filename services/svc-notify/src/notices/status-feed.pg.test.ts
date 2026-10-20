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
 * Status fields on the real notices table. Cleanup deletes only this file's author.
 */

const URL = process.env.TEST_DATABASE_URL_NOTIFY ?? process.env.TEST_DATABASE_URL;
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', 'drizzle');
const AUTHOR = 'st4tu500-1111-4111-8111-111111111111';
const APPROVER = 'st4tu500-2222-4222-8222-222222222222';

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
  if (name[0]?.db !== 'test') await assertTestDatabase(client, 'svc-notify status-feed.pg.test');
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

describe.skipIf(!URL || !available)('status feed on the shared test database', () => {
  it('stores impact, components and the update thread, builds the feed, and freezes them once published', async () => {
    let now = new Date('2026-10-17T10:00:00.000Z');
    const board = new NoticeBoard(new PostgresNoticeStore(db()), new Approvals(), new PostgresCommandLog(db()), () => now);
    const root = await board.draft(AUTHOR, {
      kind: 'incident',
      title: 'Test incident',
      body: 'Test body',
      impact: 'major',
      components: ['api', 'webhooks'],
      clientRequestId: 'pg-st-root',
    });
    await board.publish(AUTHOR, { id: root.id, clientRequestId: 'pg-st-root-pub', approvalId: 'pg-st-appr-1', operationId: 'pg-st-op-1' });
    now = new Date('2026-10-17T10:45:00.000Z');
    const update = await board.draft(AUTHOR, {
      kind: 'incident',
      title: 'Test incident',
      body: 'Test update',
      parentId: root.id,
      impact: 'minor',
      components: ['api'],
      resolves: false,
      clientRequestId: 'pg-st-child',
    });
    await board.publish(AUTHOR, {
      id: update.id,
      clientRequestId: 'pg-st-child-pub',
      approvalId: 'pg-st-appr-2',
      operationId: 'pg-st-op-2',
    });

    now = new Date('2026-10-17T11:00:00.000Z');
    const feed = await board.statusFeed({ days: 1 });
    const mine = feed.incidents.find((i) => i.id === root.id);
    expect(mine).toMatchObject({ impact: 'minor', components: ['api'], resolvedAt: null });
    expect(mine?.updates.map((u) => u.id)).toEqual([root.id, update.id]);
    expect(feed.components.find((c) => c.component === 'api')?.basis).toBe('incident');

    await expect(db()`UPDATE notify.notices SET impact = 'none' WHERE id = ${root.id}`).rejects.toMatchObject({ code: '23514' });
    await expect(db()`UPDATE notify.notices SET components = '{console}' WHERE id = ${root.id}`).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects status fields on the wrong kind and an unknown component at the table', async () => {
    await expect(
      db()`INSERT INTO notify.notices (kind, title, body, status, author_id, client_request_id, impact)
           VALUES ('announcement', 'T', 'B', 'draft', ${AUTHOR}, 'pg-st-bad-1', 'minor')`,
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      db()`INSERT INTO notify.notices (kind, title, body, status, author_id, client_request_id, impact, components)
           VALUES ('incident', 'T', 'B', 'draft', ${AUTHOR}, 'pg-st-bad-2', 'minor', '{database}')`,
    ).rejects.toMatchObject({ code: '23514' });
  });
});
