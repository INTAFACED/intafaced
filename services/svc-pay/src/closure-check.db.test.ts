import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { serviceAuthHeadersForBody } from '@intafaced/contracts';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerClosureCheckRoute, runPayClosureCheck } from './closure-check.js';

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
    .withDatabase('intafaced_closure_check_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

const SECRET = 'svc-pay-closure-check-secret-at-least-32-chars';
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const DESTINATION = { kind: 'bank', ref: 'DE89370400440532013000' };

describe('pay closure check (real Postgres)', () => {
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
    await db.sql`TRUNCATE pay.withdrawals, pay.deposits, pay.screening_cases RESTART IDENTITY CASCADE`;
  }, 30_000);

  let n = 0;
  async function withdrawal(status: string, userId = USER) {
    n += 1;
    await db.sql`
      INSERT INTO pay.withdrawals (user_id, asset_id, amount, rail, destination, client_ref, rail_ref, status)
      VALUES (${userId}, 'USDT', 5, 'card-sandbox', ${db.sql.json(DESTINATION)}, ${`ref-${n}`}, ${status === 'sent' ? `rail-${n}` : null},
              ${status}::pay.withdrawal_status)`;
  }
  async function deposit(status: string, userId = USER) {
    n += 1;
    await db.sql`
      INSERT INTO pay.deposits (user_id, asset_id, amount, rail, rail_ref, credited_by, status)
      VALUES (${userId}, 'USDT', 5, 'card-sandbox', ${`dep-${n}`}, 'operator', ${status}::pay.deposit_status)`;
  }
  async function screeningCase(o: { status?: string; decision?: string | null; party?: string; consumed?: boolean; expiresInMs?: number }) {
    n += 1;
    const key = n.toString(16).padStart(64, '0');
    const released = o.decision === 'released';
    await db.sql`
      INSERT INTO pay.screening_cases (subject_kind, subject_key, status, factors, party_ref, amount, asset_id, decision, decided_by, approver_id,
                                       decision_reason, decided_at, release_expires_at, release_consumed_at)
      VALUES ('withdrawal', ${key}, ${o.status ?? 'review'}, '[]'::jsonb, ${o.party ?? USER}, '5', 'USDT', ${o.decision ?? null},
              ${o.decision ? 'compliance-1' : null}, ${released ? 'compliance-2' : null}, ${o.decision ? 'Checked the file' : null},
              ${o.decision ? new Date() : null}, ${released ? new Date(Date.now() + (o.expiresInMs ?? 3_600_000)) : null},
              ${released && o.consumed ? new Date() : null})`;
  }

  it('is empty for a user with nothing open', async () => {
    const out = await runPayClosureCheck(db.sql, { userId: USER });
    expect(out.blockers).toEqual([]);
    expect(Number.isNaN(Date.parse(out.asOf))).toBe(false);
  });

  it('counts a withdrawal in flight, and drops it once it is sent or failed', async () => {
    await withdrawal('pending');
    await withdrawal('held');
    await withdrawal('sent');
    await withdrawal('failed');
    expect((await runPayClosureCheck(db.sql, { userId: USER })).blockers).toEqual([{ code: 'open_withdrawal_hold', count: 2 }]);
    await db.sql`UPDATE pay.withdrawals SET status = 'sent', rail_ref = 'rail-x-' || id::text WHERE status IN ('pending', 'held')`;
    expect((await runPayClosureCheck(db.sql, { userId: USER })).blockers).toEqual([]);
  });

  it('counts a screening case that needs a person until it is decided', async () => {
    await screeningCase({ status: 'review' });
    await screeningCase({ status: 'unavailable' });
    await screeningCase({ status: 'clear' });
    expect((await runPayClosureCheck(db.sql, { userId: USER })).blockers).toEqual([{ code: 'open_screening_case', count: 2 }]);
    await db.sql`UPDATE pay.screening_cases SET decision = 'upheld', decided_by = 'compliance-1', decision_reason = 'Held', decided_at = now()
                  WHERE status IN ('review', 'unavailable')`;
    expect((await runPayClosureCheck(db.sql, { userId: USER })).blockers).toEqual([]);
  });

  it('counts a release that is granted and not yet spent or expired, and not a spent or expired one', async () => {
    await screeningCase({ decision: 'released' });
    expect((await runPayClosureCheck(db.sql, { userId: USER })).blockers).toEqual([{ code: 'open_screening_case', count: 1 }]);
    await db.sql`TRUNCATE pay.screening_cases`;
    await screeningCase({ decision: 'released', consumed: true });
    await screeningCase({ decision: 'released', expiresInMs: -1000 });
    expect((await runPayClosureCheck(db.sql, { userId: USER })).blockers).toEqual([]);
  });

  it('counts a deposit the rail took that is not booked, and answers per user', async () => {
    await deposit('pending');
    await deposit('pending', OTHER);
    await withdrawal('pending', OTHER);
    await screeningCase({ party: OTHER });
    expect((await runPayClosureCheck(db.sql, { userId: USER })).blockers).toEqual([{ code: 'open_deposit_hold', count: 1 }]);
    await db.sql`UPDATE pay.deposits SET status = 'credited' WHERE user_id = ${USER}`;
    expect((await runPayClosureCheck(db.sql, { userId: USER })).blockers).toEqual([]);
  });

  describe('the signed route', () => {
    async function app() {
      const a = Fastify();
      registerClosureCheckRoute(a, {
        internalSecret: SECRET,
        check: async (input) => {
          if (failRead) throw new Error('database down');
          return runPayClosureCheck(db.sql, input);
        },
      });
      await a.ready();
      return a;
    }
    const post = (body: unknown, service: 'svc-identity' | 'svc-bank' = 'svc-identity') => {
      const payload = JSON.stringify(body);
      return {
        method: 'POST' as const,
        url: '/internal/closure-check',
        payload,
        headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody(service, SECRET, payload) },
      };
    };

    it('answers identity with the blockers', async () => {
      await withdrawal('pending');
      const a = await app();
      const res = await a.inject(post({ userId: USER, subAccountIds: [] }));
      expect(res.statusCode).toBe(200);
      expect(res.json().blockers).toEqual([{ code: 'open_withdrawal_hold', count: 1 }]);
      await a.close();
    });

    it('is 503, never an empty list, when the read fails', async () => {
      failRead = true;
      const a = await app();
      const res = await a.inject(post({ userId: USER, subAccountIds: [] }));
      expect(res.statusCode).toBe(503);
      expect(res.json().blockers).toBeUndefined();
      await a.close();
    });

    it('refuses an unsigned caller, any other service, and a body that is not a user id', async () => {
      const a = await app();
      expect((await a.inject({ method: 'POST', url: '/internal/closure-check', payload: { userId: USER } })).statusCode).toBe(401);
      expect((await a.inject(post({ userId: USER, subAccountIds: [] }, 'svc-bank'))).statusCode).toBe(403);
      expect((await a.inject(post({ userId: 'nope' }))).statusCode).toBe(400);
      expect((await a.inject(post({ userId: USER, extra: 1 }))).statusCode).toBe(400);
      expect((await a.inject(post([USER]))).statusCode).toBe(400);
      await a.close();
    });
  });
});
