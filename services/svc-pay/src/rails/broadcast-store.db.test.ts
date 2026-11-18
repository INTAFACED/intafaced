/**
 * Two postgres.js clients, one key — the replica-safety the fake SQL suite
 * cannot prove. INSERT ON CONFLICT is the lock; two processes cannot both
 * `mine`, and runDurableBroadcast therefore signs once.
 *
 * H8a PG-hard: this file never `describe.skip` / `postgresAvailable`. CI uses
 * TEST_DATABASE_URL (per-run database via `createTestDatabase` so schema-qualified
 * `pay.*` SQL stays on `pay`). Local without that env starts Testcontainers
 * `postgres:16-alpine`. Docker/PG down is a failed suite, not a green skip.
 * The admin URL is `TEST_DATABASE_URL`, not `TEST_DATABASE_URL_PAY`: creating a
 * database needs CREATEDB, which the per-service roles deliberately lack.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PostgresBroadcastStore } from './broadcast-store.js';
import { BroadcastClosedError, runDurableBroadcast } from './durable-broadcast.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const H8A_IMAGE = 'postgres:16-alpine';
const opts = { pollMs: 10, maxWaits: 80 } as const;

async function openH8aAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) {
    return { url: envUrl, stop: async () => undefined };
  }

  try {
    const container = await new PostgreSqlContainer(H8A_IMAGE)
      .withDatabase('intafaced_h8a_test')
      .withUsername('intafaced')
      .withPassword('intafaced')
      .start();
    return {
      url: container.getConnectionUri(),
      stop: async () => {
        await container.stop();
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `H8a: svc-pay broadcast-store is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

describe('svc-pay broadcast-store (source)', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

describe('PostgresBroadcastStore — two connections cannot double-send', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sqlA!: TestDatabase['sql'];
  let sqlB: ReturnType<typeof postgres> | undefined;

  beforeAll(async () => {
    const admin = await openH8aAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    sqlA = db.sql;
    sqlB = postgres(db.url, {
      max: 4,
      connection: { search_path: 'pay,public', application_name: `${db.database}-b` },
      onnotice: () => undefined,
    });
  }, 120_000);

  beforeEach(async () => {
    if (!db || !sqlA) throw new Error('H8a: svc-pay broadcast-store PG was not opened');
    await sqlA`TRUNCATE pay.crypto_broadcasts RESTART IDENTITY CASCADE`;
  });

  afterAll(async () => {
    await sqlB?.end({ timeout: 0 }).catch(() => undefined);
    await db?.drop();
    await adminStop();
  }, 30_000);

  it('exactly one concurrent claimer gets mine; the other converges on the same hash', async () => {
    if (!sqlB) throw new Error('H8a: svc-pay broadcast-store PG was not opened');
    const a = new PostgresBroadcastStore(sqlA, opts);
    const b = new PostgresBroadcastStore(sqlB, opts);
    const kinds: string[] = [];

    await Promise.all(
      [a, b].map((store) =>
        store.claim('payout:e13:db:1').then(async (claim) => {
          kinds.push(claim.kind);
          if (claim.kind === 'mine') {
            await store.putSigned('payout:e13:db:1', '0xraw');
            await store.put('payout:e13:db:1', '0xabc');
          } else if (claim.kind === 'resume') {
            expect(claim.signedRaw).toBe('0xraw');
            await store.put('payout:e13:db:1', '0xabc');
          } else {
            expect(claim).toEqual({ kind: 'done', txHash: '0xabc' });
          }
        }),
      ),
    );

    expect(kinds.filter((k) => k === 'mine')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'done' || k === 'resume')).toHaveLength(1);
    expect(await a.get('payout:e13:db:1')).toBe('0xabc');
    expect(await b.get('payout:e13:db:1')).toBe('0xabc');
  });

  it('fail-first: two identical keys → sign once, one hash', async () => {
    if (!sqlB) throw new Error('H8a: svc-pay broadcast-store PG was not opened');
    const a = new PostgresBroadcastStore(sqlA, opts);
    const b = new PostgresBroadcastStore(sqlB, opts);
    const sign = vi.fn(async () => '0xraw-once');
    const broadcast = vi.fn(async (raw: string) => {
      expect(raw).toBe('0xraw-once');
      return '0xhash-once';
    });

    const [ha, hb] = await Promise.all([
      runDurableBroadcast({ store: a, idempotencyKey: 'payout:e13:db:2', sign, broadcast }),
      runDurableBroadcast({ store: b, idempotencyKey: 'payout:e13:db:2', sign, broadcast }),
    ]);

    expect(ha).toBe('0xhash-once');
    expect(hb).toBe('0xhash-once');
    expect(sign).toHaveBeenCalledTimes(1);
    expect(new Set(broadcast.mock.calls.map((call) => call[0]))).toEqual(new Set(['0xraw-once']));
  });

  it('a status query racing a send on two clients: exactly one wins the key, and a closed key never broadcasts', async () => {
    if (!sqlA || !sqlB) throw new Error('H8a: svc-pay broadcast-store PG was not opened');
    const a = new PostgresBroadcastStore(sqlA, opts);
    const b = new PostgresBroadcastStore(sqlB, opts);
    for (let i = 0; i < 10; i++) {
      const key = `payout:query-race:db:${i}`;
      const sign = vi.fn(async () => '0xraw-race');
      const broadcast = vi.fn(async () => '0xhash-race');
      const [closed, sent] = await Promise.allSettled([
        b.close(key),
        runDurableBroadcast({ store: a, idempotencyKey: key, sign, broadcast }),
      ]);
      if (closed.status !== 'fulfilled') throw closed.reason;
      if (closed.value !== 'held') {
        expect(sent.status).toBe('rejected');
        expect(sent.status === 'rejected' && sent.reason).toBeInstanceOf(BroadcastClosedError);
        expect(broadcast).not.toHaveBeenCalled();
      } else {
        expect(sent).toEqual({ status: 'fulfilled', value: '0xhash-race' });
        expect(broadcast).toHaveBeenCalledTimes(1);
      }
    }
  });
});
