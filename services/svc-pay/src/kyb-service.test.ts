import { truncatePayForTest } from './payment-events-test-reset.js';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { beforeEach, afterAll, beforeAll, describe, expect, it } from 'vitest';
import { unwiredApprovalConsumer } from './action-approval-consume.js';
import { KybError, KybService } from './kyb-service.js';
import { createKybPspRouter } from './kyb-router.js';
import { PayError } from './payment-service.js';
import type { PspModeService } from './psp-mode.js';

function at<T>(rows: readonly T[], index: number, what: string): T {
  const row = rows[index];
  if (row === undefined) throw new Error(`expected ${what}[${index}], but only ${rows.length} row(s) came back`);
  return row;
}

async function rejection<E>(promise: Promise<unknown>, kind: abstract new (...args: never[]) => E): Promise<E> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof kind) return err;
    throw err;
  }
  throw new Error(`expected ${kind.name}, but the call resolved`);
}

/**
 * DIGITAL KYB durability — the live operator path `decideKybStub` points at.
 * Postgres required: append-only is a TRIGGER.
 *
 * H8a PG-hard: this file never `describe.skip` / `postgresAvailable`. CI uses
 * TEST_DATABASE_URL (per-run database via `createTestDatabase` so schema-qualified
 * `pay.*` SQL stays on `pay`). Local without that env starts Testcontainers
 * `postgres:16-alpine`. Docker/PG down is a failed suite, not a green skip.
 * The admin URL is `TEST_DATABASE_URL`, not `TEST_DATABASE_URL_PAY`: creating a
 * database needs CREATEDB, which the per-service roles deliberately lack.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const OPERATOR = '99999999-9999-4999-8999-999999999999';
const MERCHANT_USER = '11111111-1111-4111-8111-111111111111';
const STRANGER = '22222222-2222-4222-8222-222222222222';
const REJECTED_OWNER = '33333333-3333-4333-8333-333333333333';

const authConfig = {
  secret: 'a-test-signing-secret-that-is-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};

async function caller(userId: string): Promise<Context> {
  const { token } = await issueAccessToken(
    {
      userId,
      sessionId: '77777777-7777-4777-8777-777777777777',
      scopes: ['pay:write'],
      tier: 'full',
      mfa: true,
    },
    authConfig,
  );
  return {
    principal: await verifyAccessToken(token, authConfig),
    service: null,
    region: 'DE',
    requestId: 'kyb-caller-owns',
  };
}

const H8A_IMAGE = 'postgres:16-alpine';

async function openH8aAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) {
    return { url: envUrl, stop: async () => undefined };
  }

  try {
    const container = await new PostgreSqlContainer(H8A_IMAGE)
      .withDatabase('intafaced_h8a_test')
      .withUsername('intafaced')
      .withPassword('intafaced')
      .start();
    return {
      url: container.getConnectionUri(),
      stop: async () => {
        await container.stop();
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `H8a: svc-pay digital KYB is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

describe('svc-pay digital KYB (source)', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

describe('svc-pay digital KYB PG-hard', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let kyb: KybService;

  beforeAll(async () => {
    const admin = await openH8aAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    sql = db.sql;
  }, 120_000);

  beforeEach(async () => {
    await truncatePayForTest(
      sql,
      'pay',
      `TRUNCATE pay.merchant_kyb_events, pay.merchant_pricing_events, pay.merchant_status_events, pay.merchants RESTART IDENTITY CASCADE`,
    );
    kyb = new KybService(sql);
  });

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  async function merchant(mode: 'gateway' | 'psp' | 'payfac' = 'psp', userId?: string): Promise<string> {
    const owner = userId ?? `u-${Math.random().toString(36).slice(2)}`;
    const [row] = await sql<Array<{ id: string }>>`
      INSERT INTO pay.merchants (user_id, mode, status, pricing)
      VALUES (${owner}, ${mode}, 'active', ${sql.json({ feeBps: 250 } as never)})
      RETURNING id
    `;
    if (!row) throw new Error('inserting a merchant returned no row');
    return row.id;
  }

  function owners() {
    return {
      async getMerchant(merchantId: string) {
        const [row] = await sql<Array<{ user_id: string }>>`
          SELECT user_id FROM pay.merchants WHERE id = ${merchantId}
        `;
        if (!row) throw new PayError(`Merchant ${merchantId} not found`, 'pay.merchant_not_found');
        return { userId: row.user_id };
      },
    };
  }

  describe('why was this merchant approved', () => {
    it('IS ANSWERABLE FROM THE DATABASE after operator decide', async () => {
      const id = await merchant();
      await kyb.submit({
        merchantId: id,
        kybRef: 'dossier-acme-1',
        actorId: MERCHANT_USER,
        actorScope: 'pay:write',
      });
      await kyb.decide({
        merchantId: id,
        decision: 'approved',
        reason: 'incorporation + UBO match; no sanctions hit',
        actorId: OPERATOR,
        actorScope: 'admin:compliance',
      });

      const event = at(await kyb.history(id, 50), 0, 'history');
      expect(event.toStatus).toBe('approved');
      expect(event.fromStatus).toBe('pending');
      expect(event.reason).toBe('incorporation + UBO match; no sanctions hit');
      expect(event.actorId).toBe(OPERATOR);
      expect(event.actorScope).toBe('admin:compliance');
      expect(event.kybRef).toBe('dossier-acme-1');
      expect((await kyb.currentStatus(id)).kybStatus).toBe('approved');
    });

    it('records submit then reject, and allows resubmit after reject', async () => {
      const id = await merchant();
      await kyb.submit({ merchantId: id, kybRef: 'd1', actorId: MERCHANT_USER, actorScope: 'pay:write' });
      await kyb.decide({
        merchantId: id,
        decision: 'rejected',
        reason: 'missing beneficial owner affidavit',
        actorId: OPERATOR,
        actorScope: 'admin:compliance',
      });
      expect((await kyb.currentStatus(id)).kybStatus).toBe('rejected');

      await kyb.submit({ merchantId: id, kybRef: 'd2', actorId: MERCHANT_USER, actorScope: 'pay:write' });
      expect((await kyb.currentStatus(id)).kybStatus).toBe('pending');
      expect((await kyb.history(id, 50)).map((e) => e.toStatus)).toEqual(['pending', 'rejected', 'pending']);
    });
  });

  describe('append-only', () => {
    it('REFUSES UPDATE and DELETE on KYB history', async () => {
      const id = await merchant();
      await kyb.submit({ merchantId: id, kybRef: 'd1', actorId: MERCHANT_USER, actorScope: 'pay:write' });
      await expect(sql`UPDATE pay.merchant_kyb_events SET reason = 'rewritten'`).rejects.toThrow(/append-only/);
      await expect(sql`DELETE FROM pay.merchant_kyb_events`).rejects.toThrow(/append-only/);
    });
  });

  describe('refuses', () => {
    it('blank decide reason', async () => {
      const id = await merchant();
      await kyb.submit({ merchantId: id, kybRef: 'd1', actorId: MERCHANT_USER, actorScope: 'pay:write' });
      const err = await rejection(
        kyb.decide({ merchantId: id, decision: 'approved', reason: '   ', actorId: OPERATOR, actorScope: 'admin:compliance' }),
        KybError,
      );
      expect(err.code).toBe('pay.kyb_reason_required');
    });

    it('decide when not pending', async () => {
      const id = await merchant();
      const err = await rejection(
        kyb.decide({ merchantId: id, decision: 'approved', reason: 'too early', actorId: OPERATOR, actorScope: 'admin:compliance' }),
        KybError,
      );
      expect(err.code).toBe('pay.kyb_invalid');
    });

    it('double submit while pending', async () => {
      const id = await merchant();
      await kyb.submit({ merchantId: id, kybRef: 'd1', actorId: MERCHANT_USER, actorScope: 'pay:write' });
      const err = await rejection(kyb.submit({ merchantId: id, kybRef: 'd2', actorId: MERCHANT_USER, actorScope: 'pay:write' }), KybError);
      expect(err.code).toBe('pay.kyb_invalid');
    });

    it('refuses kyb.submit when the caller does not own the merchant and leaves none and rejected', async () => {
      const noneId = await merchant('psp', MERCHANT_USER);
      const rejectedId = await merchant('psp', REJECTED_OWNER);
      await sql`UPDATE pay.merchants SET kyb_status = 'rejected' WHERE id = ${rejectedId}`;

      const router = createKybPspRouter(kyb, {} as PspModeService, unwiredApprovalConsumer(), owners());
      const stranger = router.createCaller(await caller(STRANGER));

      await expect(stranger.kyb.submit({ merchantId: noneId, kybRef: 'not-yours' })).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: expect.stringContaining('pay.merchant_forbidden'),
      });
      await expect(stranger.kyb.submit({ merchantId: rejectedId, kybRef: 'still-not-yours' })).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: expect.stringContaining('pay.merchant_forbidden'),
      });

      expect((await kyb.currentStatus(noneId)).kybStatus).toBe('none');
      expect((await kyb.currentStatus(noneId)).kybRef).toBeNull();
      expect((await kyb.currentStatus(rejectedId)).kybStatus).toBe('rejected');
      expect((await kyb.currentStatus(rejectedId)).kybRef).toBeNull();
      expect(await kyb.history(noneId, 50)).toEqual([]);
      expect(await kyb.history(rejectedId, 50)).toEqual([]);

      const owner = router.createCaller(await caller(REJECTED_OWNER));
      const submitted = await owner.kyb.submit({ merchantId: rejectedId, kybRef: 'dossier-owner' });
      expect(submitted.kybStatus).toBe('pending');
      expect(submitted.changed).toBe(true);
      expect(submitted.event?.actorId).toBe(REJECTED_OWNER);
      expect(submitted.event?.fromStatus).toBe('rejected');
      expect(submitted.event?.toStatus).toBe('pending');
      expect((await kyb.currentStatus(noneId)).kybStatus).toBe('none');
    });
  });
});
