import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { SESSION_SCOPES } from '@intafaced/auth';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { AuthService } from './auth-service.js';
import { RankService } from '../rank/rank-service.js';
import { createSqlTradeIdentityStore, requestAccountDeletion, setSubAccountFrozen } from './trade-identity-auth.js';

function testDatabaseUrl(): string {
  const raw = process.env.TEST_DATABASE_URL?.trim();
  if (!raw) return 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
  const url = new URL(raw);
  const name = url.pathname.replace(/^\//, '');
  if (!name.endsWith('_test')) url.pathname = '/intafaced_test';
  return url.toString();
}

const TEST_URL = testDatabaseUrl();
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '../../drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(drizzleDir, file), 'utf8'));

const tokenConfig = {
  secret: 'an-identity-s22-pg-test-signing-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
  refreshTtlSeconds: 2_592_000,
};

const available = await postgresAvailable(TEST_URL);

if (!available) {
  describe.skip('trade identity auth (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db: TestDb = await createTestDb({
    service: 'identity',
    url: TEST_URL,
    migrations: migrations.map((body) => (schema: string) => rewriteSchemaSql(body, 'identity', schema)),
  });
  const bus = new MemoryEventBus('svc-identity');
  const rank = new RankService(db.sql, bus);
  const auth = new AuthService(db.sql, bus, rank, tokenConfig, undefined, undefined, undefined, undefined, 5);
  await rank.seedTiers();
  const store = createSqlTradeIdentityStore(db.sql);
  let n = 0;
  const unique = () => `s22${process.pid}${++n}`;

  afterAll(async () => {
    await db.drop();
  });

  describe('TRD-0165 frozen flag on Postgres', () => {
    it('stores frozen 1 then 0 on the same sub-account id and refuses a missing parent key', async () => {
      const handle = unique();
      const parent = await auth.register({
        handle,
        email: `${handle}@example.com`,
        password: 'correct horse battery staple',
        region: 'DE',
      });
      const created = await auth.createSubAccount(parent.userId, 'strategy');
      const key = await auth.createApiKey({
        userId: parent.userId,
        name: 'parent',
        scopes: ['identity:write'],
        grantorScopes: SESSION_SCOPES,
      });
      const frozen = await setSubAccountFrozen(store, {
        parentUserId: parent.userId,
        parentApiKeyId: key.id,
        subAccountId: created.id,
        frozen: 1,
      });
      expect(frozen).toEqual({ id: created.id, frozen: 1, changed: true });
      const again = await setSubAccountFrozen(store, {
        parentUserId: parent.userId,
        parentApiKeyId: key.id,
        subAccountId: created.id,
        frozen: 1,
      });
      expect(again).toEqual({ id: created.id, frozen: 1, changed: false });
      const row = await db.sql<Array<{ id: string; frozen: number }>>`
        SELECT id, frozen FROM sub_accounts WHERE id = ${created.id}
      `;
      expect(row[0]).toEqual({ id: created.id, frozen: 1 });
      const active = await setSubAccountFrozen(store, {
        parentUserId: parent.userId,
        parentApiKeyId: key.id,
        subAccountId: created.id,
        frozen: 0,
      });
      expect(active.id).toBe(created.id);
      expect(active.frozen).toBe(0);
      await expect(
        setSubAccountFrozen(store, {
          parentUserId: parent.userId,
          parentApiKeyId: null,
          subAccountId: created.id,
          frozen: 1,
        }),
      ).rejects.toMatchObject({ code: 'auth.parent_key_required' });
      const still = await db.sql<Array<{ frozen: number }>>`SELECT frozen FROM sub_accounts WHERE id = ${created.id}`;
      expect(still[0]?.frozen).toBe(0);
    });

    it('a flat close revokes the key and a second close does not debit', async () => {
      const handle = unique();
      const user = await auth.register({
        handle,
        email: `${handle}@example.com`,
        password: 'correct horse battery staple',
        region: 'DE',
      });
      const key = await auth.createApiKey({
        userId: user.userId,
        name: 'maker',
        scopes: ['trade:write'],
        grantorScopes: SESSION_SCOPES,
      });
      const blocked = await requestAccountDeletion(store, {
        userId: user.userId,
        book: {
          openOrders: 1,
          openPositions: 0,
          payEscrow: 0,
          pendingDeposits: 0,
          pendingWithdrawals: 0,
          payRequests: 0,
          chargebacks: 0,
          restingQuotes: 0,
          available: '0',
          orderHold: 'TEST:4.25',
        },
      });
      expect(blocked.completed).toBe(false);
      expect(blocked.orderHold).toBe('TEST:4.25');
      const status = await db.sql<Array<{ status: string }>>`SELECT status FROM users WHERE id = ${user.userId}`;
      expect(status[0]?.status).toBe('active');
      const closed = await requestAccountDeletion(store, {
        userId: user.userId,
        book: {
          openOrders: 0,
          openPositions: 0,
          payEscrow: 0,
          pendingDeposits: 0,
          pendingWithdrawals: 0,
          payRequests: 0,
          chargebacks: 0,
          restingQuotes: 0,
          available: '0',
          orderHold: '0',
        },
      });
      expect(closed.debited).toBe(false);
      expect(closed.makerKeyCanPlace).toBe(false);
      const keyRow = await db.sql<Array<{ revoked: boolean }>>`SELECT revoked FROM api_keys WHERE id = ${key.id}`;
      expect(keyRow[0]?.revoked).toBe(true);
      const second = await requestAccountDeletion(store, {
        userId: user.userId,
        book: {
          openOrders: 0,
          openPositions: 0,
          payEscrow: 0,
          pendingDeposits: 0,
          pendingWithdrawals: 0,
          payRequests: 0,
          chargebacks: 0,
          restingQuotes: 0,
          available: '0',
          orderHold: '0',
        },
      });
      expect(second.repeated).toBe(true);
      expect(second.debited).toBe(false);
      const after = await db.sql<Array<{ status: string }>>`SELECT status FROM users WHERE id = ${user.userId}`;
      expect(after[0]?.status).toBe('closed');
    });
  });
}
