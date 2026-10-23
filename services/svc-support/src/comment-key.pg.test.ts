import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';
import { assertTestDatabase, postgresAvailable } from '@intafaced/db';
import { PostgresSupportStore } from './store.js';

/**
 * A comment's key and the requester cap on the real tables (SP-api-01): the receipt is written with the comment, and
 * the cap is counted under the ticket lock, so two comments at once cannot both pass it.
 */

const URL = process.env.TEST_DATABASE_URL_SUPPORT ?? 'postgres://svc_support:svc_support@localhost:5433/intafaced_test';
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'drizzle');
const USER = '5c0e0e00-1111-4111-8111-111111111111';

const available = await postgresAvailable(URL);
const sql = available ? postgres(URL, { max: 4, onnotice: () => undefined }) : null;

if (available && sql) {
  await assertTestDatabase(sql, 'svc-support comment-key.pg.test');
  await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS support`).catch(() => undefined);
  for (const file of readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
    .sort()) {
    await sql.unsafe(readFileSync(join(migrationsDir, file), 'utf8')).catch(() => undefined);
  }
}

afterAll(async () => {
  if (sql) await sql.end({ timeout: 5 });
});

describe.skipIf(!available)('comment key and cap on Postgres', () => {
  const store = () => new PostgresSupportStore(sql!);
  const open = () => store().createTicket({ userId: USER, category: 'account', subject: 'TEST', body: 'TEST' });
  const key = (n: string) => `pg-comment-key:${Date.now().toString(36)}:${n}`;

  it('the same key twice is one comment and one receipt; other text under it refuses', async () => {
    const t = await open();
    const k = key('a');
    const input = { ticketId: t.id, authorId: USER, authorRole: 'user' as const, body: 'TEST from code', clientRequestId: k, userCap: 5 };
    const [a, b] = await Promise.all([store().addComment(input), store().addComment(input)]);
    expect(a.status === 'ok' && b.status === 'ok').toBe(true);
    if (a.status !== 'ok' || b.status !== 'ok') return;
    expect(b.comment).toEqual(a.comment);
    expect([a.replay ?? false, b.replay ?? false].sort()).toEqual([false, true]);
    // While it is still the request's last write, the replay's comment carries the request's moment: the service then
    // settles the lifecycle again.
    const replayed = a.replay ? a : b;
    expect(replayed.ticket.updatedAt).toBe(replayed.comment.createdAt);
    expect(await store().listComments(t.id)).toHaveLength(1);
    expect(await store().addComment({ ...input, body: 'TEST changed' })).toEqual({ status: 'refuse', reason: 'idempotency_conflict' });
    const receipts =
      await sql!`SELECT count(*)::int AS n FROM support.write_receipts WHERE procedure = 'support.comment' AND client_request_id = ${k}`;
    expect(receipts[0]?.n).toBe(1);
  });

  it('two comments at once with one place left under the cap: one lands, one refuses cap_reached', async () => {
    const t = await open();
    await store().addComment({ ticketId: t.id, authorId: USER, authorRole: 'user', body: 'TEST 1', userCap: 2 });
    const both = await Promise.all(
      ['x', 'y'].map((n) => store().addComment({ ticketId: t.id, authorId: USER, authorRole: 'user', body: `TEST ${n}`, userCap: 2 })),
    );
    expect(both.map((r) => (r.status === 'ok' ? 'ok' : r.reason)).sort()).toEqual(['cap_reached', 'ok']);
    expect(await store().listComments(t.id)).toHaveLength(2);
    // Blank (null) refuses a new requester comment; the team is not counted and not capped.
    expect(await store().addComment({ ticketId: t.id, authorId: USER, authorRole: 'user', body: 'TEST z', userCap: null })).toEqual({
      status: 'refuse',
      reason: 'cap_unset',
    });
    expect((await store().addComment({ ticketId: t.id, authorId: USER, authorRole: 'operator', body: 'TEST answer' })).status).toBe('ok');
  });
});
