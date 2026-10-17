import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { SESSION_SCOPES, issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { FounderControls } from '../controls/founder-controls.js';
import { AuthService } from './auth-service.js';
import { RankService } from '../rank/rank-service.js';
import { createTradeIdentityAuthRouter } from './trade-identity-auth-router.js';
import { gateFrozenSubAccount } from './sub-account-place-gate.js';
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

  describe('sub-account freeze is enforced', () => {
    it('currentAuthority denies a frozen sub-account and allows it again at frozen 0', async () => {
      const handle = unique();
      const parent = await auth.register({
        handle,
        email: `${handle}@example.com`,
        password: 'correct horse battery staple',
        region: 'DE',
      });
      const created = await auth.createSubAccount(parent.userId, 'strategy');
      const session = await auth.login({ identifier: handle, password: 'correct horse battery staple' });
      const key = await auth.createApiKey({
        userId: parent.userId,
        name: 'parent',
        scopes: ['identity:write'],
        grantorScopes: SESSION_SCOPES,
      });
      const controls = new FounderControls(db.sql, null);
      const subject = {
        userId: parent.userId,
        credential: { kind: 'session' as const, sessionId: session.sessionId },
        subAccountId: created.id,
      };
      expect((await controls.currentAuthority(subject)).status).toBe('eligible');
      await setSubAccountFrozen(store, {
        parentUserId: parent.userId,
        parentApiKeyId: key.id,
        subAccountId: created.id,
        frozen: 1,
      });
      expect(await controls.currentAuthority(subject)).toMatchObject({
        status: 'denied',
        code: 'auth.sub_account_denied',
      });
      await setSubAccountFrozen(store, {
        parentUserId: parent.userId,
        parentApiKeyId: key.id,
        subAccountId: created.id,
        frozen: 0,
      });
      expect((await controls.currentAuthority(subject)).status).toBe('eligible');
    });

    it('the place gate answers 200 with the ownership body, then 423 when frozen', async () => {
      const handle = unique();
      const parent = await auth.register({
        handle,
        email: `${handle}@example.com`,
        password: 'correct horse battery staple',
        region: 'DE',
      });
      const created = await auth.createSubAccount(parent.userId, 'strategy');
      const ownership = await auth.getSubAccountOwnership(created.id);
      expect(ownership).toEqual({ id: created.id, parentUserId: parent.userId, revoked: false });
      const open = await gateFrozenSubAccount(db.sql, ownership!);
      expect(open).toEqual({ status: 200, body: ownership });
      const key = await auth.createApiKey({
        userId: parent.userId,
        name: 'parent',
        scopes: ['identity:write'],
        grantorScopes: SESSION_SCOPES,
      });
      await setSubAccountFrozen(store, {
        parentUserId: parent.userId,
        parentApiKeyId: key.id,
        subAccountId: created.id,
        frozen: 1,
      });
      const frozenGate = await gateFrozenSubAccount(db.sql, ownership!);
      expect(frozenGate.status).toBe(423);
      expect(frozenGate.body).toEqual({ error: 'sub-account is frozen', code: 'identity.sub_account_frozen' });
    });

    it('a principal with kid and sub_account cannot change frozen', async () => {
      const handle = unique();
      const parent = await auth.register({
        handle,
        email: `${handle}@example.com`,
        password: 'correct horse battery staple',
        region: 'DE',
      });
      const target = await auth.createSubAccount(parent.userId, 'target');
      const sibling = await auth.createSubAccount(parent.userId, 'sibling');
      const session = await auth.login({ identifier: handle, password: 'correct horse battery staple' });
      const key = await auth.createApiKey({
        userId: parent.userId,
        name: 'sibling-key',
        scopes: ['identity:write'],
        grantorScopes: SESSION_SCOPES,
      });
      await setSubAccountFrozen(store, {
        parentUserId: parent.userId,
        parentApiKeyId: key.id,
        subAccountId: target.id,
        frozen: 1,
      });
      const { token } = await issueAccessToken(
        {
          userId: parent.userId,
          sessionId: session.sessionId,
          scopes: ['identity:write'],
          tier: 'none',
          mfa: false,
          apiKeyId: key.id,
          subAccountId: sibling.id,
        },
        tokenConfig,
      );
      const principal = await verifyAccessToken(token, tokenConfig);
      expect(principal.kid).toBe(key.id);
      expect(principal.sub_account).toBe(sibling.id);
      const caller = createTradeIdentityAuthRouter(db.sql, { tokens: tokenConfig }).createCaller({
        principal,
        service: null,
        region: 'DE',
        requestId: 'req-sub-freeze',
      });
      await expect(caller.subAccountFrozen.set({ subAccountId: target.id, frozen: 0 })).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: expect.stringContaining('auth.parent_key_required'),
      });
      const row = await db.sql<Array<{ frozen: number }>>`SELECT frozen FROM sub_accounts WHERE id = ${target.id}`;
      expect(row[0]?.frozen).toBe(1);
      const { token: parentToken } = await issueAccessToken(
        {
          userId: parent.userId,
          sessionId: session.sessionId,
          scopes: ['identity:write'],
          tier: 'none',
          mfa: false,
          apiKeyId: key.id,
        },
        tokenConfig,
      );
      const parentPrincipal = await verifyAccessToken(parentToken, tokenConfig);
      expect(parentPrincipal.sub_account).toBeUndefined();
      const parentCaller = createTradeIdentityAuthRouter(db.sql, { tokens: tokenConfig }).createCaller({
        principal: parentPrincipal,
        service: null,
        region: 'DE',
        requestId: 'req-parent-freeze',
      });
      await expect(parentCaller.subAccountFrozen.set({ subAccountId: target.id, frozen: 0 })).resolves.toEqual({
        id: target.id,
        frozen: 0,
        changed: true,
      });
    });
  });
}
