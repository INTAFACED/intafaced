import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { payoutWaitingFromSql } from './work-items.js';

/** The waiting-payout read against a real Postgres: whose settlements, which states, and what is left out. TEST figures only. */
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_work_items_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

describe('payoutWaitingFromSql (real Postgres)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db!: TestDatabase;

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  // pay.payment_events is append-only (TRUNCATE refused), so each test uses fresh people instead of a cleared table.
  let OWNER = '';
  let OTHER = '';
  beforeEach(() => {
    OWNER = randomUUID();
    OTHER = randomUUID();
  });

  async function merchant(userId: string, status = 'active') {
    const [row] = await db.sql<Array<{ id: string }>>`
      INSERT INTO pay.merchants (user_id, status) VALUES (${userId}, ${status}::pay.merchant_status) RETURNING id`;
    return row!.id;
  }
  let n = 0;
  async function settlement(
    merchantId: string,
    status: string,
    net = '97.5',
    settledAt: Date | null = new Date(),
    failureCode: string | null = null,
  ) {
    n += 1;
    const [row] = await db.sql<Array<{ id: string }>>`
      INSERT INTO pay.settlements (merchant_id, "window", asset_id, gross, fees, net, status, settled_at, payout_method, payout_ref, failure_code, failed_at)
      VALUES (${merchantId}, ${`2026-10-${String(n).padStart(2, '0')}`}, 'USDT', ${net}, 0, ${net}, ${status}::pay.settlement_status, ${settledAt},
              ${status === 'paid_out' ? 'ledger' : null}, ${status === 'paid_out' ? `TEST-payout-${n}` : null},
              ${status === 'failed' ? failureCode : null}, ${status === 'failed' ? new Date() : null})
      RETURNING id`;
    return row!.id;
  }
  async function includeSandboxPayment(merchantId: string, settlementId: string) {
    const [payment] = await db.sql<Array<{ id: string }>>`
      INSERT INTO pay.payments (merchant_id, amount, currency, method, rail_adapter, status)
      VALUES (${merchantId}, 10, 'USDT', 'card', 'card-sandbox', 'created') RETURNING id`;
    await db.sql`
      INSERT INTO pay.payment_events (payment_id, event, payload)
      VALUES (${payment!.id}, 'created', ${db.sql.json({ sandbox: true })}),
             (${payment!.id}, 'settlement.included', ${db.sql.json({ settlementId })})`;
  }

  it('lists the owner’s posted settlements and retryable failed payouts, oldest first, as decimal text, and nothing else', async () => {
    const mine = await merchant(OWNER);
    const later = await settlement(mine, 'posted', '10', new Date('2026-10-20T00:00:00Z'));
    const earlier = await settlement(mine, 'posted', '97.5', new Date('2026-10-19T00:00:00Z'));
    await settlement(mine, 'pending');
    await settlement(mine, 'paid_out');
    await settlement(mine, 'failed', '5', null, 'pay.settlement_released');
    const retry = await settlement(mine, 'failed', '7', new Date('2026-10-21T00:00:00Z'), 'rail.refused');
    const theirs = await merchant(OTHER);
    await settlement(theirs, 'posted');

    const rows = await payoutWaitingFromSql(db.sql).waiting(OWNER);
    expect(rows.map((r) => r.settlementId)).toEqual([earlier, later, retry]);
    expect(rows.map((r) => [r.assetId, r.net.replace(/\.?0+$/, ''), r.failureCode])).toEqual([
      ['USDT', '97.5', null],
      ['USDT', '10', null],
      ['USDT', '7', 'rail.refused'],
    ]);
    expect(await payoutWaitingFromSql(db.sql).waiting(randomUUID())).toEqual([]);
  });

  it('leaves out a business that is not active', async () => {
    for (const status of ['pending', 'suspended', 'closed']) {
      const owner = randomUUID();
      await settlement(await merchant(owner, status), 'posted');
      expect(await payoutWaitingFromSql(db.sql).waiting(owner)).toEqual([]);
    }
  });

  it('leaves out a settlement with a sandbox payment in it, which a live payout refuses', async () => {
    const mine = await merchant(OWNER);
    const sandbox = await settlement(mine, 'posted');
    const live = await settlement(mine, 'posted');
    await includeSandboxPayment(mine, sandbox);
    expect((await payoutWaitingFromSql(db.sql).waiting(OWNER)).map((r) => r.settlementId)).toEqual([live]);
  });
});
