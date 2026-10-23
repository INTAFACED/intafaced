import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresSupportStore } from './store.js';

/**
 * SP-tickets-07 — the merge is one transaction on the real schema: the move, the source's close, the link and a trail row on
 * both requests land together or not at all; a replay moves nothing twice; two merges over one pair cannot both win.
 * Per-run database, like status-pair-enum.pg.test.ts.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL_SUPPORT_ADMIN ?? 'postgres://127.0.0.1:5432/postgres';
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'drizzle');
const database = `svc_support_merge_${process.pid}_${Math.random().toString(36).slice(2, 10)}_test`;

if (database === 'intafaced_test' || !database.endsWith('_test') || !/^[a-z0-9_]+$/.test(database)) {
  throw new Error(`refusing database name ${database}`);
}

const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => undefined });
let sql: postgres.Sql;
let store: PostgresSupportStore;
let created = false;

const OP = '33333333-3333-4333-8333-333333333333';

async function ticket(userId: string, status = 'open'): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO support.tickets (user_id, category, subject, body, status) VALUES (${userId}, 'account', 'dup', 'body', ${status})
    RETURNING id
  `;
  await sql`
    INSERT INTO support.ticket_events (ticket_id, sequence, kind, actor_id, actor_role) VALUES (${rows[0]!.id}, 1, 'opened', ${userId}, 'user')
  `;
  return rows[0]!.id;
}

beforeAll(async () => {
  await admin.unsafe(`CREATE DATABASE "${database}"`);
  created = true;
  const url = new URL(ADMIN_URL);
  url.pathname = `/${database}`;
  sql = postgres(url.toString(), { max: 4, onnotice: () => undefined });
  await sql.unsafe('CREATE SCHEMA IF NOT EXISTS support');
  const ups = readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
    .sort();
  for (const file of ups) await sql.unsafe(readFileSync(join(migrationsDir, file), 'utf8'));
  store = new PostgresSupportStore(sql);
});

afterAll(async () => {
  if (sql) await sql.end({ timeout: 5 });
  if (created) await admin.unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  await admin.end({ timeout: 5 });
});

describe('mergeTickets on the real schema', () => {
  it('moves comments and files, closes the source, links it and writes a merge row on both trails', async () => {
    const src = await ticket('merge-user-a');
    const win = await ticket('merge-user-a');
    await sql`INSERT INTO support.comments (ticket_id, author_id, author_role, body) VALUES (${src}, 'merge-user-a', 'user', 'one'), (${src}, ${OP}, 'operator', 'two')`;
    await sql`
      INSERT INTO support.ticket_attachments (ticket_id, owner_id, client_request_id, store_key, content_type, byte_length)
      VALUES (${src}, 'merge-user-a', 'merge-file-1', 'k', 'image/png', 3)
    `;

    const res = await store.mergeTickets({ sourceId: src, survivorId: win, operatorId: OP, reason: 'same issue' });
    expect(res).toMatchObject({ status: 'ok', replay: false, merge: { commentsMoved: 2, attachmentsMoved: 1 } });

    expect((await store.listComments(src)).length).toBe(0);
    expect((await store.listComments(win)).map((c) => c.body)).toEqual(['one', 'two']);
    expect(await store.listAttachmentsFor(win, 10)).toHaveLength(1);
    expect((await store.findById(src))?.status).toBe('closed');
    expect((await store.findMergeBySource(src))?.survivorId).toBe(win);
    expect((await store.listEvents(src)).map((e) => e.kind)).toEqual(['opened', 'merged', 'status_changed']);
    expect((await store.listEvents(win)).map((e) => e.kind)).toEqual(['opened', 'merged']);
  });

  it('answers a replay with the stored merge and writes nothing more', async () => {
    const src = await ticket('merge-user-b');
    const win = await ticket('merge-user-b');
    const first = await store.mergeTickets({ sourceId: src, survivorId: win, operatorId: OP, reason: 'dup' });
    const again = await store.mergeTickets({ sourceId: src, survivorId: win, operatorId: OP, reason: 'other words' });
    expect(again).toMatchObject({ status: 'ok', replay: true });
    expect(again.status === 'ok' && first.status === 'ok' && again.merge).toEqual(first.status === 'ok' ? first.merge : null);
    expect(await store.listEvents(src)).toHaveLength(3);
    expect(await store.listEvents(win)).toHaveLength(2);
  });

  it('refuses a resolved, closed, foreign or already-merged request and changes nothing', async () => {
    const live = await ticket('merge-user-c');
    const resolved = await ticket('merge-user-c', 'resolved');
    const closed = await ticket('merge-user-c', 'closed');
    const foreign = await ticket('merge-user-d');
    for (const [s, w] of [
      [live, resolved],
      [resolved, live],
      [live, closed],
      [closed, live],
      [live, foreign],
    ] as const) {
      expect(await store.mergeTickets({ sourceId: s, survivorId: w, operatorId: OP, reason: 'dup' })).toEqual({
        status: 'refuse',
        reason: 'not_allowed',
      });
    }
    expect(await store.listEvents(live)).toHaveLength(1);
    expect(await store.findMergeBySource(live)).toBeNull();

    const win = await ticket('merge-user-c');
    const third = await ticket('merge-user-c');
    await store.mergeTickets({ sourceId: live, survivorId: win, operatorId: OP, reason: 'dup' });
    expect(await store.mergeTickets({ sourceId: live, survivorId: third, operatorId: OP, reason: 'dup' })).toEqual({
      status: 'refuse',
      reason: 'not_allowed',
    });
    expect(
      await store.mergeTickets({ sourceId: live, survivorId: '77777777-7777-4777-8777-777777777777', operatorId: OP, reason: 'x' }),
    ).toEqual({
      status: 'refuse',
      reason: 'not_found',
    });
  });

  it('lets exactly one of two crossing merges win and leaves no stray rows', async () => {
    const a = await ticket('merge-user-e');
    const b = await ticket('merge-user-e');
    const [x, y] = await Promise.all([
      store.mergeTickets({ sourceId: a, survivorId: b, operatorId: OP, reason: 'dup' }),
      store.mergeTickets({ sourceId: b, survivorId: a, operatorId: OP, reason: 'dup' }),
    ]);
    expect([x.status, y.status].sort()).toEqual(['ok', 'refuse']);
    const merges = await sql`SELECT source_id FROM support.ticket_merges WHERE source_id IN (${a}, ${b})`;
    expect(merges).toHaveLength(1);
  });

  it('keeps the trail append-only: the merge rows cannot be changed afterwards', async () => {
    const src = await ticket('merge-user-f');
    const win = await ticket('merge-user-f');
    await store.mergeTickets({ sourceId: src, survivorId: win, operatorId: OP, reason: 'dup' });
    await expect(sql`UPDATE support.ticket_events SET note = 'x' WHERE ticket_id = ${win} AND kind = 'merged'`).rejects.toThrow();
  });
});
