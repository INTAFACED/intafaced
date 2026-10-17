/**
 * The merchant-watch window is a typed interval. An untyped number multiplied
 * by `interval` is ambiguous and the projection returns no rows.
 *
 * H8a PG-hard: this file never `describe.skip` / `postgresAvailable`. CI uses
 * TEST_DATABASE_URL (per-run database via `createTestDatabase` so schema-qualified
 * `pay.*` SQL stays on `pay`). Local without that env starts Testcontainers
 * `postgres:16-alpine`. Docker/PG down is a failed suite, not a green skip.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { truncatePayForTest } from '../payment-events-test-reset.js';
import { listProjectedPayMetrics } from './merchant-watch-metrics-project.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

const H8A_IMAGE = 'postgres:16-alpine';
const MERCHANT_USER = '11111111-1111-4111-8111-111111111111';

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
      `H8a: svc-pay merchant-watch projection is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

describe('svc-pay merchant-watch projection (source)', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

describe('listProjectedPayMetrics window interval', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];

  beforeAll(async () => {
    const admin = await openH8aAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    sql = db.sql;
  }, 120_000);

  beforeEach(async () => {
    if (!db || !sql) throw new Error('H8a: svc-pay merchant-watch projection PG was not opened');
    await truncatePayForTest(sql, 'pay', 'TRUNCATE pay.payment_events, pay.payments, pay.merchants RESTART IDENTITY CASCADE');
  });

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  async function merchantId(): Promise<string> {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO pay.merchants (user_id) VALUES (${MERCHANT_USER}) RETURNING id
    `;
    if (!row) throw new Error('merchant insert returned no row');
    return row.id;
  }

  async function insertPayment(
    merchant: string,
    rail: string,
    status: 'captured' | 'settled' | 'failed' | 'created',
    ref: string,
  ): Promise<void> {
    await sql`
      INSERT INTO pay.payments (merchant_id, amount, currency, method, rail_adapter, rail_ref, status)
      VALUES (${merchant}, ${'10.00'}, 'USD', 'card', ${rail}, ${ref}, ${status}::pay.payment_status)
    `;
  }

  it('returns decimal approval rates for terminal attempts inside the window', async () => {
    const merchant = await merchantId();
    await insertPayment(merchant, 'card-sandbox', 'captured', 'cap-1');
    await insertPayment(merchant, 'card-sandbox', 'failed', 'fail-1');
    await insertPayment(merchant, 'crypto-native', 'failed', 'fail-2');
    await insertPayment(merchant, 'crypto-native', 'failed', 'fail-3');
    await insertPayment(merchant, 'bank-payout', 'created', 'open-1');

    const points = await listProjectedPayMetrics(sql);

    expect(points).toEqual([
      expect.objectContaining({
        railId: 'card-sandbox',
        approvalRate: '0.5000',
        attempts: 2,
      }),
      expect.objectContaining({
        railId: 'crypto-native',
        approvalRate: '0.0000',
        attempts: 2,
      }),
    ]);
    for (const point of points) {
      expect(typeof point.approvalRate).toBe('string');
      expect(point.approvalRate).toMatch(/^\d+\.\d{4}$/);
    }
    expect(points.some((point) => point.railId === 'bank-payout')).toBe(false);
  });

  it('returns no point and invents no rate when nothing is terminal', async () => {
    const merchant = await merchantId();
    await insertPayment(merchant, 'card-sandbox', 'created', 'open-only');

    const points = await listProjectedPayMetrics(sql);
    expect(points).toEqual([]);
  });

  it('drops attempts older than the typed window', async () => {
    const merchant = await merchantId();
    await insertPayment(merchant, 'card-sandbox', 'captured', 'old-1');
    await sql`
      UPDATE pay.payments
         SET updated_at = now() - interval '2 hours'
       WHERE rail_ref = 'old-1'
    `;

    const points = await listProjectedPayMetrics(sql, 60_000);
    expect(points).toEqual([]);
  });
});
