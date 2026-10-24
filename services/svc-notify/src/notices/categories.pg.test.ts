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

/** Notice categories on the real table: stored as written, read back on every read, and held once published. */

const URL = process.env.TEST_DATABASE_URL_NOTIFY ?? process.env.TEST_DATABASE_URL;
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle');
const AUTHOR = 'de5c0000-5555-4555-8555-555555555555';
const APPROVER = 'de5c0000-6666-4666-8666-666666666666';

const available = URL ? await postgresAvailable(URL) : false;
const client: Sql | null = URL && available ? postgres(URL, { max: 4, onnotice: () => undefined }) : null;

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
      createdAt: '2026-10-23T00:00:00.000Z',
      expiresAt: '2026-10-23T01:00:00.000Z',
      status: 'CONSUMED',
      operationId: input.operationId,
    };
  }
}

async function cleanup(sql: Sql): Promise<void> {
  const mine = sql`SELECT id FROM notify.notices WHERE author_id = ${AUTHOR}`;
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
  if (name[0]?.db !== 'test') await assertTestDatabase(client, 'svc-notify categories.pg.test');
  for (const file of readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
    .sort()) {
    await client.unsafe(readFileSync(join(migrationsDir, file), 'utf8')).catch(() => undefined);
  }
  await cleanup(client);
});

afterAll(async () => {
  if (!client) return;
  await cleanup(client).catch(() => undefined);
  await client.end({ timeout: 1 }).catch(() => undefined);
});

if (!available) {
  describe.skip('notice categories on Postgres (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else
  describe('notice categories on Postgres', () => {
    const run = Date.now().toString(36);
    const category = { id: 'pg-test-listings', name: 'TEST listings' };
    const board = () =>
      new NoticeBoard(
        new PostgresNoticeStore(client!),
        new Approvals(),
        new PostgresCommandLog(client!),
        () => new Date(),
        async () => [],
        async () => undefined,
        async () => new Set(),
        async () => [category],
      );

    it('stores the category with the notice, reads it back, and the published row keeps it', async () => {
      const b = board();
      const draft = await b.draft(AUTHOR, {
        kind: 'announcement',
        title: `TEST pg category ${run}`,
        body: 'TEST',
        category: category.id,
        clientRequestId: `pg-cat-${run}`,
      });
      expect(draft.category).toEqual(category);
      await b.publish(AUTHOR, { id: draft.id, clientRequestId: `pg-cat-p-${run}`, approvalId: `pg-cat-a-${run}`, operationId: 'o' });
      expect((await board().notice(draft.id)).category).toEqual(category);
      await expect(client!`UPDATE notify.notices SET category = NULL WHERE id = ${draft.id}`).rejects.toThrow(/notice_published_immutable/);
      const plain = await b.draft(AUTHOR, { kind: 'announcement', title: 'TEST', body: 'TEST', clientRequestId: `pg-cat-none-${run}` });
      expect(plain.category).toBeNull();
    });
  });
