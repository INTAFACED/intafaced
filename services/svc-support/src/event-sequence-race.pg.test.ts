import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresSupportStore } from './store.js';

/**
 * Two trail rows written at once on one ticket both land, with distinct sequences.
 *
 * The ticket page reads the customer's account state (a `grounding_read` row) while the agent asks for the charts
 * lookup (a `charts_lookup` row, J-charts-desk-19 #1). Each row takes MAX(sequence) + 1; without the ticket row lock
 * both would read the same MAX, one would fail the (ticket_id, sequence) unique index, and the lookup would be refused
 * `support.charts_lookup_unaudited`. The test holds the ticket lock so every writer is queued with the same snapshot
 * in view, then commits it: each must land after it, numbered 3..n+2. Without the lock every writer reads the
 * same MAX, waits on the holder's uncommitted index entry and then fails the unique index, every run. Same per-run database shape as settle-under-lock.pg.test.ts.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL_SUPPORT_ADMIN ?? 'postgres://127.0.0.1:5432/postgres';
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'drizzle');
const database = `svc_support_9144_${process.pid}_${Math.random().toString(36).slice(2, 10)}_test`;

const USER = '11111111-1111-4111-8111-111111111111';
const OP = '33333333-3333-4333-8333-333333333333';
const WRITERS = 6;

if (database === 'intafaced_test' || !database.endsWith('_test') || !/^[a-z0-9_]+$/.test(database)) {
  throw new Error(`refusing database name ${database}`);
}

const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => undefined });
let sql: postgres.Sql;
let created = false;

beforeAll(async () => {
  const adminDb = await admin<{ db: string }[]>`SELECT current_database() AS db`;
  if (adminDb[0]?.db !== 'postgres') throw new Error(`admin connection is on ${adminDb[0]?.db ?? '<none>'}, expected postgres`);
  await admin.unsafe(`CREATE DATABASE "${database}"`);
  created = true;
  const url = new URL(ADMIN_URL);
  url.pathname = `/${database}`;
  sql = postgres(url.toString(), { max: WRITERS + 2, onnotice: () => undefined });
  const live = await sql<{ db: string }[]>`SELECT current_database() AS db`;
  if (live[0]?.db !== database || !live[0]?.db.endsWith('_test')) throw new Error(`refusing to migrate ${live[0]?.db ?? '<none>'}`);
  await sql.unsafe('CREATE SCHEMA IF NOT EXISTS support');
  for (const file of readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
    .sort()) {
    await sql.unsafe(readFileSync(join(migrationsDir, file), 'utf8'));
  }
});

afterAll(async () => {
  if (sql) await sql.end({ timeout: 5 });
  if (created) await admin.unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  await admin.end({ timeout: 5 });
});

/**
 * True once `n` sessions in this database are waiting on a lock. A lock wait emits no event, so this asks the server
 * itself, one round trip at a time, up to `tries` asks: no clock is involved.
 */
async function waiting(n: number, tries: number): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    const rows = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'
    `;
    if (Number(rows[0]?.n ?? 0) >= n) return true;
  }
  return false;
}

describe('concurrent trail rows on one ticket', () => {
  it('lands every row written at once, each with its own next sequence', async () => {
    const store = new PostgresSupportStore(sql);
    const ticket = await store.createTicket({ userId: USER, category: 'other', subject: 'S', body: 'B' });

    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    // Another trail write on this ticket, still open: it holds the ticket row and has taken sequence 2, uncommitted.
    let held!: () => void;
    const holding = new Promise<void>((resolve) => (held = resolve));
    const holder = sql.begin(async (tx) => {
      await tx`SELECT 1 FROM support.tickets WHERE id = ${ticket.id} FOR UPDATE`;
      await tx`
        INSERT INTO support.ticket_events (ticket_id, sequence, kind, actor_id, actor_role)
        SELECT ${ticket.id}, COALESCE(MAX(sequence), 0) + 1, 'grounding_read', ${OP}, 'operator'
        FROM support.ticket_events WHERE ticket_id = ${ticket.id}
      `;
      held();
      await released;
    });
    await holding;

    const writes = Array.from({ length: WRITERS }, (_, i) =>
      store.appendEvent({
        ticketId: ticket.id,
        kind: i % 2 === 0 ? 'grounding_read' : 'charts_lookup',
        actorId: OP,
        actorRole: 'operator',
        note: `writer:${i}`,
      }),
    );
    expect(await waiting(WRITERS, 20_000)).toBe(true);
    release();
    await holder;

    const settled = await Promise.allSettled(writes);
    expect(settled.filter((s) => s.status === 'rejected')).toEqual([]);
    const sequences = settled.flatMap((s) => (s.status === 'fulfilled' ? [s.value.sequence] : [])).sort((a, b) => a - b);
    // `opened` is row 1 and the holder's row is 2.
    expect(sequences).toEqual(Array.from({ length: WRITERS }, (_, i) => i + 3));
    const trail = await store.listEvents(ticket.id);
    expect(trail.map((e) => e.sequence)).toEqual(Array.from({ length: WRITERS + 2 }, (_, i) => i + 1));
  });
});
