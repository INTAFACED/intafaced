/**
 * Support account freeze (J-support-public-20 #7) against Postgres, through the signed doors.
 *
 * Promise: only svc-support can ask; svc-identity records the freeze as the account's trading restriction and one
 * append-only row naming the request, the agent and the reason, in one transaction; asking again from the same request
 * while it holds answers the first record; a restriction that already holds keeps its reason code; staff see it in the
 * restricted-account list; the relay announces each freeze once; nothing here lifts it.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import postgres from 'postgres';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { retainRawBody, serviceAuthHeadersForBody } from '@intafaced/contracts';
import {
  IDENTITY_SUPPORT_ACCOUNT_FREEZE,
  IDENTITY_SUPPORT_ACCOUNT_FREEZE_RECORDS,
  supportAccountFreezeRecordsSchema,
  supportAccountFreezeResultSchema,
} from '@intafaced/contracts/support-account-freeze';
import { postgresAvailable, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { createTestDb } from '../fixture-truncate.testkit.js';
import { AuthService } from './auth-service.js';
import { RankService } from '../rank/rank-service.js';
import { listRestrictedAccounts } from '../controls/restricted-accounts.js';
import {
  freezeAccountForSupport,
  registerSupportAccountFreezeRoutes,
  relaySupportAccountFreezeEvents,
  supportAccountFreezeRecords,
} from './support-account-freeze.js';

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
  secret: 'an-identity-support-account-freeze-pg-test-secret',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
  refreshTtlSeconds: 2_592_000,
};
const SECRET = 'a-support-account-freeze-internal-secret-32xx';
const OPERATOR = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0e';

if (!(await postgresAvailable(TEST_URL))) {
  describe.skip('support account freeze (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  const db: TestDb = await createTestDb({
    service: 'identity_support_account_freeze',
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
    const handle = `saf${process.pid}${++n}`;
    return (await auth.register({ handle, email: `${handle}@example.com`, password: 'correct horse battery staple', region: 'DE' })).userId;
  };
  const restriction = async (userId: string) =>
    (
      await db.sql<Array<{ restricted: boolean; version: string; reason_code: string | null }>>`
        SELECT restricted, version::text, reason_code FROM trading_restrictions WHERE user_id = ${userId}`
    )[0];
  const audit = (userId: string) =>
    db.sql<Array<{ ticket_id: string; operator_id: string; reason: string; restriction_set: boolean; restriction_version: string }>>`
      SELECT ticket_id, operator_id, reason, restriction_set, restriction_version::text FROM support_account_freezes
       WHERE user_id = ${userId} ORDER BY recorded_at`;
  const ask = (userId: string, ticketId = randomUUID()) => ({ userId, ticketId, operatorId: OPERATOR, reason: 'TEST account taken over' });

  describe('support account freeze', () => {
    it('sets the trading restriction and writes one audit row; the same request again answers the first record', async () => {
      const userId = await person();
      const input = ask(userId);
      const first = await freezeAccountForSupport(db.sql, input);
      expect(supportAccountFreezeResultSchema.parse(first)).toEqual(first);
      expect(first).toMatchObject({ recordedBy: 'svc-identity', userId, tradingRestricted: true, changed: true });
      expect(await restriction(userId)).toEqual({ restricted: true, version: '1', reason_code: null });
      const again = await freezeAccountForSupport(db.sql, input);
      expect(again).toEqual({ ...first, changed: false });
      expect(await audit(userId)).toEqual([
        {
          ticket_id: input.ticketId,
          operator_id: OPERATOR,
          reason: 'TEST account taken over',
          restriction_set: true,
          restriction_version: '1',
        },
      ]);
      expect((await restriction(userId))?.version).toBe('1');
    });

    it('keeps a restriction already in force, with its reason code, and records that this ask did not set it', async () => {
      const userId = await person();
      await db.sql`INSERT INTO trading_restrictions (user_id, restricted, version, reason_code) VALUES (${userId}, true, 4, 'TEST_code')`;
      const kept = await freezeAccountForSupport(db.sql, ask(userId));
      expect(kept.changed).toBe(true);
      expect(await restriction(userId)).toEqual({ restricted: true, version: '4', reason_code: 'TEST_code' });
      expect((await audit(userId)).map((row) => [row.restriction_set, row.restriction_version])).toEqual([[false, '4']]);
    });

    it('after staff lifted it, an ask from the same request is a new restriction and a new row', async () => {
      const userId = await person();
      const input = ask(userId);
      const first = await freezeAccountForSupport(db.sql, input);
      await db.sql`UPDATE trading_restrictions SET restricted = false, version = version + 1 WHERE user_id = ${userId}`;
      const second = await freezeAccountForSupport(db.sql, input);
      expect(second.auditId).not.toBe(first.auditId);
      expect(await restriction(userId)).toEqual({ restricted: true, version: '3', reason_code: null });
      expect((await audit(userId)).map((row) => row.restriction_version)).toEqual(['1', '3']);
    });

    it('staff see the restriction in the restricted-account list, with the agent and the reason', async () => {
      const userId = await person();
      const made = await freezeAccountForSupport(db.sql, ask(userId));
      const page = await listRestrictedAccounts(db.sql, { area: 'trading', limit: 200 });
      expect(page.rows.find((row) => row.accountId === userId)).toEqual({
        accountId: userId,
        area: 'trading',
        since: made.recordedAt,
        reason: 'TEST account taken over',
        actor: OPERATOR,
      });
    });

    it("reads back one request's audit rows for its own customer only, as the freeze answered them", async () => {
      const userId = await person();
      const input = ask(userId);
      const first = await freezeAccountForSupport(db.sql, input);
      const read = await supportAccountFreezeRecords(db.sql, { userId, ticketId: input.ticketId });
      expect(supportAccountFreezeRecordsSchema.parse(read)).toEqual(read);
      expect(read).toEqual({
        recordedBy: 'svc-identity',
        records: [
          {
            id: first.auditId,
            ticketId: input.ticketId,
            operatorId: OPERATOR,
            reason: input.reason,
            restrictionSet: true,
            recordedAt: first.recordedAt,
          },
        ],
      });
      expect((await supportAccountFreezeRecords(db.sql, { userId: await person(), ticketId: input.ticketId })).records).toEqual([]);
      expect((await supportAccountFreezeRecords(db.sql, { userId, ticketId: randomUUID() })).records).toEqual([]);
    });

    it('refuses an unknown customer and writes nothing', async () => {
      const ghost = randomUUID();
      await expect(freezeAccountForSupport(db.sql, ask(ghost))).rejects.toMatchObject({ code: 'identity.account_not_found' });
      expect(await db.sql`SELECT 1 FROM support_account_freezes WHERE user_id = ${ghost}`).toHaveLength(0);
      expect(await db.sql`SELECT 1 FROM trading_restrictions WHERE user_id = ${ghost}`).toHaveLength(0);
    });

    it('the audit row refuses edits and delete; only the relay stamps published_at, once', async () => {
      const userId = await person();
      await freezeAccountForSupport(db.sql, ask(userId));
      await expect(db.sql`UPDATE support_account_freezes SET reason = 'edited' WHERE user_id = ${userId}`).rejects.toThrow(/append-only/);
      await expect(db.sql`DELETE FROM support_account_freezes WHERE user_id = ${userId}`).rejects.toThrow(/append-only/);
      await db.sql`UPDATE support_account_freezes SET published_at = now() WHERE user_id = ${userId}`;
      await expect(db.sql`UPDATE support_account_freezes SET published_at = now() WHERE user_id = ${userId}`).rejects.toThrow(
        /append-only/,
      );
    });

    it('the relay announces each freeze once, with its business key', async () => {
      const userId = await person();
      const made = await freezeAccountForSupport(db.sql, ask(userId));
      const relayBus = new MemoryEventBus('svc-identity');
      const publish = vi.spyOn(relayBus, 'publish');
      await relaySupportAccountFreezeEvents({ sql: db.sql, bus: relayBus, now: () => new Date() }, 500);
      await relaySupportAccountFreezeEvents({ sql: db.sql, bus: relayBus, now: () => new Date() }, 500);
      const mine = publish.mock.calls
        .filter(([, payload]) => JSON.stringify(payload).includes(userId))
        .map(([name, payload, opts]) => ({ name, payload, key: opts?.idempotencyKey }));
      expect(mine).toEqual([
        {
          name: 'supportAccountFrozen',
          payload: { userId, freezeId: made.auditId, since: made.recordedAt },
          key: `identity.support_account_freeze.frozen:${made.auditId}`,
        },
      ]);
    });

    describe('the signed doors', () => {
      async function app(sql = db.sql) {
        const a = Fastify();
        retainRawBody(a);
        registerSupportAccountFreezeRoutes(a, { sql, internalSecret: SECRET });
        await a.ready();
        return a;
      }
      const post = (body: unknown, service: 'svc-support' | 'svc-pay' = 'svc-support', url = IDENTITY_SUPPORT_ACCOUNT_FREEZE.path) => {
        const payload = JSON.stringify(body);
        return {
          method: 'POST' as const,
          url,
          headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody(service, SECRET, payload) },
          payload,
        };
      };

      it("records svc-support's ask and reads it back; refuses an unsigned caller, any other service, bad input and an unknown customer", async () => {
        const userId = await person();
        const a = await app();
        const input = ask(userId);
        const ok = await a.inject(post(input));
        expect(ok.statusCode).toBe(200);
        expect(ok.json()).toMatchObject({ recordedBy: 'svc-identity', userId, tradingRestricted: true });
        const back = await a.inject(
          post({ userId, ticketId: input.ticketId }, 'svc-support', IDENTITY_SUPPORT_ACCOUNT_FREEZE_RECORDS.path),
        );
        expect(back.json()).toMatchObject({ records: [{ id: ok.json().auditId, ticketId: input.ticketId }] });
        expect((await a.inject({ method: 'POST', url: IDENTITY_SUPPORT_ACCOUNT_FREEZE.path, payload: input })).statusCode).toBe(401);
        const other = await a.inject(post(input, 'svc-pay'));
        expect([other.statusCode, other.json().code]).toEqual([403, 'identity.support_freeze_forbidden']);
        const otherRead = await a.inject(
          post({ userId, ticketId: input.ticketId }, 'svc-pay', IDENTITY_SUPPORT_ACCOUNT_FREEZE_RECORDS.path),
        );
        expect(otherRead.statusCode).toBe(403);
        expect((await a.inject(post({ ...input, reason: '' }))).json().code).toBe('identity.support_freeze_input');
        expect((await a.inject(post({ ...input, amount: '5' }))).statusCode).toBe(400);
        const ghost = await a.inject(post(ask(randomUUID())));
        expect([ghost.statusCode, ghost.json().code]).toEqual([404, 'identity.account_not_found']);
        await a.close();
      });

      it('a write that fails is 503, never a freeze', async () => {
        const dead = postgres('postgres://nobody:nobody@127.0.0.1:1/unreachable_test', { connect_timeout: 1, max: 1 });
        const a = await app(dead);
        const down = await a.inject(post(ask(await person())));
        expect([down.statusCode, down.json().code]).toEqual([503, 'identity.support_freeze_unavailable']);
        await a.close();
        await dead.end({ timeout: 0 });
      });
    });
  });
}
