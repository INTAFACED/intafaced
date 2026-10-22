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
 * Locale on the real notices table (migration 0026, lead ruling D27 (1)) and the
 * announcements read over it. Cleanup deletes only this file's author.
 */

const URL = process.env.TEST_DATABASE_URL_NOTIFY ?? process.env.TEST_DATABASE_URL;
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', 'drizzle');
const AUTHOR = 'a77n0unc-1111-4111-8111-111111111111';
const APPROVER = 'a77n0unc-2222-4222-8222-222222222222';

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
  if (name[0]?.db !== 'test') await assertTestDatabase(client, 'svc-notify announcements.pg.test');
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

describe.skipIf(!URL || !available)('announcements on the shared test database', () => {
  it('locale is NOT NULL with default en, so existing rows backfill as en', async () => {
    const cols = await db()<{ is_nullable: string; column_default: string | null }[]>`
      SELECT is_nullable, column_default FROM information_schema.columns
       WHERE table_schema = 'notify' AND table_name = 'notices' AND column_name = 'locale'
    `;
    expect(cols[0]).toMatchObject({ is_nullable: 'NO' });
    expect(cols[0]?.column_default).toContain("'en'");
    const blank = await db()<{ n: number }[]>`SELECT count(*)::int AS n FROM notify.notices WHERE locale IS DISTINCT FROM 'en'`;
    expect(blank[0]?.n).toBe(0);
  });

  it('kind=changelog&locale=en returns only published en changelog; drafts never; locale frozen once published', async () => {
    const now = new Date('2026-10-17T10:00:00.000Z');
    const board = new NoticeBoard(new PostgresNoticeStore(db()), new Approvals(), new PostgresCommandLog(db()), () => now);
    const published = await board.draft(AUTHOR, {
      kind: 'changelog',
      title: 'Test announcements change',
      body: 'Test body',
      clientRequestId: 'pg-ann-1',
    });
    await board.publish(AUTHOR, {
      id: published.id,
      clientRequestId: 'pg-ann-1-pub',
      approvalId: 'pg-ann-appr-1',
      operationId: 'pg-ann-op-1',
    });
    const draft = await board.draft(AUTHOR, { kind: 'changelog', title: 'Test draft', body: 'Test body', clientRequestId: 'pg-ann-2' });
    const other = await board.draft(AUTHOR, { kind: 'announcement', title: 'Test other', body: 'Test body', clientRequestId: 'pg-ann-3' });
    await board.publish(AUTHOR, { id: other.id, clientRequestId: 'pg-ann-3-pub', approvalId: 'pg-ann-appr-3', operationId: 'pg-ann-op-3' });

    const read = await board.announcements({ kind: 'changelog', locale: 'en', limit: 100 });
    const ids = read.map((n) => n.id);
    expect(ids).toContain(published.id);
    expect(ids).not.toContain(draft.id);
    expect(ids).not.toContain(other.id);
    expect(read.every((n) => n.kind === 'changelog' && n.status === 'published')).toBe(true);

    const stored = await db()<{ locale: string }[]>`SELECT locale FROM notify.notices WHERE id = ${published.id}`;
    expect(stored[0]?.locale).toBe('en');
    await expect(board.announcements({ kind: 'changelog', locale: 'fr', limit: 10 })).rejects.toMatchObject({
      code: 'notify.notice_locale_unknown',
    });
    // The BEFORE UPDATE trigger runs ahead of the check constraint, so the message names the trigger.
    await expect(db()`UPDATE notify.notices SET locale = 'fr' WHERE id = ${published.id}`).rejects.toMatchObject({
      code: '23514',
      message: 'notify.notice_published_immutable',
    });
  });

  it('the table refuses a locale outside the allowed set', async () => {
    await expect(
      db()`INSERT INTO notify.notices (kind, title, body, status, author_id, client_request_id, locale)
           VALUES ('announcement', 'T', 'B', 'draft', ${AUTHOR}, 'pg-ann-bad-1', 'fr')`,
    ).rejects.toMatchObject({ code: '23514' });
  });
});
