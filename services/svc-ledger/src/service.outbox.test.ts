import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { describe, expect, it, beforeAll, beforeEach, afterAll } from 'vitest';
import { createTestDb, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { MemoryEventBus, type EventBus, type EventName, type Payload, type PublishOptions } from '@intafaced/events';
import { parseAmount as amt, recipes } from '@intafaced/ledger-client';
import { LedgerService } from './service.js';
import { truncateBook } from './db/journal-guards.testkit.js';

/**
 * Crash after COMMIT used to lose `ledgerTxPosted`. The outbox row is the
 * durable intent: publish can fail and the book still has a row to recover.
 *
 * H8a PG-hard: this file never `describe.skip` / `postgresAvailable`.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', 'drizzle');

const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

const H8A_IMAGE = 'postgres:16-alpine';
const USER = '88888888-8888-4888-8888-888888888888';

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
      `H8a: svc-ledger outbox is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

function gatedBus(inner: MemoryEventBus, blocked: () => boolean): EventBus {
  return {
    publish<K extends EventName>(name: K, payload: Payload<K>, opts?: PublishOptions) {
      if (blocked()) throw new Error('bus down');
      return inner.publish(name, payload, opts);
    },
    subscribe: (name, handler, opts) => inner.subscribe(name, handler, opts),
    close: () => inner.close(),
  };
}

describe('svc-ledger post outbox PG-hard (source)', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });

  it('boot/tick recover is outside applyStartupPolicy (freeze must not call identity)', () => {
    const service = readFileSync(join(here, 'service.ts'), 'utf8');
    const index = readFileSync(join(here, 'index.ts'), 'utf8');
    const policy = service.slice(service.indexOf('async applyStartupPolicy'), service.indexOf('async recoverUnpublishedOutbox'));
    expect(policy).not.toMatch(/recoverUnpublishedOutbox/);
    expect(index).toMatch(/recoverUnpublishedOutbox/);
    expect(index).toMatch(/OUTBOX_RECOVER_MS/);
    expect(index).toMatch(/clearInterval\(outboxTimer\)/);
  });
});

describe('svc-ledger post outbox', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDb | undefined;
  let seq = 0;

  function requireDb(): TestDb {
    if (!db) throw new Error('H8a: test db not opened');
    return db;
  }

  const deposit = () => recipes.deposit({ userId: USER, assetId: 'USDT', amount: amt('100'), rail: 'test', railRef: `outbox-${++seq}` });

  beforeAll(async () => {
    const admin = await openH8aAdmin();
    adminStop = admin.stop;
    db = await createTestDb({
      service: 'ledgeroutbox',
      url: admin.url,
      migrations: migrations.map((body) => (schema: string) => rewriteSchemaSql(body, 'ledger', schema)),
    });
  }, 120_000);

  beforeEach(async () => {
    const opened = requireDb();
    await truncateBook(opened.sql, 'ledger_tx_outbox, ledger_entries, ledger_tx, balance_snapshots, accounts RESTART IDENTITY CASCADE');
    await opened.sql`UPDATE chain_tip SET hash = NULL, seq = 0 WHERE id = true`;
    await opened.sql`UPDATE posting_freeze SET frozen = false, reason = NULL, actor = NULL WHERE id = true`;
  });

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  it('post that fails publish still has an unpublished outbox row; recover publishes it once', async () => {
    const inner = new MemoryEventBus('svc-ledger');
    let failPublish = true;
    const ledger = new LedgerService(
      requireDb().sql,
      gatedBus(inner, () => failPublish),
    );
    const request = deposit();

    await expect(ledger.post(request)).rejects.toThrow(/bus down/);

    const book = await ledger.getTxByKey(request.idempotencyKey);
    expect(book).not.toBeNull();

    const unpublished = await requireDb().sql<Array<{ tx_id: string; published_at: Date | null; amount: unknown }>>`
      SELECT o.tx_id, o.published_at, e->>'amount' AS amount
        FROM ledger_tx_outbox o
        CROSS JOIN LATERAL jsonb_array_elements(o.payload->'entries') e
       WHERE o.tx_id = ${book!.id}
    `;
    expect(unpublished.length).toBeGreaterThan(0);
    expect(unpublished.every((r) => r.published_at === null)).toBe(true);
    expect(unpublished.every((r) => typeof r.amount === 'string')).toBe(true);
    expect(inner.emitted('ledgerTxPosted')).toHaveLength(0);

    failPublish = false;
    const recovered = await ledger.recoverUnpublishedOutbox();
    expect(recovered).toBe(1);
    expect(inner.emitted('ledgerTxPosted')).toHaveLength(1);
    expect(inner.emitted('ledgerTxPosted')[0]?.payload.txId).toBe(book!.id);
    expect(inner.emitted('ledgerTxPosted')[0]?.idempotencyKey).toBe(`ledger.tx:${book!.id}`);
    expect(typeof inner.emitted('ledgerTxPosted')[0]?.payload.entries[0]?.amount).toBe('string');

    const after = await requireDb().sql<Array<{ published_at: Date | null }>>`
      SELECT published_at FROM ledger_tx_outbox WHERE tx_id = ${book!.id}
    `;
    expect(after[0]?.published_at).toBeInstanceOf(Date);

    expect(await ledger.recoverUnpublishedOutbox()).toBe(0);
    expect(inner.emitted('ledgerTxPosted')).toHaveLength(1);
  });

  it('successful post marks the outbox sent and does not re-publish on recover', async () => {
    const bus = new MemoryEventBus('svc-ledger');
    const ledger = new LedgerService(requireDb().sql, bus);
    const posted = await ledger.post(deposit());

    expect(bus.emitted('ledgerTxPosted')).toHaveLength(1);
    expect(bus.emitted('ledgerTxPosted')[0]?.payload.txId).toBe(posted.id);

    const rows = await requireDb().sql<Array<{ published_at: Date | null }>>`
      SELECT published_at FROM ledger_tx_outbox WHERE tx_id = ${posted.id}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.published_at).toBeInstanceOf(Date);

    expect(await ledger.recoverUnpublishedOutbox()).toBe(0);
    expect(bus.emitted('ledgerTxPosted')).toHaveLength(1);
  });
});
