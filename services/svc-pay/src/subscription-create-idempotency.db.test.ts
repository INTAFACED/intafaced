import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseAmount as amt } from '@intafaced/ledger-client';
import { PayError } from './payment-service.js';
import { SubscriptionService } from './subscriptions/subscription-service.js';
import { truncatePayForTest } from './payment-events-test-reset.js';

/**
 * subscription.create duplicate protection.
 *
 * Two creates for one mandate must leave one open subscription. The partial
 * unique index is the database backstop. An Idempotency-Key replays the
 * original subscription when the body matches, and refuses when it does not.
 * A cancelled or completed subscription no longer occupies the mandate.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', 'drizzle');
const migrationFiles = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort();
const migrations = migrationFiles.map((f) => readFileSync(join(drizzle, f), 'utf8'));
const migrationsBeforeOpenIndex = migrationFiles.filter((f) => !f.startsWith('0081_')).map((f) => readFileSync(join(drizzle, f), 'utf8'));
const openIndexMigration = readFileSync(join(drizzle, '0081_pay_subscription_create_idempotency.sql'), 'utf8');

const H8A_IMAGE = 'postgres:16-alpine';
const MERCHANT_USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '22222222-2222-4222-8222-222222222222';
const STARTS = new Date('2026-01-15T00:00:00.000Z');

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  try {
    const container = await new PostgreSqlContainer(H8A_IMAGE)
      .withDatabase('intafaced_subscription_idem_test')
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
      `subscription.create idempotency is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

describe('subscription.create idempotency is not skip-green', () => {
  it('does not skip when Postgres is down', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

describe('subscription.create duplicate protection', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let subs: SubscriptionService;
  let merchantId: string;
  let mandateId: string;

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    sql = db.sql;
  }, 120_000);

  beforeEach(async () => {
    if (!db || !sql) throw new Error('subscription.create PG was not opened');
    await truncatePayForTest(
      sql,
      'pay',
      `TRUNCATE pay.subscription_create_idempotency, pay.subscriptions, pay.subscription_mandates, pay.merchants
       RESTART IDENTITY CASCADE`,
    );
    subs = new SubscriptionService(sql, () => new Date('2026-01-15T00:00:00.000Z'));
    const merchant = await sql<Array<{ id: string }>>`
      INSERT INTO pay.merchants (user_id, mode, tier, kyb_status, status, pricing, settlement_prefs)
      VALUES (${MERCHANT_USER}, 'gateway', 0, 'none', 'active', '{}'::jsonb, '{}'::jsonb)
      RETURNING id
    `;
    merchantId = merchant[0]!.id;
    const mandate = await subs.createMandate({
      merchantId,
      customerId: 'cust-idem',
      assetId: 'USDT',
      amount: amt('10'),
      cadence: 'monthly',
      startsAt: STARTS,
    });
    mandateId = mandate.id;
  });

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  async function openCount(): Promise<number> {
    const rows = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pay.subscriptions WHERE status IN ('active', 'paused')
    `;
    return rows[0]!.n;
  }

  async function allCount(): Promise<number> {
    const rows = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM pay.subscriptions`;
    return rows[0]!.n;
  }

  it('keeps one open subscription when two creates race on the same mandate', async () => {
    const [a, b] = await Promise.allSettled([
      subs.createSubscription({ mandateId, idempotencyKey: 'race-a' }),
      subs.createSubscription({ mandateId, idempotencyKey: 'race-b' }),
    ]);
    const ok = [a, b].filter((r) => r.status === 'fulfilled');
    const refused = [a, b].filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect((refused[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'pay.subscription_mandate_open' });
    expect(await openCount()).toBe(1);
    expect(await allCount()).toBe(1);
    const keys = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pay.subscription_create_idempotency
    `;
    expect(keys[0]!.n).toBe(1);
  });

  it('replays when the key is repeated with no path and then the default path', async () => {
    const first = await subs.createSubscription({ mandateId, idempotencyKey: 'default-path' });
    const retry = await subs.createSubscription({
      mandateId,
      path: 'crypto_invoice',
      idempotencyKey: 'default-path',
    });
    expect(retry.id).toBe(first.id);
    expect(retry.path).toBe('crypto_invoice');
    expect(await allCount()).toBe(1);
  });

  it('replays the same key and the same body as the original subscription', async () => {
    const first = await subs.createSubscription({ mandateId, path: 'crypto_invoice', idempotencyKey: 'again' });
    const second = await subs.createSubscription({ mandateId, path: 'crypto_invoice', idempotencyKey: 'again' });
    expect(second.id).toBe(first.id);
    expect(second.status).toBe('active');
    expect(await allCount()).toBe(1);
  });

  it('refuses the same key when the body differs', async () => {
    const first = await subs.createSubscription({ mandateId, path: 'crypto_invoice', idempotencyKey: 'body' });
    await expect(subs.createSubscription({ mandateId, path: 'card', idempotencyKey: 'body' })).rejects.toMatchObject({
      code: 'pay.idempotency_conflict',
    });
    expect(await allCount()).toBe(1);
    const replay = await subs.createSubscription({ mandateId, path: 'crypto_invoice', idempotencyKey: 'body' });
    expect(replay.id).toBe(first.id);
  });

  it('two concurrent creates with one key return that one subscription', async () => {
    const [a, b] = await Promise.all([
      subs.createSubscription({ mandateId, path: 'crypto_invoice', idempotencyKey: 'same' }),
      subs.createSubscription({ mandateId, path: 'crypto_invoice', idempotencyKey: 'same' }),
    ]);
    expect(a.id).toBe(b.id);
    expect(await allCount()).toBe(1);
  });

  it('refuses a second open subscription after pause, and allows one after cancel or completion', async () => {
    const first = await subs.createSubscription({ mandateId, idempotencyKey: 'first' });
    await subs.pauseSubscription(first.id);
    await expect(subs.createSubscription({ mandateId, idempotencyKey: 'while-paused' })).rejects.toMatchObject({
      code: 'pay.subscription_mandate_open',
    });
    expect(await openCount()).toBe(1);

    await subs.cancelSubscription(first.id);
    const afterCancel = await subs.createSubscription({ mandateId, idempotencyKey: 'while-paused' });
    expect(afterCancel.id).not.toBe(first.id);
    const replay = await subs.createSubscription({ mandateId, idempotencyKey: 'first' });
    expect(replay.id).toBe(first.id);
    expect(replay.status).toBe('cancelled');

    await sql`UPDATE pay.subscriptions SET status = 'completed' WHERE id = ${afterCancel.id}`;
    const afterCompleted = await subs.createSubscription({ mandateId, idempotencyKey: 'after-completed' });
    expect(afterCompleted.id).not.toBe(afterCancel.id);
    expect(await openCount()).toBe(1);
    expect(await allCount()).toBe(3);
  });

  it('the partial unique index rejects a second open row written beside the service', async () => {
    const index = await sql<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes WHERE indexname = 'subscriptions_one_open_per_mandate_uq'
    `;
    expect(index[0]?.indexdef).toMatch(/UNIQUE/i);
    expect(index[0]?.indexdef).toMatch(/active/);
    expect(index[0]?.indexdef).toMatch(/paused/);

    await subs.createSubscription({ mandateId });
    const inserted = sql`
      INSERT INTO pay.subscriptions (mandate_id, merchant_id, customer_id, next_run_at, status, path)
      VALUES (
        ${mandateId}, ${merchantId}, 'cust-idem', ${STARTS}, 'active', 'crypto_invoice'
      )
    `;
    await expect(inserted).rejects.toMatchObject({
      code: '23505',
      constraint_name: 'subscriptions_one_open_per_mandate_uq',
    });
    expect(await openCount()).toBe(1);
  });

  it('refuses a blank Idempotency-Key and writes nothing', async () => {
    await expect(subs.createSubscription({ mandateId, idempotencyKey: '   ' })).rejects.toBeInstanceOf(PayError);
    await expect(subs.createSubscription({ mandateId, idempotencyKey: '   ' })).rejects.toMatchObject({
      code: 'pay.idempotency_required',
    });
    expect(await allCount()).toBe(0);
  });

  it('scopes the key to the merchant', async () => {
    const other = await sql<Array<{ id: string }>>`
      INSERT INTO pay.merchants (user_id, mode, tier, kyb_status, status, pricing, settlement_prefs)
      VALUES (${OTHER_USER}, 'gateway', 0, 'none', 'active', '{}'::jsonb, '{}'::jsonb)
      RETURNING id
    `;
    const otherMandate = await subs.createMandate({
      merchantId: other[0]!.id,
      customerId: 'cust-other',
      assetId: 'USDT',
      amount: amt('10'),
      cadence: 'monthly',
      startsAt: STARTS,
    });
    const a = await subs.createSubscription({ mandateId, path: 'crypto_invoice', idempotencyKey: 'shared' });
    const b = await subs.createSubscription({
      mandateId: otherMandate.id,
      path: 'crypto_invoice',
      idempotencyKey: 'shared',
    });
    expect(b.id).not.toBe(a.id);
    expect(await allCount()).toBe(2);
  });
});

describe('0081 preflight refuses a mandate that already has two open subscriptions', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let subs: SubscriptionService;
  let merchantId: string;

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations: migrationsBeforeOpenIndex });
    sql = db.sql;
  }, 120_000);

  beforeEach(async () => {
    if (!db || !sql) throw new Error('0081 preflight PG was not opened');
    await truncatePayForTest(sql, 'pay', `TRUNCATE pay.subscriptions, pay.subscription_mandates, pay.merchants RESTART IDENTITY CASCADE`);
    subs = new SubscriptionService(sql, () => new Date('2026-01-15T00:00:00.000Z'));
    const merchant = await sql<Array<{ id: string }>>`
      INSERT INTO pay.merchants (user_id, mode, tier, kyb_status, status, pricing, settlement_prefs)
      VALUES (${MERCHANT_USER}, 'gateway', 0, 'none', 'active', '{}'::jsonb, '{}'::jsonb)
      RETURNING id
    `;
    merchantId = merchant[0]!.id;
  });

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  async function mandateFor(customerId: string): Promise<string> {
    const mandate = await subs.createMandate({
      merchantId,
      customerId,
      assetId: 'USDT',
      amount: amt('10'),
      cadence: 'monthly',
      startsAt: STARTS,
    });
    return mandate.id;
  }

  it('names those mandates, leaves both open rows, and applies only after the merchant cancels one', async () => {
    const firstMandate = await mandateFor('cust-open-a');
    const secondMandate = await mandateFor('cust-open-b');
    await subs.createSubscription({ mandateId: firstMandate });
    await subs.createSubscription({ mandateId: secondMandate });
    await sql`
      INSERT INTO pay.subscriptions (mandate_id, merchant_id, customer_id, next_run_at, status, path)
      VALUES
        (${firstMandate}, ${merchantId}, 'cust-open-a', ${STARTS}, 'paused', 'card'),
        (${secondMandate}, ${merchantId}, 'cust-open-b', ${STARTS}, 'active', 'card')
    `;

    await expect(sql.unsafe(openIndexMigration)).rejects.toThrow(/must cancel one open subscription/);
    let message = '';
    try {
      await sql.unsafe(openIndexMigration);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain(firstMandate);
    expect(message).toContain(secondMandate);
    expect(message).toMatch(/does not cancel or rewrite/);

    const open = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pay.subscriptions WHERE status IN ('active', 'paused')
    `;
    expect(open[0]!.n).toBe(4);
    const index = await sql<Array<{ indexname: string }>>`
      SELECT indexname FROM pg_indexes WHERE indexname = 'subscriptions_one_open_per_mandate_uq'
    `;
    expect(index).toHaveLength(0);
    const journal = await sql<Array<{ name: string | null }>>`
      SELECT to_regclass('pay.subscription_create_idempotency')::text AS name
    `;
    expect(journal[0]!.name).toBeNull();

    await sql`
      UPDATE pay.subscriptions
         SET status = 'cancelled'
       WHERE path = 'card'
    `;
    await sql.unsafe(openIndexMigration);
    const after = await sql<Array<{ indexname: string }>>`
      SELECT indexname FROM pg_indexes WHERE indexname = 'subscriptions_one_open_per_mandate_uq'
    `;
    expect(after).toHaveLength(1);
    const stillOpen = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pay.subscriptions WHERE status IN ('active', 'paused')
    `;
    expect(stillOpen[0]!.n).toBe(2);
  });
});
