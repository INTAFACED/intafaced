/**
 * The trading restriction read (J-support-public-20 #7) against Postgres, through its signed door.
 *
 * Promise: only svc-trade may read it; it answers restricted exactly when identity's operation decision would refuse
 * `trade.account_restricted` (a support agent's account freeze, the founder controls' restriction, a staff close with a
 * grace date), unrestricted once staff lift it, and an unknown or malformed person is 404, never unrestricted.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { afterAll, describe, expect, it } from 'vitest';
import { retainRawBody, serviceAuthHeadersForBody } from '@intafaced/contracts';
import { IDENTITY_TRADING_RESTRICTION } from '@intafaced/contracts/identity-trading-restriction-procedures';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { AuthService } from './auth-service.js';
import { RankService } from '../rank/rank-service.js';
import { freezeAccountForSupport } from './support-account-freeze.js';
import { registerTradingRestrictionRoute } from './trading-restriction-door.js';

function testDatabaseUrl(): string {
  const raw = process.env.TEST_DATABASE_URL?.trim();
  if (!raw) return 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
  const url = new URL(raw);
  if (!url.pathname.replace(/^\//, '').endsWith('_test')) url.pathname = '/intafaced_test';
  return url.toString();
}

const TEST_URL = testDatabaseUrl();
const drizzleDir = join(dirname(fileURLToPath(import.meta.url)), '../../drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(drizzleDir, file), 'utf8'));
const tokenConfig = {
  secret: 'an-identity-trading-restriction-pg-test-secret',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
  refreshTtlSeconds: 2_592_000,
};
const SECRET = 'a-trading-restriction-read-internal-secret-32x';
const OPERATOR = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0e';

if (!(await postgresAvailable(TEST_URL))) {
  describe.skip('trading restriction read (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db: TestDb = await createTestDb({
    service: 'identity_trading_restriction',
    url: TEST_URL,
    migrations: migrations.map((body) => (schema: string) => rewriteSchemaSql(body, 'identity', schema)),
  });
  const bus = new MemoryEventBus('svc-identity');
  const rank = new RankService(db.sql, bus);
  const auth = new AuthService(db.sql, bus, rank, tokenConfig, undefined, undefined, undefined, undefined, 5);
  await rank.seedTiers();
  afterAll(async () => {
    await db.drop();
  });
  let n = 0;
  const person = async () => {
    const handle = `trr${process.pid}${++n}`;
    return (await auth.register({ handle, email: `${handle}@example.com`, password: 'correct horse battery staple', region: 'DE' })).userId;
  };
  const app = Fastify();
  retainRawBody(app);
  registerTradingRestrictionRoute(app, { sql: db.sql, internalSecret: SECRET, bodyBind: 'require' });
  afterAll(async () => {
    await app.close();
  });
  const read = (userId: string, service = 'svc-trade') =>
    app.inject({
      method: 'GET',
      url: IDENTITY_TRADING_RESTRICTION.path.replace(':userId', userId),
      headers: serviceAuthHeadersForBody(service, SECRET, ''),
    });

  describe('trading restriction read', () => {
    it('answers unrestricted, then restricted after a support agent freezes the account, then unrestricted once staff lift it', async () => {
      const userId = await person();
      expect((await read(userId)).json()).toEqual({ userId, restricted: false });
      await freezeAccountForSupport(db.sql, { userId, ticketId: randomUUID(), operatorId: OPERATOR, reason: 'TEST account taken over' });
      const frozen = await read(userId);
      expect(frozen.statusCode).toBe(200);
      expect(IDENTITY_TRADING_RESTRICTION.output.parse(frozen.json())).toEqual({ userId, restricted: true });
      await db.sql`UPDATE trading_restrictions SET restricted = false, version = version + 1 WHERE user_id = ${userId}`;
      expect((await read(userId)).json()).toEqual({ userId, restricted: false });
    });

    it('a staff close with a grace date restricts trading, as the operation decision does', async () => {
      const userId = await person();
      await db.sql`UPDATE users SET close_grace_until = now() + interval '30 days', closed_reason = 'customer_request' WHERE id = ${userId}`;
      expect((await read(userId)).json()).toEqual({ userId, restricted: true });
    });

    it('only svc-trade may read it; an unknown or malformed person is 404, never unrestricted', async () => {
      const userId = await person();
      expect((await app.inject({ method: 'GET', url: `/internal/trading-restriction/${userId}` })).statusCode).toBe(401);
      const other = await read(userId, 'svc-pay');
      expect(other.statusCode).toBe(403);
      expect(other.json().code).toBe('identity.forbidden');
      const ghost = await read(randomUUID());
      expect(ghost.statusCode).toBe(404);
      expect(ghost.json().code).toBe('identity.account_not_found');
      expect((await read('not-a-uuid')).statusCode).toBe(404);
    });
  });
}
