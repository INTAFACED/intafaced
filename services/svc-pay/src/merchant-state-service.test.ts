import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { beforeEach, afterAll, beforeAll, describe, expect, it } from 'vitest';
import { truncatePayForTest } from './payment-events-test-reset.js';
import { MerchantStateError, MerchantStateService } from './merchant-state-service.js';

/**
 * Index access, under `noUncheckedIndexedAccess`.
 *
 * `history[0]` is `T | undefined` to the compiler, and a bare `!` would turn a
 * missing row into "Cannot read properties of undefined" fifty lines from the
 * assertion that cared. This says which row was expected and why the test failed.
 */
function at<T>(rows: readonly T[], index: number, what: string): T {
  const row = rows[index];
  if (row === undefined) throw new Error(`expected ${what}[${index}], but only ${rows.length} row(s) came back`);
  return row;
}

/**
 * The rejection, typed.
 *
 * `.catch((e) => e as X)` widens the result to `X | <resolved type>`, so every
 * property access after it is a type error — and worse, a call that WRONGLY
 * RESOLVES reads as `undefined` on the next line instead of failing where the
 * mistake is. This fails at the call that did not throw.
 */
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
 * MERCHANT STATE HAS A WRITER AND A HISTORY.
 *
 * `docs/adr/2026-08-04-pay-rails-and-psp-socket.md` (Accepted): *"Merchant state
 * has no history and no writer. `status='suspended'` is read and enforced by a
 * code path that nothing writes… a suspension cannot be explained, dated, or
 * undone, and an operator cannot answer 'why is this merchant suspended' from
 * the database."*
 *
 * THE TEST THAT MATTERS is the ADR's own sentence turned into an assertion:
 * after a suspension, is the answer to "why" in the database. Everything else
 * here defends that one.
 *
 * Postgres is real, and it has to be: the append-only guarantee is a TRIGGER and
 * the non-blank reason is a CHECK. An in-memory fake would have neither and
 * would pass while the deployed schema did not.
 *
 * H8a PG-hard: this file never `describe.skip` / `postgresAvailable`. CI uses
 * TEST_DATABASE_URL (per-run database via `createTestDatabase` so schema-qualified
 * `pay.*` SQL stays on `pay`). Local without that env starts Testcontainers
 * `postgres:16-alpine`. Docker/PG down is a failed suite, not a green skip.
 * The admin URL is `TEST_DATABASE_URL`, not `TEST_DATABASE_URL_PAY`: creating a
 * database needs CREATEDB, which the per-service roles deliberately lack.
 */

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Every forward migration, in order — what production applies. A suite that
 * stands up half a schema is testing a schema nobody deploys, and this table
 * references `pay.merchants` from `0000`.
 */
const drizzle = join(here, '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const OPERATOR = '99999999-9999-4999-8999-999999999999';
const OTHER_OPERATOR = '88888888-8888-4888-8888-888888888888';

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
      `H8a: svc-pay merchant-state is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

describe('svc-pay merchant state (source)', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

describe('svc-pay merchant state PG-hard', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let state: MerchantStateService;

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
      'TRUNCATE pay.merchant_status_events, pay.merchants RESTART IDENTITY CASCADE',
    );
    state = new MerchantStateService(sql);
  });

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  /** A merchant row, in whatever state the test needs to start from. */
  async function merchant(status: 'pending' | 'active' | 'suspended' | 'closed' = 'active'): Promise<string> {
    const [row] = await sql<Array<{ id: string }>>`
      INSERT INTO pay.merchants (user_id, status)
      VALUES (${`u-${Math.random().toString(36).slice(2)}`}, ${status}::pay.merchant_status)
      RETURNING id
    `;
    if (!row) throw new Error('inserting a merchant returned no row');
    return row.id;
  }

  const statusOf = async (merchantId: string) =>
    at(await sql<Array<{ status: string }>>`SELECT status FROM pay.merchants WHERE id = ${merchantId}`, 0, 'merchant').status;

  // ══ THE ADR'S SENTENCE, AS AN ASSERTION ═══════════════════════════════════

  describe('why is this merchant suspended', () => {
    it('IS ANSWERABLE FROM THE DATABASE — who, when, why, and from what', async () => {
      const id = await merchant('active');

      await state.setStatus({
        merchantId: id,
        to: 'suspended',
        reason: 'chargeback rate 4.1% over 30 days, three schemes',
        actorId: OPERATOR,
        actorScope: 'admin:write',
      });

      const event = at(await state.history(id, 50), 0, 'history');

      expect(event.toStatus).toBe('suspended');
      expect(event.fromStatus).toBe('active');
      expect(event.reason).toBe('chargeback rate 4.1% over 30 days, three schemes');
      expect(event.actorId).toBe(OPERATOR);
      expect(event.actorScope).toBe('admin:write');
      expect(event.createdAt).toBeInstanceOf(Date);
    });

    it('actually suspends them — the column PaymentService enforces on is the one that moved', async () => {
      // The history is worthless if it describes something that did not happen.
      // `payment-service.ts` refuses `payment.create` and the hosted checkout on
      // `merchants.status !== 'active'`, reading this exact column.
      const id = await merchant('active');
      await state.setStatus({ merchantId: id, to: 'suspended', reason: 'fraud review', actorId: OPERATOR, actorScope: 'admin:write' });

      expect(await statusOf(id)).toBe('suspended');
      expect(await state.currentStatus(id)).toBe('suspended');
    });

    it('can be UNDONE, and the undoing is itself explained and dated', async () => {
      const id = await merchant('active');
      await state.setStatus({
        merchantId: id,
        to: 'suspended',
        reason: 'suspected fraud ring',
        actorId: OPERATOR,
        actorScope: 'admin:write',
      });
      await state.setStatus({
        merchantId: id,
        to: 'active',
        reason: 'investigation closed — the disputes were one issuer’s error, all won',
        actorId: OTHER_OPERATOR,
        actorScope: 'admin:write',
      });

      expect(await statusOf(id)).toBe('active');

      const history = await state.history(id, 50);
      // Newest first, because the question is almost always about the CURRENT
      // state and the row that explains it is the last one written.
      expect(history.map((e) => e.toStatus)).toEqual(['active', 'suspended']);
      // Both rows survive. A suspension that was wrong is corrected by a new
      // row, not by editing the old one — the way a ledger reverses a posting.
      expect(at(history, 0, 'history').fromStatus).toBe('suspended');
      expect(at(history, 0, 'history').actorId).toBe(OTHER_OPERATOR);
      expect(at(history, 1, 'history').reason).toBe('suspected fraud ring');
    });
  });

  // ══ THE HISTORY IS EVIDENCE, SO IT CANNOT BE EDITED ═══════════════════════

  describe('append-only, enforced by the database', () => {
    it('REFUSES an UPDATE to a recorded reason', async () => {
      const id = await merchant('active');
      await state.setStatus({ merchantId: id, to: 'suspended', reason: 'the real reason', actorId: OPERATOR, actorScope: 'admin:write' });

      // A history that can be edited is worse than none: it looks like evidence
      // and is not.
      await expect(sql`UPDATE pay.merchant_status_events SET reason = 'a nicer reason'`).rejects.toThrow(/append-only/);
      expect(at(await state.history(id, 50), 0, 'history').reason).toBe('the real reason');
    });

    it('REFUSES a DELETE', async () => {
      const id = await merchant('active');
      await state.setStatus({ merchantId: id, to: 'suspended', reason: 'the real reason', actorId: OPERATOR, actorScope: 'admin:write' });

      await expect(sql`DELETE FROM pay.merchant_status_events`).rejects.toThrow(/append-only/);
      expect(await state.history(id, 50)).toHaveLength(1);
    });

    it('orders by seq, not by timestamp — two changes in one transaction share a clock', async () => {
      const id = await merchant('pending');
      await state.setStatus({ merchantId: id, to: 'active', reason: 'onboarding complete', actorId: OPERATOR, actorScope: 'admin:write' });
      await state.setStatus({ merchantId: id, to: 'suspended', reason: 'kyb lapsed', actorId: OPERATOR, actorScope: 'admin:write' });

      const history = await state.history(id, 50);
      expect(BigInt(at(history, 0, 'history').seq) > BigInt(at(history, 1, 'history').seq)).toBe(true);
      // A string, never a number: it is a `bigserial` ordering key, and a
      // `number` would put a 2^53 ceiling on an append-only log for no benefit.
      expect(typeof at(history, 0, 'history').seq).toBe('string');
    });
  });

  // ══ WHAT THE WRITER REFUSES ══════════════════════════════════════════════

  describe('the writer refuses what would make the history useless', () => {
    it('refuses a blank reason, in the service, with a sentence', async () => {
      const id = await merchant('active');
      const err = await rejection(
        state.setStatus({ merchantId: id, to: 'suspended', reason: '   ', actorId: OPERATOR, actorScope: 'admin:write' }),
        MerchantStateError,
      );

      expect(err).toBeInstanceOf(MerchantStateError);
      expect(err.code).toBe('pay.merchant_status_reason_required');
      expect(await statusOf(id)).toBe('active');
    });

    it('refuses a blank reason in the DATABASE too, for anything that does not come through the service', async () => {
      // Two checks, because the first is for the operator and the second is the
      // guarantee. A `psql` session or a future writer bypasses the first.
      const id = await merchant('active');
      await expect(sql`
        INSERT INTO pay.merchant_status_events (merchant_id, from_status, to_status, reason, actor_id, actor_scope)
        VALUES (${id}, 'active'::pay.merchant_status, 'suspended'::pay.merchant_status, '  ', ${OPERATOR}, 'admin:write')
      `).rejects.toThrow(/merchant_status_events_reason_not_blank/);
    });

    it('refuses an unknown merchant rather than writing an orphan row', async () => {
      const err = await rejection(
        state.setStatus({
          merchantId: '00000000-0000-4000-8000-000000000000',
          to: 'suspended',
          reason: 'anything',
          actorId: OPERATOR,
          actorScope: 'admin:write',
        }),
        MerchantStateError,
      );

      expect(err.code).toBe('pay.merchant_not_found');
    });

    it('writes NOTHING for a no-op, so the real rows stay findable', async () => {
      const id = await merchant('active');
      const result = await state.setStatus({
        merchantId: id,
        to: 'active',
        reason: 'clicked twice',
        actorId: OPERATOR,
        actorScope: 'admin:write',
      });

      // Not an error — an operator clicking twice is not a fault. But a history
      // full of `active → active` is a history nobody reads, and a history
      // nobody reads is how the real rows get missed.
      expect(result.changed).toBe(false);
      expect(result.event).toBeNull();
      expect(await state.history(id, 50)).toHaveLength(0);
    });
  });

  // ══ WHAT IT DELIBERATELY DOES NOT DECIDE ═════════════════════════════════

  describe('recording who, when and why is not deciding when', () => {
    it('permits any transition between any two statuses, INCLUDING out of closed', async () => {
      // This looks lax and is the deliberate half. A transition map is a POLICY:
      // it rules that closure is final, that a pending merchant may be suspended
      // before approval, and half a dozen other things nobody has decided.
      // `payments` has a transition map because §6.1 states one. Merchant state
      // does not have one yet, and inventing it inside an audit-trail change
      // would smuggle product law in under a logging PR.
      const id = await merchant('closed');
      await state.setStatus({
        merchantId: id,
        to: 'active',
        reason: 'closed in error, merchant re-signed',
        actorId: OPERATOR,
        actorScope: 'admin:write',
      });

      expect(await statusOf(id)).toBe('active');
      // And the strange transition is attributable and dated, which is the whole
      // thing this change buys.
      expect(at(await state.history(id, 50), 0, 'history').fromStatus).toBe('closed');
    });

    it('has no automatic suspension anywhere — nothing calls this on a rule', async () => {
      // Asserted as a property of the API surface rather than by grep: the only
      // way to change a merchant's status is to name the target and a reason.
      // There is no threshold parameter, no policy object, and no evaluate().
      const keys = Object.getOwnPropertyNames(MerchantStateService.prototype).filter((k) => k !== 'constructor');
      expect(keys.sort()).toEqual(['currentStatus', 'history', 'setStatus']);
    });
  });

  // ══ CONCURRENCY ══════════════════════════════════════════════════════════

  describe('two operators at once', () => {
    it('records two changes out of two DIFFERENT states, not two out of the same one', async () => {
      const id = await merchant('active');

      // FOR UPDATE serialises these. Without it both would read `active` and the
      // log would claim two changes out of one state — which would make the
      // chain unreadable exactly when somebody is trying to reconstruct an
      // incident.
      await Promise.all([
        state.setStatus({ merchantId: id, to: 'suspended', reason: 'operator one', actorId: OPERATOR, actorScope: 'admin:write' }),
        state.setStatus({ merchantId: id, to: 'closed', reason: 'operator two', actorId: OTHER_OPERATOR, actorScope: 'admin:write' }),
      ]);

      const history = await state.history(id, 50);
      expect(history).toHaveLength(2);

      // The chain is intact: the newer row's `from` is the older row's `to`.
      expect(at(history, 0, 'history').fromStatus).toBe(at(history, 1, 'history').toStatus);
      expect(at(history, 1, 'history').fromStatus).toBe('active');
      expect(await statusOf(id)).toBe(at(history, 0, 'history').toStatus);
    });
  });
});
