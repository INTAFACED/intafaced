import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import postgres, { type Sql } from 'postgres';
import { describe, expect, it, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import { createTestDb, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { MemoryEventBus, type EventBus, type EventName, type Payload, type PublishOptions } from '@intafaced/events';
import { LedgerError, parseAmount as amt, recipes } from '@intafaced/ledger-client';
import { LedgerService } from './service.js';

/**
 * THE FREEZE IS DURABLE, or it is not a freeze.
 *
 * `reconcile()` halts the ledger when it detects drift — the single most
 * important safety action in the system. While that decision lived in one
 * process's `boolean`, three things were true and none of them acceptable: a
 * restart resumed posting, a second replica never heard about it, and the
 * operator's reason was written nowhere.
 *
 * So the tests below do not check that `freeze()` sets a field. They check that
 * a freeze on one LedgerService stops a post on a DIFFERENT LedgerService, over
 * a DIFFERENT connection, against the same database — which is the only version
 * of the claim that means anything in production.
 *
 * H8a PG-hard: this file never `describe.skip` / `postgresAvailable`. CI uses
 * TEST_DATABASE_URL (per-run schema via `createTestDb`). Local without that env
 * starts Testcontainers `postgres:16-alpine`. Docker/PG down is a failed suite,
 * not a green skip.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', 'drizzle');

const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

const H8A_IMAGE = 'postgres:16-alpine';

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
      `H8a: svc-ledger freeze is PG-hard (no skip-green). ` +
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

describe('svc-ledger freeze PG-hard (source)', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

describe('svc-ledger freeze', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDb | undefined;

  /**
   * A SEPARATE connection pool over the same schema.
   *
   * This is the whole point of the file. Sharing `db.sql` between two
   * LedgerService objects would prove only that two objects can see one client;
   * a second pool is the closest a single test process gets to a second replica,
   * and it is what makes "B sees A's freeze" a statement about the database
   * rather than about JavaScript.
   */
  let replicas: Sql[] = [];
  function requireDb(): TestDb {
    if (!db) throw new Error('H8a: test db not opened');
    return db;
  }
  function connect(): Sql {
    const opened = requireDb();
    const sql = postgres(opened.url, {
      max: 1,
      connection: { search_path: `${opened.schema},public`, application_name: `${opened.schema}_replica` },
      onnotice: () => undefined,
    });
    replicas.push(sql);
    return sql;
  }

  const USER = '77777777-7777-4777-8777-777777777777';
  const OPERATOR = '11111111-1111-4111-8111-111111111111';

  let busA: MemoryEventBus;
  let busB: MemoryEventBus;
  let a: LedgerService;
  let b: LedgerService;
  let sqlA: Sql;
  let sqlB: Sql;
  let seq = 0;

  /** A funded, legal post. Distinct key per call so idempotency never masks a refusal. */
  const deposit = () => recipes.deposit({ userId: USER, assetId: 'USDT', amount: amt('100'), rail: 'test', railRef: `freeze-${++seq}` });

  beforeAll(async () => {
    const admin = await openH8aAdmin();
    adminStop = admin.stop;
    db = await createTestDb({
      service: 'ledgerfreeze',
      url: admin.url,
      migrations: migrations.map((body) => (schema: string) => rewriteSchemaSql(body, 'ledger', schema)),
    });
  }, 120_000);

  beforeEach(async () => {
    const opened = requireDb();
    await opened.sql`TRUNCATE ledger_freeze_outbox, ledger_tx_outbox, ledger_entries, ledger_tx, balance_snapshots, accounts RESTART IDENTITY CASCADE`;
    await opened.sql`UPDATE chain_tip SET hash = NULL, seq = 0 WHERE id = true`;
    await opened.sql`UPDATE posting_freeze SET frozen = false, reason = NULL, actor = NULL WHERE id = true`;

    busA = new MemoryEventBus('a');
    busB = new MemoryEventBus('b');
    sqlA = connect();
    sqlB = connect();
    a = new LedgerService(sqlA, busA);
    b = new LedgerService(sqlB, busB);
  });

  // Each test opens its own pools; left open they would exhaust the server's
  // connection slots long before the suite finished.
  afterEach(async () => {
    const open = replicas;
    replicas = [];
    await Promise.all(open.map((sql) => sql.end({ timeout: 5 })));
  });

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  describe('a freeze is a fact about the ledger, not about a process', () => {
    it('stops a post on a second instance that never heard the call', async () => {
      // B has posted happily up to this point and holds no knowledge of A.
      await expect(b.post(deposit())).resolves.toMatchObject({ module: 'ledger' });

      await a.freeze('suspected drift in USDT', OPERATOR);

      await expect(b.post(deposit())).rejects.toMatchObject({ code: 'ledger.frozen' });
      await expect(b.status()).resolves.toEqual({
        postingEnabled: false,
        frozenReason: 'suspected drift in USDT',
        frozenBy: OPERATOR,
      });
    });

    it('survives a restart — a process that never saw the freeze still refuses', async () => {
      await a.freeze('reconciliation mismatch', 'reconciliation');

      // Everything A and B knew is gone; this is the process that comes back up.
      const restarted = new LedgerService(connect(), new MemoryEventBus('restarted'));

      await expect(restarted.status()).resolves.toMatchObject({ postingEnabled: false, frozenBy: 'reconciliation' });
      await expect(restarted.post(deposit())).rejects.toMatchObject({ code: 'ledger.frozen' });
    });

    it('lifts on one instance and releases the other', async () => {
      await a.freeze('drift', OPERATOR);
      await expect(b.post(deposit())).rejects.toThrow(/frozen/);

      await b.unfreeze(OPERATOR);

      await expect(a.post(deposit())).resolves.toMatchObject({ module: 'ledger' });
      await expect(a.status()).resolves.toEqual({ postingEnabled: true, frozenReason: null, frozenBy: OPERATOR });
    });

    it('carries the reason to the caller, so a service can log why it was refused', async () => {
      await a.freeze('USDT totals do not net to zero', OPERATOR);

      await expect(b.post(deposit())).rejects.toThrow(/USDT totals do not net to zero/);
      await expect(b.post(deposit())).rejects.toBeInstanceOf(LedgerError);
    });

    it('still honours a retry of a transaction that already committed', async () => {
      // The value moved before the freeze. Refusing the retry would tell the
      // caller nothing happened, and have it try to make it happen again.
      const request = deposit();
      const original = await a.post(request);

      await a.freeze('halted after the fact', OPERATOR);

      await expect(b.post(request)).resolves.toMatchObject({ id: original.id, hash: original.hash });
    });
  });

  describe('reconciliation freezes durably', () => {
    it('a self-freeze reaches a second instance and is attributed to reconciliation', async () => {
      await a.post(deposit());

      // Corrupt the denormalised cache without touching the entries — the exact
      // drift `reconcileBalances` exists to catch.
      await requireDb().sql`
        UPDATE accounts SET balance = balance + 50
         WHERE owner_type = 'user' AND owner_id = ${USER} AND asset_id = 'USDT' AND kind = 'available'
      `;

      const [account] = await requireDb().sql<Array<{ id: string }>>`
        SELECT id
          FROM accounts
         WHERE owner_type = 'user' AND owner_id = ${USER} AND asset_id = 'USDT' AND kind = 'available'
      `;

      const report = await a.reconcile();
      expect(report.ok).toBe(false);

      await expect(b.status()).resolves.toMatchObject({ postingEnabled: false, frozenBy: 'reconciliation' });
      await expect(b.post(deposit())).rejects.toMatchObject({ code: 'ledger.frozen' });

      if (report.balances.ok) throw new Error('fixture drift missing');
      const drift = report.balances.drift[0];
      expect(drift?.accountId).toBe(account?.id);
      const [page] = busA.emitted('ledgerReconciliationFailed');
      expect(page?.payload).toMatchObject({
        accountId: drift?.accountId,
        assetId: drift?.assetId,
        snapshotBalance: drift?.cached,
        replayBalance: drift?.replayed,
        drift: drift?.difference,
      });
    });

    it('a chain break with no balance drift freezes and does not page a nil zero drift', async () => {
      await a.post(deposit());

      // Break the hash chain only. Balances still match their entries.
      await requireDb().sql`UPDATE ledger_tx SET hash = hash || 'tamper'`;

      const report = await a.reconcile();
      expect(report.ok).toBe(false);
      expect(report.balances.ok).toBe(true);
      expect(report.chain.ok).toBe(false);

      await expect(b.status()).resolves.toMatchObject({ postingEnabled: false, frozenBy: 'reconciliation' });

      const pages = busA.emitted('ledgerReconciliationFailed');
      expect(pages[0]?.payload.accountId).not.toBe('00000000-0000-4000-8000-000000000000');
      expect(pages[0]?.payload.drift).not.toBe('0');
      expect(pages[0]?.payload.assetId).not.toBe('UNKNOWN');
      expect(pages).toHaveLength(0);
    });
  });

  describe('LEDGER_POSTING_ENABLED at boot', () => {
    it('=false freezes durably, so the decision reaches replicas nobody reconfigured', async () => {
      const configured = new LedgerService(connect(), new MemoryEventBus('boot'), { postingEnabled: false });
      await configured.applyStartupPolicy();

      await expect(b.status()).resolves.toMatchObject({ postingEnabled: false, frozenBy: 'env:LEDGER_POSTING_ENABLED' });
      await expect(b.post(deposit())).rejects.toMatchObject({ code: 'ledger.frozen' });
    });

    it('=true NEVER thaws — the database wins, and that asymmetry is the point', async () => {
      // The flag defaults to true. If a restart honoured it, every deploy, OOM
      // kill and autoscaler event would silently resume posting on a book
      // reconciliation halted — the original bug, back through the front door.
      await a.freeze('reconciliation mismatch', 'reconciliation');

      const restarted = new LedgerService(connect(), new MemoryEventBus('boot'), { postingEnabled: true });
      const state = await restarted.applyStartupPolicy();

      expect(state).toMatchObject({ frozen: true, reason: 'reconciliation mismatch', actor: 'reconciliation' });
      await expect(restarted.post(deposit())).rejects.toMatchObject({ code: 'ledger.frozen' });
    });

    it('=false on an already-frozen book leaves the original reason standing', async () => {
      await a.freeze('operator: suspected drift', OPERATOR);

      const configured = new LedgerService(connect(), new MemoryEventBus('boot'), { postingEnabled: false });
      await configured.applyStartupPolicy();

      // Overwriting would erase the only record of why the platform is down.
      await expect(configured.status()).resolves.toMatchObject({ frozenReason: 'operator: suspected drift', frozenBy: OPERATOR });
    });
  });

  describe('freeze attribution is sticky (STOP §4.2b #3)', () => {
    it('refuses a second freeze with different reason/actor at the writeFreeze layer', async () => {
      const { writeFreeze: write } = await import('./ledger/freeze.js');
      await write(connect(), { frozen: true, reason: 'operator halt', actor: OPERATOR });
      await expect(write(connect(), { frozen: true, reason: 'reconciliation mismatch', actor: 'reconciliation' })).rejects.toMatchObject({
        code: 'ledger.freeze_attributed',
      });

      const state = await a.freezeState();
      expect(state).toMatchObject({ frozen: true, reason: 'operator halt', actor: OPERATOR });
    });

    it('service.freeze throws freeze_attributed when recon tries to clobber — first reason stands', async () => {
      // Soft-success was the old lie: callers (operator HTTP) saw 200 and believed
      // their reason landed. Now freeze throws; recon catches so the alarm still pages.
      await a.freeze('operator: suspected drift', OPERATOR);
      await expect(a.freeze('reconciliation mismatch', 'reconciliation')).rejects.toMatchObject({
        code: 'ledger.freeze_attributed',
      });
      const after = await a.freezeState();
      expect(after).toMatchObject({ frozen: true, reason: 'operator: suspected drift', actor: OPERATOR });
    });

    it('same attribution re-freeze is a true no-op — stable changed_at, no second event', async () => {
      // Promise: writeFreeze comment "Same attribution is a no-op". The old
      // UPDATE matched same attribution and still SET changed_at = now(), so
      // hourly recon walked "when was it frozen?" and re-fired the bus.
      await a.freeze('drift', OPERATOR);
      const first = await a.freezeState();
      const again = await a.freeze('drift', OPERATOR);
      expect(again).toMatchObject({ frozen: true, reason: 'drift', actor: OPERATOR });
      expect(again.changedAtPrecise).toBe(first.changedAtPrecise);
      expect(again.changedAt.getTime()).toBe(first.changedAt.getTime());
      expect(busA.emitted('ledgerFreezeUpdated')).toHaveLength(1);
    });

    it('thaw of an already-open book is a true no-op — no event, stable row', async () => {
      // Book starts open (fixtures). Double thaw must not rewrite actor/time.
      const before = await a.freezeState();
      expect(before.frozen).toBe(false);
      const again = await a.unfreeze(OPERATOR);
      expect(again.frozen).toBe(false);
      expect(again.changedAtPrecise).toBe(before.changedAtPrecise);
      expect(busA.emitted('ledgerFreezeUpdated')).toHaveLength(0);
    });
  });

  describe('the rest of the OS is told', () => {
    it('emits ledgerFreezeUpdated in both directions, with who and why', async () => {
      await a.freeze('drift', OPERATOR);
      await a.unfreeze(OPERATOR);

      const emitted = busA.emitted('ledgerFreezeUpdated');
      expect(emitted).toHaveLength(2);
      expect(emitted[0]!.payload).toMatchObject({ frozen: true, reason: 'drift', actor: OPERATOR });
      expect(emitted[1]!.payload).toMatchObject({ frozen: false, reason: null, actor: OPERATOR });
      expect(emitted[0]!.subject).toBe('intafaced.ledger.freeze.updated');
    });

    it('timestamps the change from the database, not the publishing process', async () => {
      // Two replicas disagreeing about the wall clock must not be able to
      // disagree about the order the platform was halted and resumed in.
      const opened = requireDb();
      const before = await opened.sql<Array<{ now: Date }>>`SELECT now() AS now`;
      await a.freeze('drift', OPERATOR);
      const [row] = await opened.sql<Array<{ changed_at: Date }>>`SELECT changed_at FROM posting_freeze WHERE id = true`;

      const [emitted] = busA.emitted('ledgerFreezeUpdated');
      expect(emitted!.payload.changedAt).toBe(row!.changed_at.toISOString());
      expect(row!.changed_at.getTime()).toBeGreaterThanOrEqual(before[0]!.now.getTime());
    });

    it('a failed publish stays in the outbox; the same-attribution retry emits it once without moving the switch', async () => {
      const inner = new MemoryEventBus('retry');
      let failPublish = true;
      const ledger = new LedgerService(
        connect(),
        gatedBus(inner, () => failPublish),
      );

      await expect(ledger.freeze('drift', OPERATOR)).rejects.toThrow(/bus down/);

      const frozen = await ledger.freezeState();
      expect(frozen).toMatchObject({ frozen: true, reason: 'drift', actor: OPERATOR });
      expect(inner.emitted('ledgerFreezeUpdated')).toHaveLength(0);

      const pending = await requireDb().sql<Array<{ idempotency_key: string; published_at: Date | null }>>`
        SELECT idempotency_key, published_at FROM ledger_freeze_outbox
      `;
      expect(pending).toHaveLength(1);
      expect(pending[0]?.published_at).toBeNull();
      expect(pending[0]?.idempotency_key).toMatch(/^ledger\.freeze:seq:[1-9][0-9]*$/);

      failPublish = false;
      const again = await ledger.freeze('drift', OPERATOR);
      expect(again.changedAtPrecise).toBe(frozen.changedAtPrecise);
      expect(again.changedAt.getTime()).toBe(frozen.changedAt.getTime());
      expect(again).toMatchObject({ frozen: true, reason: 'drift', actor: OPERATOR });

      const emitted = inner.emitted('ledgerFreezeUpdated');
      expect(emitted).toHaveLength(1);
      expect(emitted[0]?.payload).toMatchObject({
        frozen: true,
        reason: 'drift',
        actor: OPERATOR,
        changedAt: frozen.changedAt.toISOString(),
      });
      expect(emitted[0]?.idempotencyKey).toBe(pending[0]?.idempotency_key);

      const third = await ledger.freeze('drift', OPERATOR);
      expect(third.changedAtPrecise).toBe(frozen.changedAtPrecise);
      expect(inner.emitted('ledgerFreezeUpdated')).toHaveLength(1);

      const sent = await requireDb().sql<Array<{ published_at: Date | null }>>`
        SELECT published_at FROM ledger_freeze_outbox
      `;
      expect(sent[0]?.published_at).toBeInstanceOf(Date);
    });

    it('a failed unfreeze publish retries once and does not thaw again', async () => {
      await a.freeze('drift', OPERATOR);
      const inner = new MemoryEventBus('thaw');
      let failPublish = true;
      const ledger = new LedgerService(
        connect(),
        gatedBus(inner, () => failPublish),
      );

      await expect(ledger.unfreeze(OPERATOR)).rejects.toThrow(/bus down/);
      const thawed = await ledger.freezeState();
      expect(thawed).toMatchObject({ frozen: false, reason: null, actor: OPERATOR });
      expect(inner.emitted('ledgerFreezeUpdated')).toHaveLength(0);

      failPublish = false;
      const again = await ledger.unfreeze(OPERATOR);
      expect(again.frozen).toBe(false);
      expect(again.changedAtPrecise).toBe(thawed.changedAtPrecise);
      expect(again.changedAt.getTime()).toBe(thawed.changedAt.getTime());

      const emitted = inner.emitted('ledgerFreezeUpdated');
      expect(emitted).toHaveLength(1);
      expect(emitted[0]?.payload).toMatchObject({ frozen: false, reason: null, actor: OPERATOR });
      expect(emitted[0]?.idempotencyKey).toBe(
        (await requireDb().sql`SELECT idempotency_key FROM ledger_freeze_outbox ORDER BY switch_seq DESC LIMIT 1`)[0]?.idempotency_key,
      );

      await ledger.unfreeze(OPERATOR);
      expect(inner.emitted('ledgerFreezeUpdated')).toHaveLength(1);
      const still = await ledger.freezeState();
      expect(still.changedAtPrecise).toBe(thawed.changedAtPrecise);
    });

    it('recoverUnpublishedOutbox emits a pending freeze event without a second switch', async () => {
      const inner = new MemoryEventBus('recover');
      let failPublish = true;
      const ledger = new LedgerService(
        connect(),
        gatedBus(inner, () => failPublish),
      );

      await expect(ledger.freeze('drift', OPERATOR)).rejects.toThrow(/bus down/);
      const frozen = await ledger.freezeState();
      expect(inner.emitted('ledgerFreezeUpdated')).toHaveLength(0);

      failPublish = false;
      expect(await ledger.recoverUnpublishedOutbox()).toBe(1);
      expect(inner.emitted('ledgerFreezeUpdated')).toHaveLength(1);
      expect(inner.emitted('ledgerFreezeUpdated')[0]?.idempotencyKey).toBe(
        (await requireDb().sql`SELECT idempotency_key FROM ledger_freeze_outbox ORDER BY switch_seq DESC LIMIT 1`)[0]?.idempotency_key,
      );

      const after = await ledger.freezeState();
      expect(after.changedAtPrecise).toBe(frozen.changedAtPrecise);
      expect(after).toMatchObject({ frozen: true, reason: 'drift', actor: OPERATOR });

      expect(await ledger.recoverUnpublishedOutbox()).toBe(0);
      await ledger.freeze('drift', OPERATOR);
      expect(inner.emitted('ledgerFreezeUpdated')).toHaveLength(1);
    });

    it('keys the envelope on the durable switch sequence, so a same-millisecond thaw survives', async () => {
      // STOP §4.2b #7. `freeze-event-key.test.ts` proves the arithmetic without a
      // database; durable native events instead use the stored sequence allocated
      // under the singleton lock. No Date round-trip creates their identity.
      await a.freeze('drift', OPERATOR);
      const [row] = await requireDb().sql<Array<{ key: string; seq: string }>>`
        SELECT idempotency_key AS key, switch_seq::text AS seq FROM ledger_freeze_outbox ORDER BY switch_seq DESC LIMIT 1
      `;

      const [emitted] = busA.emitted('ledgerFreezeUpdated');
      expect(emitted!.idempotencyKey).toBe(row!.key);
      expect(emitted!.idempotencyKey).toBe(`ledger.freeze:seq:${row!.seq}`);

      // And the freeze/thaw pair never share an identity, however fast it is.
      await a.unfreeze(OPERATOR);
      const keys = busA.emitted('ledgerFreezeUpdated').map((e) => e.idempotencyKey);
      expect(new Set(keys).size).toBe(keys.length);
    });
  });

  describe('the database refuses an unattributed freeze', () => {
    it('rejects frozen = true with no reason and no actor', async () => {
      // Belt and braces, as everywhere else in this schema: a bug in the
      // service must not be able to halt the platform anonymously.
      await expect(requireDb().sql`UPDATE posting_freeze SET frozen = true WHERE id = true`).rejects.toThrow(
        /posting_freeze_attributed_ck/,
      );
    });
  });
});
