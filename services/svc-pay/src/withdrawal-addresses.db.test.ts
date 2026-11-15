import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { PAY_WITHDRAWAL_ADDRESSES_PATH, serviceAuthHeadersForBody } from '@intafaced/contracts';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerWithdrawalAddressRoute, withdrawalAddresses } from './withdrawal-addresses.js';

/** J-portfolio-03 #2: where one person's own crypto withdrawals went, against a real Postgres and through the signed route. */
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
    .withDatabase('intafaced_withdrawal_addresses_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

const SECRET = 'svc-pay-withdrawal-address-secret-at-least-32';
const ALICE = 'user-alice-wa';
const BOB = 'user-bob-wa';

describe('withdrawal addresses (J-portfolio-03 #2)', () => {
  let db: TestDatabase;
  let adminStop: () => Promise<void> = async () => undefined;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    const add = async (key: string, user: string, destination: object) => {
      const [row] = await db.sql<Array<{ id: string }>>`
        INSERT INTO pay.withdrawals (user_id, asset_id, amount, rail, destination, client_ref, status, attempts)
        VALUES (${user}, 'USDT', 5, 'crypto-native', ${db.sql.json(destination as never)}, ${`wa-${key}`}, 'pending', 0)
        RETURNING id::text AS id`;
      ids[key] = row!.id;
    };
    await add('aliceCrypto', ALICE, { kind: 'crypto', ref: '0xAbC0000000000000000000000000000000000001' });
    await add('aliceIban', ALICE, { kind: 'iban', ref: 'DE00TEST' });
    await add('bobCrypto', BOB, { kind: 'crypto', ref: '0xb0b0000000000000000000000000000000000002' });
  }, 120_000);
  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  it("answers only that person's own crypto destinations, as stored", async () => {
    const answer = await withdrawalAddresses(db.sql as never, {
      userId: ALICE,
      withdrawalIds: [ids.aliceCrypto!, ids.aliceIban!, ids.bobCrypto!, '99999999-9999-4999-8999-999999999999'],
    });
    expect(answer).toEqual({ addresses: [{ withdrawalId: ids.aliceCrypto, address: '0xAbC0000000000000000000000000000000000001' }] });
  });

  it('through the route: svc-bank only, signed over its body; a failed read is a 503', async () => {
    const app = async (fail = false) => {
      const a = Fastify();
      registerWithdrawalAddressRoute(a, {
        internalSecret: SECRET,
        addresses: async (input) => {
          if (fail) throw new Error('database down');
          return withdrawalAddresses(db.sql as never, input);
        },
      });
      await a.ready();
      return a;
    };
    const body = JSON.stringify({ userId: ALICE, withdrawalIds: [ids.aliceCrypto] });
    const ask = (a: Awaited<ReturnType<typeof app>>, as: 'svc-bank' | 'svc-trade', payload = body) =>
      a.inject({
        method: 'POST',
        url: PAY_WITHDRAWAL_ADDRESSES_PATH,
        headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody(as, SECRET, payload) },
        payload,
      });
    const a = await app();
    const ok = await ask(a, 'svc-bank');
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ addresses: [{ withdrawalId: ids.aliceCrypto, address: '0xAbC0000000000000000000000000000000000001' }] });
    expect((await ask(a, 'svc-trade')).statusCode).toBe(403);
    expect((await ask(a, 'svc-bank', JSON.stringify({ userId: ALICE, withdrawalIds: ['nope'] }))).statusCode).toBe(400);
    const unsigned = await a.inject({
      method: 'POST',
      url: PAY_WITHDRAWAL_ADDRESSES_PATH,
      headers: { 'content-type': 'application/json' },
      payload: body,
    });
    expect(unsigned.statusCode).toBe(401);
    await a.close();
    const down = await app(true);
    expect((await ask(down, 'svc-bank')).statusCode).toBe(503);
    await down.close();
  });
});
