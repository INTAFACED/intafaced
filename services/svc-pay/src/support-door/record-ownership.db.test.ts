import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { recordOwnershipReader } from './record-ownership.js';

/** The support ownership read (J-support-public-20 #1) against a real Postgres. TEST figures only. */
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_record_ownership_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const MISSING = '99999999-9999-4999-8999-999999999999';

describe('support record ownership read (real Postgres)', () => {
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

  beforeEach(async () => {
    await db.sql`TRUNCATE pay.withdrawals, pay.deposits, pay.custody_deposits RESTART IDENTITY CASCADE`;
  }, 30_000);

  let n = 0;
  async function withdrawal(userId = USER): Promise<string> {
    n += 1;
    const [row] = await db.sql<{ id: string }[]>`
      INSERT INTO pay.withdrawals (user_id, asset_id, amount, rail, destination, client_ref, status)
      VALUES (${userId}, 'USDT', 5, 'card-sandbox', ${db.sql.json({ kind: 'bank', ref: 'TEST' })}, ${`ref-${n}`}, 'pending'::pay.withdrawal_status)
      RETURNING id`;
    return row!.id;
  }
  async function deposit(userId = USER): Promise<string> {
    n += 1;
    const [row] = await db.sql<{ id: string }[]>`
      INSERT INTO pay.deposits (user_id, asset_id, amount, rail, rail_ref, credited_by, status)
      VALUES (${userId}, 'USDT', 5, 'card-sandbox', ${`dep-${n}`}, 'operator', 'pending'::pay.deposit_status)
      RETURNING id`;
    return row!.id;
  }
  async function custodyDeposit(userId = USER): Promise<string> {
    n += 1;
    const [row] = await db.sql<{ id: string }[]>`
      INSERT INTO pay.custody_deposits (user_id, asset_id, network_id, address, tx_hash, output_index, amount)
      VALUES (${userId}, 'USDT', 'TEST-net', 'TEST-address', ${`0x${n.toString(16).padStart(64, '0')}`}, 0, '5')
      RETURNING id`;
    return row!.id;
  }

  it("answers true only for the customer's own withdrawal, rail deposit or custody deposit", async () => {
    const owns = recordOwnershipReader(db.sql);
    const w = await withdrawal();
    const d = await deposit();
    const c = await custodyDeposit();
    expect(await owns({ kind: 'withdrawal', recordId: w, userId: USER })).toBe(true);
    expect(await owns({ kind: 'deposit', recordId: d, userId: USER })).toBe(true);
    expect(await owns({ kind: 'deposit', recordId: c, userId: USER })).toBe(true);
  });

  it("answers false alike for another customer's record, a missing id and the other kind", async () => {
    const owns = recordOwnershipReader(db.sql);
    const theirs = await withdrawal(OTHER);
    const mine = await withdrawal();
    const myDeposit = await deposit();
    expect(await owns({ kind: 'withdrawal', recordId: theirs, userId: USER })).toBe(false);
    expect(await owns({ kind: 'withdrawal', recordId: MISSING, userId: USER })).toBe(false);
    expect(await owns({ kind: 'deposit', recordId: mine, userId: USER })).toBe(false);
    expect(await owns({ kind: 'withdrawal', recordId: myDeposit, userId: USER })).toBe(false);
    expect(await owns({ kind: 'deposit', recordId: await custodyDeposit(OTHER), userId: USER })).toBe(false);
  });

  it('writes nothing', async () => {
    const owns = recordOwnershipReader(db.sql);
    const w = await withdrawal();
    const before = await db.sql`SELECT * FROM pay.withdrawals ORDER BY id`;
    await owns({ kind: 'withdrawal', recordId: w, userId: USER });
    await owns({ kind: 'withdrawal', recordId: MISSING, userId: USER });
    expect(await db.sql`SELECT * FROM pay.withdrawals ORDER BY id`).toEqual(before);
  });
});
