import { truncatePayForTest } from './payment-events-test-reset.js';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { beforeEach, afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KybError, KybService } from './kyb-service.js';
import { syntheticKybScreening } from './screening/test-support.js';

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
    kyb = new KybService(sql, syntheticKybScreening(sql));
  });

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  async function merchant(mode: 'gateway' | 'psp' | 'payfac' = 'psp'): Promise<string> {
    const [row] = await sql<Array<{ id: string }>>`
      INSERT INTO pay.merchants (user_id, mode, status, pricing)
      VALUES (${`u-${Math.random().toString(36).slice(2)}`}, ${mode}, 'active', ${sql.json({ feeBps: 250 } as never)})
      RETURNING id
    `;
    if (!row) throw new Error('inserting a merchant returned no row');
    return row.id;
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
  });
});
