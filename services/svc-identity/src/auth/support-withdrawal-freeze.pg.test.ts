/**
 * Support withdrawal freeze (J-support-public-20 #7) against Postgres, through the signed route.
 *
 * Promise: only svc-support can ask; svc-identity records the freeze as the account's security lock set by support and
 * one append-only row naming the request, the agent and the reason, in one transaction; asking again from the same
 * request answers the first record; a lock that already holds stays as it is; nothing lifts it.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { afterAll, describe, expect, it } from 'vitest';
import {
  retainRawBody,
  serviceAuthHeadersForBody,
  SUPPORT_WITHDRAWAL_FREEZE_PATH,
  supportWithdrawalFreezeResultSchema,
} from '@intafaced/contracts';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { AuthService } from './auth-service.js';
import { RankService } from '../rank/rank-service.js';
import { SecurityLock } from './security-lock.js';
import { freezeWithdrawalsForSupport, registerSupportWithdrawalFreezeRoute } from './support-withdrawal-freeze.js';

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
  secret: 'an-identity-support-freeze-pg-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
  refreshTtlSeconds: 2_592_000,
};
const SECRET = 'a-support-withdrawal-freeze-internal-secret-32x';
const OPERATOR = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f';

if (!(await postgresAvailable(TEST_URL))) {
  describe.skip('support withdrawal freeze (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db: TestDb = await createTestDb({
    service: 'identity_support_freeze',
    url: TEST_URL,
    migrations: migrations.map((body) => (schema: string) => rewriteSchemaSql(body, 'identity', schema)),
  });
  const bus = new MemoryEventBus('svc-identity');
  const rank = new RankService(db.sql, bus);
  const auth = new AuthService(db.sql, bus, rank, tokenConfig, undefined, undefined, undefined, undefined, 5);
  await rank.seedTiers();
  const lock = new SecurityLock(db.sql, 0);
  lock.useLogger({ warn: () => undefined });
  afterAll(async () => {
    await db.drop();
  });
  let n = 0;
  const person = async () => {
    const handle = `swf${process.pid}${++n}`;
    return (await auth.register({ handle, email: `${handle}@example.com`, password: 'correct horse battery staple', region: 'DE' })).userId;
  };
  const audit = (userId: string) =>
    db.sql<Array<{ ticket_id: string; operator_id: string; reason: string; lock_set: boolean; lock_id: string }>>`
      SELECT ticket_id, operator_id, reason, lock_set, lock_id FROM support_withdrawal_freezes WHERE user_id = ${userId} ORDER BY recorded_at`;
  const locks = (userId: string) =>
    db.sql<Array<{ id: string; set_by: string; set_by_user_id: string; state: string }>>`
      SELECT id, set_by, set_by_user_id, state FROM account_security_locks WHERE user_id = ${userId} ORDER BY locked_at`;
  const ask = (userId: string, ticketId = randomUUID()) => ({ userId, ticketId, operatorId: OPERATOR, reason: 'TEST withdrawal missing' });

  describe('support withdrawal freeze', () => {
    it('sets the security lock as support and writes one audit row; the same request again answers the first record', async () => {
      const userId = await person();
      const input = ask(userId);
      const first = await freezeWithdrawalsForSupport(lock, input);
      expect(supportWithdrawalFreezeResultSchema.parse(first)).toEqual(first);
      expect(first).toMatchObject({ recordedBy: 'svc-identity', changed: true, lock: { userId, locked: true, setBy: 'support' } });
      const again = await freezeWithdrawalsForSupport(lock, input);
      expect(again).toMatchObject({ changed: false, auditId: first.auditId, recordedAt: first.recordedAt, lock: { locked: true } });
      const [row] = await locks(userId);
      expect(await locks(userId)).toHaveLength(1);
      expect(row).toMatchObject({ set_by: 'support', set_by_user_id: OPERATOR, state: 'locked' });
      expect(await audit(userId)).toEqual([
        { ticket_id: input.ticketId, operator_id: OPERATOR, reason: 'TEST withdrawal missing', lock_set: true, lock_id: row!.id },
      ]);
      expect((await lock.read(userId))?.locked).toBe(true);
    });

    it("keeps the customer's own lock as it is, recording that this ask did not set it, and withdraws a waiting unlock", async () => {
      const userId = await person();
      await lock.lock(userId, { kind: 'self', userId });
      const own = await freezeWithdrawalsForSupport(lock, ask(userId));
      expect(own.lock).toMatchObject({ locked: true, setBy: 'self' });
      expect((await audit(userId))[0]!.lock_set).toBe(false);

      const waiting = await person();
      await lock.lock(waiting, { kind: 'self', userId: waiting });
      // A long wait so the request stands while the freeze arrives.
      await new SecurityLock(db.sql, 3600).requestUnlock(waiting);
      expect((await lock.read(waiting))?.unlocksAt).not.toBeNull();
      const kept = await freezeWithdrawalsForSupport(lock, ask(waiting));
      expect(kept.lock).toMatchObject({ locked: true, unlocksAt: null });
      expect((await audit(waiting))[0]!.lock_set).toBe(true);
    });

    it('refuses an unknown customer and writes nothing', async () => {
      const ghost = randomUUID();
      await expect(freezeWithdrawalsForSupport(lock, ask(ghost))).rejects.toMatchObject({ code: 'identity.security_lock_not_found' });
      expect(await db.sql`SELECT 1 FROM support_withdrawal_freezes WHERE user_id = ${ghost}`).toHaveLength(0);
    });

    it('the audit row refuses update and delete; only removing its lock row takes it with it', async () => {
      const userId = await person();
      await freezeWithdrawalsForSupport(lock, ask(userId));
      await expect(db.sql`UPDATE support_withdrawal_freezes SET reason = 'edited' WHERE user_id = ${userId}`).rejects.toThrow(
        /append-only/,
      );
      await expect(db.sql`DELETE FROM support_withdrawal_freezes WHERE user_id = ${userId}`).rejects.toThrow(/append-only/);
      await db.sql`DELETE FROM account_security_locks WHERE user_id = ${userId}`;
      expect(await audit(userId)).toHaveLength(0);
    });

    describe('the signed route', () => {
      let failWrite = false;
      async function app() {
        const a = Fastify();
        retainRawBody(a);
        registerSupportWithdrawalFreezeRoute(a, {
          internalSecret: SECRET,
          installRawBody: false,
          freeze: async (input) => {
            if (failWrite) throw new Error('database down');
            return freezeWithdrawalsForSupport(lock, input);
          },
        });
        await a.ready();
        return a;
      }
      const post = (body: unknown, service: 'svc-support' | 'svc-pay' = 'svc-support') => {
        const payload = JSON.stringify(body);
        return {
          method: 'POST' as const,
          url: SUPPORT_WITHDRAWAL_FREEZE_PATH,
          headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody(service, SECRET, payload) },
          payload,
        };
      };

      it("records svc-support's ask, and refuses an unsigned caller, any other service, bad input and an unknown customer", async () => {
        const userId = await person();
        const a = await app();
        const ok = await a.inject(post(ask(userId)));
        expect(ok.statusCode).toBe(200);
        expect(ok.json()).toMatchObject({ recordedBy: 'svc-identity', lock: { userId, locked: true, setBy: 'support' } });
        expect((await a.inject({ method: 'POST', url: SUPPORT_WITHDRAWAL_FREEZE_PATH, payload: ask(userId) })).statusCode).toBe(401);
        const other = await a.inject(post(ask(userId), 'svc-pay'));
        expect([other.statusCode, other.json().code]).toEqual([403, 'identity.support_freeze_forbidden']);
        expect((await a.inject(post({ ...ask(userId), reason: '' }))).json().code).toBe('identity.support_freeze_input');
        expect((await a.inject(post({ ...ask(userId), amount: '5' }))).statusCode).toBe(400);
        expect((await a.inject(post(ask(randomUUID())))).json().code).toBe('identity.account_not_found');
        failWrite = true;
        const down = await a.inject(post(ask(userId)));
        failWrite = false;
        expect([down.statusCode, down.json().code]).toEqual([503, 'identity.support_freeze_unavailable']);
        await a.close();
      });
    });
  });
}
