import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { serviceAuthHeadersForBody } from '@intafaced/contracts';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { recordOwned, registerSupportRecordOwnershipRoute } from './support-record-ownership.js';

/** The support record-ownership door (J-support-public-20 #1) against a real Postgres, and through the signed route. */
/** The pay closure check (RC-wallet-03) against a real Postgres, and through the signed route. TEST figures only. */
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
    .withDatabase('intafaced_record_ownership_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

const SECRET = 'svc-pay-record-ownership-secret-at-least-32-chars';
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const MISSING = '33333333-3333-4333-8333-333333333333';
const DESTINATION = { kind: 'bank', ref: 'DE89370400440532013000' };

describe('support record ownership (real Postgres)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db!: TestDatabase;
  let failRead = false;

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
    failRead = false;
    await db.sql`TRUNCATE pay.withdrawals, pay.deposits RESTART IDENTITY CASCADE`;
  }, 30_000);

  let n = 0;
  async function withdrawal(userId = USER): Promise<string> {
    n += 1;
    const [row] = await db.sql<Array<{ id: string }>>`
      INSERT INTO pay.withdrawals (user_id, asset_id, amount, rail, destination, client_ref, status)
      VALUES (${userId}, 'USDT', 5, 'card-sandbox', ${db.sql.json(DESTINATION)}, ${`ref-${n}`}, 'pending'::pay.withdrawal_status)
      RETURNING id`;
    return row!.id;
  }
  async function deposit(userId = USER): Promise<string> {
    n += 1;
    const [row] = await db.sql<Array<{ id: string }>>`
      INSERT INTO pay.deposits (user_id, asset_id, amount, rail, rail_ref, credited_by, status)
      VALUES (${userId}, 'USDT', 5, 'card-sandbox', ${`dep-${n}`}, 'operator', 'pending'::pay.deposit_status)
      RETURNING id`;
    return row!.id;
  }

  it("answers owned only for the customer's own record of that kind", async () => {
    const mine = await withdrawal();
    const theirs = await withdrawal(OTHER);
    const myDeposit = await deposit();
    expect(await recordOwned(db.sql, { kind: 'withdrawal', recordId: mine, userId: USER })).toBe(true);
    expect(await recordOwned(db.sql, { kind: 'withdrawal', recordId: theirs, userId: USER })).toBe(false);
    expect(await recordOwned(db.sql, { kind: 'withdrawal', recordId: MISSING, userId: USER })).toBe(false);
    // An id of the other kind is not this kind's record.
    expect(await recordOwned(db.sql, { kind: 'withdrawal', recordId: myDeposit, userId: USER })).toBe(false);
    expect(await recordOwned(db.sql, { kind: 'deposit', recordId: myDeposit, userId: USER })).toBe(true);
  });

  describe('the signed route', () => {
    async function app() {
      const a = Fastify();
      registerSupportRecordOwnershipRoute(a, {
        internalSecret: SECRET,
        owned: async (input) => {
          if (failRead) throw new Error('database down');
          return recordOwned(db.sql, input);
        },
      });
      await a.ready();
      return a;
    }
    const post = (body: unknown, service: 'svc-support' | 'svc-bank' = 'svc-support') => {
      const payload = JSON.stringify(body);
      return {
        method: 'POST' as const,
        url: '/internal/support/record-ownership',
        payload,
        headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody(service, SECRET, payload) },
      };
    };

    it("answers one boolean, the same for another customer's record and a missing one", async () => {
      const mine = await withdrawal();
      const theirs = await withdrawal(OTHER);
      const a = await app();
      expect((await a.inject(post({ kind: 'withdrawal', recordId: mine, userId: USER }))).json()).toEqual({ owned: true });
      const other = await a.inject(post({ kind: 'withdrawal', recordId: theirs, userId: USER }));
      const missing = await a.inject(post({ kind: 'withdrawal', recordId: MISSING, userId: USER }));
      expect([other.statusCode, missing.statusCode]).toEqual([200, 200]);
      expect(other.body).toBe(missing.body);
      expect(other.json()).toEqual({ owned: false });
      await a.close();
    });

    it('is 503, never a false, when the read fails', async () => {
      failRead = true;
      const a = await app();
      const res = await a.inject(post({ kind: 'deposit', recordId: MISSING, userId: USER }));
      expect(res.statusCode).toBe(503);
      expect(res.json().owned).toBeUndefined();
      await a.close();
    });

    it('refuses an unsigned caller, any other service, and a body outside the contract', async () => {
      const a = await app();
      const body = { kind: 'withdrawal', recordId: MISSING, userId: USER };
      expect((await a.inject({ method: 'POST', url: '/internal/support/record-ownership', payload: body })).statusCode).toBe(401);
      expect((await a.inject(post(body, 'svc-bank'))).statusCode).toBe(403);
      expect((await a.inject(post({ ...body, kind: 'order' }))).statusCode).toBe(400);
      expect((await a.inject(post({ ...body, extra: 1 }))).statusCode).toBe(400);
      await a.close();
    });
  });
});
