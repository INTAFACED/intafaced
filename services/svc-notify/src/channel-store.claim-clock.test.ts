/**
 * claim() decides a miss with Postgres now(), then classifies that row.
 * Classifying with Date.now() lets an app clock ahead of the database call a
 * lease the UPDATE still considers live a terminal miss. The bus acks, and
 * the pending row has nothing left to claim it.
 *
 * No skip: an unreachable database fails this file. Migrations run on a
 * per-run database, never on intafaced_test.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';
import { PostgresDeliveryStore } from './channel-store.js';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = [
  '0000_notify_init.sql',
  '0001_notify_channels.sql',
  '0002_notify_delivery_accepted.sql',
  '0003_notify_mute_prefs.sql',
  '0004_notify_delivery_claim_lease.sql',
].map((name) => readFileSync(join(PKG, 'drizzle', name), 'utf8'));

const ADMIN_CANDIDATES = [
  process.env.TEST_DATABASE_URL,
  'postgres://127.0.0.1:5432/postgres',
  'postgres://intafaced_ops:intafaced_ops@127.0.0.1:5433/intafaced_test',
].filter((value): value is string => typeof value === 'string' && value.length > 0);

interface Isolated {
  name: string;
  sql: postgres.Sql;
  drop: () => Promise<void>;
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function databaseName(url: string): string {
  return new URL(url).pathname.replace(/^\//, '');
}

function assertIsolated(url: string): void {
  const name = databaseName(url);
  if (!/^[a-z][a-z0-9_]*_test$/.test(name) || name === 'intafaced_test') {
    throw new Error(`refusing to migrate ${name}`);
  }
}

async function openAdmin(): Promise<{ sql: postgres.Sql; url: string } | null> {
  for (const url of ADMIN_CANDIDATES) {
    const sql = postgres(url, { max: 1, connect_timeout: 2, onnotice: () => undefined });
    try {
      const rows = await sql<{ ok: boolean }[]>`
        SELECT (rolcreatedb OR rolsuper) AS ok
        FROM pg_roles
        WHERE rolname = current_user
      `;
      if (rows[0]?.ok) return { sql, url };
    } catch {
      // This candidate is down or refused. Try the next one.
    }
    await sql.end({ timeout: 1 }).catch(() => undefined);
  }
  return null;
}

const admin = await openAdmin();
if (!admin) {
  throw new Error('Postgres is required for the claim clock check');
}

function freshName(): string {
  const name = `l1168_notify_${process.pid}_${Math.random().toString(36).slice(2, 8)}_test`;
  if (!/^[a-z][a-z0-9_]*_test$/.test(name)) throw new Error(`unsafe database name ${name}`);
  return name;
}

async function provision(): Promise<Isolated> {
  const name = freshName();
  await admin!.sql.unsafe(`CREATE DATABASE "${name}"`);
  const url = withDatabase(admin!.url, name);
  assertIsolated(url);
  const sql = postgres(url, { max: 4, onnotice: () => undefined });
  try {
    const rows = await sql<{ db: string }[]>`SELECT current_database() AS db`;
    if (rows[0]?.db !== name) throw new Error(`connected to ${rows[0]?.db}, wanted ${name}`);
    await sql.unsafe('CREATE SCHEMA IF NOT EXISTS notify');
    for (const migration of MIGRATIONS) {
      await sql.unsafe(migration);
    }
  } catch (err) {
    await sql.end({ timeout: 1 }).catch(() => undefined);
    await admin!.sql.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => undefined);
    throw err;
  }
  return {
    name,
    sql,
    drop: async () => {
      await sql.end({ timeout: 1 }).catch(() => undefined);
      await admin!.sql.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    },
  };
}

afterAll(async () => {
  await admin.sql.end({ timeout: 1 }).catch(() => undefined);
});

describe('PostgresDeliveryStore claim clock', () => {
  it('keeps a lease the database still considers live claimable when the app clock is ahead', async () => {
    const isolated = await provision();
    try {
      const [note] = await isolated.sql<{ id: string }[]>`
        INSERT INTO notify.notifications (
          user_id, kind, title_key, body_key, severity, source_subject, source_idempotency_key
        ) VALUES (
          'user-claim-clock',
          'bank.margin_call',
          'notify.bank.margin_call.title',
          'notify.bank.margin_call.body',
          'critical',
          'intafaced.bank.margin_call.created',
          'claim-clock-1'
        )
        RETURNING id
      `;
      const noteId = note!.id;
      const store = new PostgresDeliveryStore(isolated.sql);

      const first = await store.claim(noteId, 'email', 3);
      expect(first.claimed).toBe(true);

      const [held] = await isolated.sql<{ lease_until: Date; live: boolean; attempts: number; status: string }[]>`
        SELECT lease_until, lease_until > now() AS live, attempts, status
          FROM notify.deliveries
         WHERE notification_id = ${noteId} AND channel = 'email'
      `;
      expect(held?.live).toBe(true);
      expect(held?.status).toBe('pending');
      expect(held?.attempts).toBe(1);
      const leaseUntil = held!.lease_until;
      expect(leaseUntil).toBeInstanceOf(Date);

      // App clock past the lease. Postgres now() is still before lease_until,
      // so the claim UPDATE must miss and the follow-up must say in_flight.
      const realNow = Date.now;
      Date.now = () => leaseUntil.getTime() + 1;
      try {
        const second = await store.claim(noteId, 'email', 3);
        expect(second.claimed).toBe(false);
        if (second.claimed) return;
        expect(second.reason).toBe('in_flight');
        expect(second.record.attempts).toBe(1);
        expect(second.record.status).toBe('pending');
      } finally {
        Date.now = realNow;
      }

      const [still] = await isolated.sql<{ live: boolean; status: string; attempts: number }[]>`
        SELECT lease_until > now() AS live, status, attempts
          FROM notify.deliveries
         WHERE notification_id = ${noteId} AND channel = 'email'
      `;
      expect(still).toMatchObject({ live: true, status: 'pending', attempts: 1 });

      // The database, not the app clock, is what ends the lease. Once it has,
      // the same row is still there to claim.
      await isolated.sql`
        UPDATE notify.deliveries
           SET lease_until = now()
         WHERE notification_id = ${noteId} AND channel = 'email'
      `;
      const third = await store.claim(noteId, 'email', 3);
      expect(third.claimed).toBe(true);
      if (!third.claimed) return;
      expect(third.attempt).toBe(2);
    } finally {
      await isolated.drop();
    }
  });
});
