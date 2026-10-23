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

/** The incident desk on the real notices table: open threads, and a resolution racing an update. Cleanup deletes only this file's author. */

const URL = process.env.TEST_DATABASE_URL_NOTIFY ?? process.env.TEST_DATABASE_URL;
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', 'drizzle');
const AUTHOR = 'de5c0000-1111-4111-8111-111111111111';
const APPROVER = 'de5c0000-2222-4222-8222-222222222222';

const available = URL ? await postgresAvailable(URL) : false;
const client: Sql | null = URL && available ? postgres(URL, { max: 3, onnotice: () => undefined }) : null;

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
      createdAt: '2026-10-23T00:00:00.000Z',
      expiresAt: '2026-10-23T01:00:00.000Z',
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
  if (name[0]?.db !== 'test') await assertTestDatabase(client, 'svc-notify incident-desk.pg.test');
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

describe.skipIf(!available)('incident desk on Postgres', () => {
  const run = Date.now().toString(36);
  let n = 0;
  const board = () => new NoticeBoard(new PostgresNoticeStore(db()), new Approvals(), new PostgresCommandLog(db()), () => new Date());
  const publish = async (b: NoticeBoard, input: Parameters<NoticeBoard['draft']>[1]) => {
    n += 1;
    const draft = await b.draft(AUTHOR, input);
    return b.publish(AUTHOR, {
      id: draft.id,
      clientRequestId: `pg-pub-${run}-${n}`,
      approvalId: `pg-appr-${run}-${n}`,
      operationId: `op-${n}`,
    });
  };
  const incident = { kind: 'incident', title: 'TEST pg incident', body: 'TEST looking', impact: 'minor', components: ['api'] };

  it('carries every entry of an open incident, and nothing of a resolved one', async () => {
    const b = board();
    const open = await publish(b, { ...incident, clientRequestId: `pg-open-${run}` });
    const update = await publish(b, {
      kind: 'incident',
      title: 'TEST',
      body: 'TEST still',
      parentId: open.id,
      clientRequestId: `pg-open-u-${run}`,
    });
    const closed = await publish(b, { ...incident, title: 'TEST pg closed', clientRequestId: `pg-closed-${run}` });
    await publish(b, {
      kind: 'incident',
      title: 'TEST',
      body: 'TEST fixed',
      parentId: closed.id,
      resolves: true,
      clientRequestId: `pg-closed-r-${run}`,
    });
    const ids = (await new PostgresNoticeStore(db()).openIncidentThreads(500)).map((row) => row.id);
    expect(ids).toEqual(expect.arrayContaining([open.id, update.id]));
    expect(ids).not.toContain(closed.id);
    expect(await new PostgresNoticeStore(db()).resolved(closed.id)).toBe(true);
    expect(await new PostgresNoticeStore(db()).resolved(open.id)).toBe(false);
  });

  it('an update whose publish waits on a resolution committing first is refused, not published after it', async () => {
    const b = board();
    const root = await publish(b, { ...incident, title: 'TEST pg race', clientRequestId: `pg-race-${run}` });
    const resolving = await b.draft(AUTHOR, {
      kind: 'incident',
      title: 'TEST',
      body: 'TEST resolved',
      parentId: root.id,
      resolves: true,
      clientRequestId: `pg-race-r-${run}`,
    });
    const late = await b.draft(AUTHOR, {
      kind: 'incident',
      title: 'TEST',
      body: 'TEST late',
      parentId: root.id,
      clientRequestId: `pg-race-l-${run}`,
    });
    const store = new PostgresNoticeStore(db());
    let lateOutcome: Promise<unknown> | null = null;
    await db().begin(async (tx) => {
      // The resolution holds the incident, as markPublished does, and is not yet committed when the late update starts.
      await tx`SELECT id FROM notify.notices WHERE id = ${root.id} FOR UPDATE`;
      await tx`UPDATE notify.notices SET status = 'published', published_at = now(), approval_id = ${`pg-race-${run}`} WHERE id = ${resolving.id}`;
      lateOutcome = store
        .markPublished(late.id, { publishedAt: new Date(), approvalId: `pg-late-${run}`, publishClientRequestId: `pg-late-${run}` })
        .then(
          () => 'published',
          (err: { code?: string }) => err.code,
        );
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    expect(await lateOutcome).toBe('notify.notice_incident_resolved');
    const [row] = await db()<{ status: string }[]>`SELECT status FROM notify.notices WHERE id = ${late.id}`;
    expect(row?.status).toBe('draft');
  });
});
