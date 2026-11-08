import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { describe, expect, it, beforeAll, beforeEach, afterAll } from 'vitest';
import { createTestDb, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { CUSTODY_LAYER_OFF_CODE, CustodyLayerOffError, classifyPostOutcome, parseAmount as amt, recipes } from '@intafaced/ledger-client';
import { LedgerService } from './service.js';
import { httpError } from './s2s-http.js';
import { truncateBook } from './db/journal-guards.testkit.js';

/**
 * THE CUSTODY SWITCH, against a real book (OWNER 226: no customer money held at launch).
 *
 * With the custodial layer off, a post that moves a customer balance is refused before anything is written, a post
 * between INTAFACED's own pots still books, and a key already booked while the layer was on still replays, so a
 * caller retrying a committed post is never told it was refused. With the layer on, the custodial layer posts as
 * before. PG-hard: no skip.
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
      .withDatabase('intafaced_custody_test')
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
      `svc-ledger custody switch is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

describe('svc-ledger custody switch', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDb | undefined;
  let seq = 0;

  function requireDb(): TestDb {
    if (!db) throw new Error('custody switch: test db not opened');
    return db;
  }

  const deposit = (ref = `custody-${++seq}`) =>
    recipes.deposit({ userId: USER, assetId: 'USDT', amount: amt('100'), rail: 'test', railRef: ref });
  const txCount = async () => Number((await requireDb().sql`SELECT count(*)::int AS n FROM ledger_tx`)[0]!.n);

  beforeAll(async () => {
    const admin = await openH8aAdmin();
    adminStop = admin.stop;
    db = await createTestDb({
      service: 'ledgercustody',
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

  it('is off when not set, and refuses a customer-balance post with a typed 412 that books nothing', async () => {
    const ledger = new LedgerService(requireDb().sql, new MemoryEventBus('custody-off'));
    expect(ledger.custodyLayer).toBe('off');

    const err = await ledger.post(deposit()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CustodyLayerOffError);
    expect((err as CustodyLayerOffError).code).toBe(CUSTODY_LAYER_OFF_CODE);
    expect(await txCount()).toBe(0);
    expect(Number((await requireDb().sql`SELECT count(*)::int AS n FROM accounts WHERE owner_type = 'user'`)[0]!.n)).toBe(0);

    // The door answers 412 with the code on the wire, and a caller classifies it as a definite refusal.
    expect(httpError(err)).toMatchObject({ status: 412, body: { code: CUSTODY_LAYER_OFF_CODE } });
    expect(classifyPostOutcome(err)).toBe('refused');
  });

  it('refuses a merchant-money leg too: a merchant is a customer', async () => {
    const ledger = new LedgerService(requireDb().sql, new MemoryEventBus('custody-off'), { custodyLayer: 'off' });
    const merchantLeg = {
      idempotencyKey: `custody-merchant-${++seq}`,
      module: 'pay',
      reason: 'test.merchant',
      entries: [
        {
          account: { ownerType: 'treasury' as const, ownerId: 'rail:test', assetId: 'USDT', kind: 'available' as const },
          direction: 'debit' as const,
          amount: amt('5'),
        },
        {
          account: { ownerType: 'module' as const, ownerId: 'pay:clearing:m1', assetId: 'USDT', kind: 'available' as const },
          direction: 'credit' as const,
          amount: amt('5'),
        },
      ],
    };
    await expect(ledger.post(merchantLeg)).rejects.toBeInstanceOf(CustodyLayerOffError);
    expect(await txCount()).toBe(0);
  });

  it('still books a post between the platform pots while off', async () => {
    const ledger = new LedgerService(requireDb().sql, new MemoryEventBus('custody-off'), { custodyLayer: 'off' });
    const tx = await ledger.post(recipes.marketMakerSeedFund({ assetId: 'USDT', amount: amt('50'), seedId: `seed-${++seq}` }));
    expect(tx.id).toBeTruthy();
    expect(await txCount()).toBe(1);
  });

  it('posts the custodial layer when on', async () => {
    const ledger = new LedgerService(requireDb().sql, new MemoryEventBus('custody-on'), { custodyLayer: 'on' });
    await expect(ledger.post(deposit())).resolves.toMatchObject({ module: 'ledger' });
    expect(await txCount()).toBe(1);
  });

  it('replays a key booked while on after the layer is switched off, and refuses only a new key', async () => {
    const on = new LedgerService(requireDb().sql, new MemoryEventBus('custody-on'), { custodyLayer: 'on' });
    const booked = await on.post(deposit('replay-1'));

    const off = new LedgerService(requireDb().sql, new MemoryEventBus('custody-off'), { custodyLayer: 'off' });
    const replay = await off.post(deposit('replay-1'));
    expect(replay.id).toBe(booked.id);
    expect(await txCount()).toBe(1);

    await expect(off.post(deposit('replay-2'))).rejects.toBeInstanceOf(CustodyLayerOffError);
    expect(await txCount()).toBe(1);
  });
});
