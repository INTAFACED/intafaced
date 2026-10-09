import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { describe, expect, it, beforeAll, beforeEach, afterAll } from 'vitest';
import {
  MemoryLedger,
  formatAmount,
  parseAmount as amt,
  railBoundary,
  recipes,
  userAvailable,
  withdrawalHoldAccount,
} from '@intafaced/ledger-client';
import { PayError } from './payment-service.js';
import { UserMoneyService } from './user-money-service.js';
import { RailRegistry } from './rails/registry.js';
import { CardSandboxAdapter } from './rails/card-sandbox.js';
import { CryptoNativeAdapter } from './rails/crypto-native.js';
import { MemoryChain } from './rails/chain-port.js';

/**
 * USER MONEY IN AND OUT — the two paths whose absence made the platform
 * unusable end to end.
 *
 * Before this: `recipes.deposit` was called from tests only, so nothing ever
 * credited a user's `available` balance and `orderHold` could only fail; and
 * `withdrawHold/Settle/Reverse` were used in exactly one production site, a
 * MERCHANT payout, so a user could not get money out at all.
 *
 * WHAT EACH TEST HERE IS FOR. Every one of them fails if a specific money path
 * breaks — not if the code is merely rearranged. In particular the questions
 * this file exists to answer are the §5 ones: *if this crashes exactly here,
 * whose funds are stranded?* Each crash point is simulated by driving the two
 * phases separately and asserting what the BOOK says in between, because the
 * book is the only thing that matters when a process dies.
 *
 * Postgres is real: the unique indexes on `(rail, rail_ref)` and
 * `(user_id, client_ref)` are the idempotency, and an in-memory fake would
 * quietly not have them. The ledger is `MemoryLedger`, the reference
 * implementation the conformance suite proves equivalent to svc-ledger's
 * Postgres engine (§4.4).
 *
 * H8a PG-hard: this file never `describe.skip` / `postgresAvailable`. CI uses
 * TEST_DATABASE_URL (per-run database via `createTestDatabase` so schema-qualified
 * `pay.*` SQL stays on `pay`). Local without that env starts Testcontainers
 * `postgres:16-alpine`. Docker/PG down is a failed suite, not a green skip.
 * The admin URL is `TEST_DATABASE_URL`, not `TEST_DATABASE_URL_PAY`: creating a
 * database needs CREATEDB, which the per-service roles deliberately lack.
 */

/**
 * A PER-RUN DATABASE, created and dropped by this suite.
 *
 * This suite APPLIES MIGRATIONS and TRUNCATES TABLES. Pointed at the shared
 * `intafaced` database it did both to the schema and the rows every other
 * worktree and the running docker stack were using — which is how a branch
 * broke `main`'s tests from a different checkout, with live rows in
 * `pay.deposits` / `pay.withdrawals`. #211 moved it to `intafaced_test`, which
 * fixed that and left a smaller version of it: `intafaced_test` is shared too,
 * so two worktrees running THIS FILE still truncated each other.
 *
 * pay's SQL is schema-qualified (`pay.…`) on purpose — §2 keeps a service
 * physically unable to reach outside its own schema. That is exactly why
 * `createTestDb`'s generated schema (`test_pay_4711_1`) cannot host it, the way
 * it hosts svc-ledger. `createTestDatabase` moves the isolation boundary from
 * the schema to the DATABASE and creates `pay` under its real name inside it.
 * Every statement below, and every migration, is unchanged.
 *
 * The URL is the ADMIN one (`TEST_DATABASE_URL`), not `TEST_DATABASE_URL_PAY`:
 * creating a database needs CREATEDB, which the per-service roles deliberately
 * lack. It must still name a `*_test` database — `assertTestDatabase` refuses
 * anything else, and asks the server rather than trusting the string.
 */
const here = dirname(fileURLToPath(import.meta.url));

/**
 * EVERY forward migration, in order.
 *
 * This used to be `0001` alone, deliberately: `deposits` and `withdrawals`
 * reference nothing in `0000`, so applying only the one file was how this suite
 * avoided taking ACCESS EXCLUSIVE locks on tables `payment-service.test.ts` was
 * truncating in a parallel vitest worker. That contortion — and the advisory
 * lock that went with it — existed only because both suites brought the schema
 * up on ONE shared database.
 *
 * They no longer do, so the constraint is gone and the correct thing is
 * possible again: apply what production applies. A suite that stands up half a
 * schema is testing a schema nobody deploys.
 */
const drizzle = join(here, '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const SECRET = 'svc-pay-user-money-test-secret-at-least-32-chars';
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '22222222-2222-4222-8222-222222222222';
const OPERATOR = '99999999-9999-4999-8999-999999999999';

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
      `H8a: svc-pay user money is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

describe('svc-pay user money (source)', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

describe('svc-pay user money PG-hard', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let ledger: MemoryLedger;
  let chain: MemoryChain;
  let card: CardSandboxAdapter;
  let rails: RailRegistry;
  let money: UserMoneyService;

  beforeAll(async () => {
    const admin = await openH8aAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    sql = db.sql;
  }, 120_000);

  beforeEach(async () => {
    await sql`TRUNCATE pay.withdrawals, pay.deposits RESTART IDENTITY CASCADE`;
    ledger = new MemoryLedger();
    chain = new MemoryChain();
    card = new CardSandboxAdapter({ secret: SECRET, toleranceSeconds: 300 });
    rails = new RailRegistry([card, new CryptoNativeAdapter({ chain, secret: SECRET, minConfirmations: 6, toleranceSeconds: 300 })]);
    money = new UserMoneyService(sql, ledger, rails, { operatorCreditRails: ['card-sandbox'] });
  });

  /**
   * 30s, not vitest's default 10s. Dropping a DATABASE is heavier than closing a
   * pool, and when several suite files tear down at the same moment Postgres
   * serialises the drops. The work still finishes well inside this; the default
   * was sized for `sql.end()`, which is all this hook used to do.
   */
  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  // ── helpers ────────────────────────────────────────────────────────────────

  const deposit = (overrides: Partial<Parameters<UserMoneyService['credit']>[0]> = {}) =>
    money.credit({
      userId: USER,
      assetId: 'USDT',
      amount: amt('100'),
      rail: 'card-sandbox',
      railRef: 'psp_ref_1',
      creditedBy: OPERATOR,
      ...overrides,
    });

  const withdraw = (overrides: Partial<Parameters<UserMoneyService['withdraw']>[0]> = {}) =>
    money.withdraw({
      userId: USER,
      assetId: 'USDT',
      amount: amt('40'),
      rail: 'card-sandbox',
      destination: { kind: 'bank', ref: 'DE89370400440532013000' },
      clientRef: 'w-1',
      ...overrides,
    });

  const availableOf = async (userId = USER, assetId = 'USDT') =>
    formatAmount((await ledger.balance(userAvailable(userId, assetId))).amount);
  const boundaryOf = async (rail = 'card-sandbox', assetId = 'USDT') =>
    formatAmount((await ledger.balance(railBoundary(rail, assetId))).amount);
  const holdOf = async (withdrawalId: string, attempt: number, userId = USER, assetId = 'USDT') =>
    formatAmount((await ledger.balance(withdrawalHoldAccount(userId, assetId, `${withdrawalId}:${attempt}`))).amount);

  // ══ DEPOSIT ════════════════════════════════════════════════════════════════

  describe('deposit — value enters the book from a rail', () => {
    it('credits the user’s available balance, and the rail boundary carries the obligation', async () => {
      expect(await availableOf()).toBe('0');

      const record = await deposit();

      expect(record.status).toBe('credited');
      expect(await availableOf()).toBe('100');
      // The boundary account goes NEGATIVE by exactly the amount. That number is
      // the platform's obligation to the outside world, and it is the figure
      // reconciliation checks against actual custody.
      expect(await boundaryOf()).toBe('-100');
    });

    it('UNBLOCKS TRADING: an order-sized hold now succeeds where it could only fail before', async () => {
      // The whole reason this path exists. Without a deposit, `orderHold` has
      // nothing to draw on and `orders.create` fails for every account on the
      // platform.
      await deposit({ amount: amt('100') });

      const { recipes } = await import('@intafaced/ledger-client');
      await expect(
        ledger.post(recipes.orderHold({ orderId: 'ord-1', userId: USER, assetId: 'USDT', amount: amt('60') })),
      ).resolves.toBeDefined();
      expect(await availableOf()).toBe('40');
    });

    it('is idempotent on (rail, railRef) — a redelivered webhook credits once', async () => {
      const first = await deposit();
      const second = await deposit();

      expect(second.id).toBe(first.id);
      expect(await availableOf()).toBe('100');
      const rows = await sql`SELECT id FROM pay.deposits`;
      expect(rows).toHaveLength(1);
    });

    it('REFUSES A REUSED RAIL REFERENCE THAT NAMES A DIFFERENT AMOUNT', async () => {
      await deposit({ amount: amt('5') });

      // The branch that would otherwise lose money silently. `recipes.deposit`
      // is keyed on (rail, railRef) alone, so posting again returns the ORIGINAL
      // transaction — the book moves 5 and the caller is told 500.
      await expect(deposit({ amount: amt('500') })).rejects.toMatchObject({ code: 'pay.deposit_conflict' });
      expect(await availableOf()).toBe('5');
    });

    it('refuses a reused rail reference that names a different user or asset', async () => {
      await deposit();

      await expect(deposit({ userId: OTHER_USER })).rejects.toMatchObject({ code: 'pay.deposit_conflict' });
      await expect(deposit({ assetId: 'BTC' })).rejects.toMatchObject({ code: 'pay.deposit_conflict' });
      expect(await availableOf(OTHER_USER)).toBe('0');
    });

    it('records WHICH OPERATOR credited it', async () => {
      const record = await deposit();
      expect(record.creditedBy).toBe(OPERATOR);

      const rows = await sql<Array<{ credited_by: string }>>`SELECT credited_by FROM pay.deposits WHERE id = ${record.id}`;
      expect(rows[0]!.credited_by).toBe(OPERATOR);
    });

    it('refuses a rail that is not on the operator-credit list', async () => {
      // `crypto-native` is registered and perfectly capable — but a hand-typed
      // credit there would move `railBoundary('crypto-native')` away from the
      // chain balance it mirrors, and reconciliation would report a discrepancy
      // that is really a typo.
      await expect(deposit({ rail: 'crypto-native' })).rejects.toMatchObject({ code: 'pay.rail_not_creditable' });
      expect(await availableOf()).toBe('0');
    });

    it('refuses a rail that does not exist at all', async () => {
      await expect(deposit({ rail: 'not-a-rail' })).rejects.toMatchObject({ code: 'pay.rail_unknown' });
    });

    it('refuses a zero or negative amount before anything is claimed', async () => {
      await expect(deposit({ amount: 0n })).rejects.toMatchObject({ code: 'pay.invalid_amount' });
      await expect(deposit({ amount: -1n })).rejects.toMatchObject({ code: 'pay.invalid_amount' });
      expect(await sql`SELECT id FROM pay.deposits`).toHaveLength(0);
    });

    it('keeps 18 decimal places intact end to end', async () => {
      const record = await deposit({ amount: amt('0.000000000000000001'), railRef: 'dust' });
      expect(formatAmount(record.amount)).toBe('0.000000000000000001');
      expect(await availableOf()).toBe('0.000000000000000001');
    });

    /**
     * CRASH POINT: claimed, not yet booked.
     *
     * Whose funds are stranded? The user's — at the rail, not in the book. The
     * `pending` row is the marker that says so, and repeating the call finishes
     * the job.
     */
    it('resumes a deposit that was claimed but never booked', async () => {
      await sql`
        INSERT INTO pay.deposits (user_id, asset_id, amount, rail, rail_ref, credited_by, status)
        VALUES (${USER}, 'USDT', 100, 'card-sandbox', 'psp_ref_1', ${OPERATOR}, 'pending')
      `;
      expect(await availableOf()).toBe('0');

      const resumed = await deposit();

      expect(resumed.status).toBe('credited');
      expect(await availableOf()).toBe('100');
      expect(await sql`SELECT id FROM pay.deposits`).toHaveLength(1);
    });

    /**
     * CRASH POINT: booked, row one status behind.
     *
     * Nobody's funds are stranded — the user has their money. Repeating the call
     * must NOT credit twice; the ledger's idempotency key is what guarantees it.
     */
    it('does not double-credit when the book already moved but the row says pending', async () => {
      await deposit();
      await sql`UPDATE pay.deposits SET status = 'pending'`;

      await deposit();

      expect(await availableOf()).toBe('100');
      expect(await boundaryOf()).toBe('-100');
    });
  });

  // ══ WITHDRAWAL ═════════════════════════════════════════════════════════════

  describe('withdrawal — value leaves the book through a rail', () => {
    beforeEach(async () => {
      await deposit({ amount: amt('100') });
    });

    it('moves available → hold → out, and leaves nothing behind', async () => {
      const record = await withdraw({ amount: amt('40') });

      expect(record.status).toBe('sent');
      expect(record.railRef).toBeTruthy();
      expect(await availableOf()).toBe('60');
      // The hold is empty: it was a waypoint, not a destination.
      expect(await holdOf(record.id, 0)).toBe('0');
      // 100 in, 40 out: the boundary owes 60 net.
      expect(await boundaryOf()).toBe('-60');
    });

    it('HOLDS FIRST — the funds are out of `available` before the rail is asked', async () => {
      // The ordering that makes the whole path safe. Proven by watching the
      // balance from inside the rail call, which is the only moment it is
      // observable.
      let availableDuringRail: string | null = null;
      const spy = new Proxy(card, {
        get(target, prop, receiver) {
          if (prop === 'payout') {
            return async (...args: Parameters<CardSandboxAdapter['payout']>) => {
              availableDuringRail = await availableOf();
              return target.payout(...args);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
      money = new UserMoneyService(sql, ledger, new RailRegistry([spy]), { operatorCreditRails: ['card-sandbox'] });

      await withdraw({ amount: amt('40') });

      // Already debited when the rail was called. If this ever reads '100', the
      // platform is asking a rail to send money it has not yet reserved.
      expect(availableDuringRail).toBe('60');
    });

    it('uses a PURPOSE-KEYED hold, not the user’s one shared hold (P0-3)', async () => {
      const { recipes } = await import('@intafaced/ledger-client');
      // An open order reserving funds at the same time.
      await ledger.post(recipes.orderHold({ orderId: 'ord-1', userId: USER, assetId: 'USDT', amount: amt('50') }));

      const record = await withdraw({ amount: amt('40') });

      // The order's reservation is untouched. With one shared hold per
      // (user, asset), the withdrawal's settle could have consumed it — the
      // books would still balance and the order would be unfunded.
      const orderHold = await ledger.balance({ ownerType: 'user', ownerId: USER, assetId: 'USDT', kind: 'hold', purpose: 'order:ord-1' });
      expect(formatAmount(orderHold.amount)).toBe('50');
      expect(record.status).toBe('sent');
      expect(await availableOf()).toBe('10');
    });

    it('REFUSES A WITHDRAWAL THE USER CANNOT AFFORD, before any rail is asked', async () => {
      await expect(withdraw({ amount: amt('500') })).rejects.toThrow(/insufficient/i);

      // Nothing moved, and the row records why.
      expect(await availableOf()).toBe('100');
      const rows = await sql<Array<{ status: string; failure_code: string }>>`SELECT status, failure_code FROM pay.withdrawals`;
      expect(rows[0]).toMatchObject({ status: 'failed', failure_code: 'ledger.insufficient_funds' });
    });

    it('REVERSES THE HOLD when the rail refuses — the user gets their money back in the same call', async () => {
      card.failNext('bank.rejected', 'Beneficiary account closed');

      await expect(withdraw({ amount: amt('40') })).rejects.toMatchObject({ code: 'pay.rail_failed' });

      // Whole balance back. Not "eventually", not "after a sweep" — in the same
      // call that failed.
      expect(await availableOf()).toBe('100');
      const record = (await money.listWithdrawals(USER, 50))[0]!;
      expect(record.status).toBe('failed');
      expect(record.failureCode).toBe('bank.rejected');
      expect(await holdOf(record.id, 0)).toBe('0');
    });

    it('L3-1 recovers when failure_code is stamped on held before reverse finishes', async () => {
      // Simulate: hold posted, rail refused intent stamped on the row, process
      // died before finalizeRailRefusal ran. Money still in the hold.
      // Fixture must match the withdraw helper (rail + destination) or claim
      // rejects as conflict before L3-1 recovery can run.
      const clientRef = 'w-l3-1';
      const rows = await sql<Array<{ id: string }>>`
        INSERT INTO pay.withdrawals (user_id, asset_id, amount, rail, destination, client_ref, status, attempts)
        VALUES (
          ${USER}, 'USDT', ${'40'}::numeric, 'card-sandbox',
          ${sql.json({ kind: 'bank', ref: 'DE89370400440532013000' })}, ${clientRef}, 'held', 0
        )
        RETURNING id
      `;
      const id = rows[0]!.id;
      await ledger.post(
        recipes.withdrawHold({
          userId: USER,
          assetId: 'USDT',
          amount: amt('40'),
          rail: 'card-sandbox',
          withdrawalId: `${id}:0`,
        }),
      );
      await sql`
        UPDATE pay.withdrawals SET failure_code = 'bank.rejected', updated_at = now() WHERE id = ${id}
      `;
      expect(await holdOf(id, 0)).toBe('40');
      expect(await availableOf()).toBe('60');

      await expect(withdraw({ amount: amt('40'), clientRef })).rejects.toMatchObject({
        code: 'pay.rail_failed',
      });

      const recovered = (await money.listWithdrawals(USER, 50))[0]!;
      expect(recovered.status).toBe('failed');
      expect(recovered.failureCode).toBe('bank.rejected');
      expect(recovered.attempts).toBe(1);
      expect(await holdOf(id, 0)).toBe('0');
      expect(await availableOf()).toBe('100');
    });

    it('advances the attempt counter on refusal, so the retry does not reuse a released hold', async () => {
      card.failNext('bank.rejected', 'Beneficiary account closed');
      await expect(withdraw()).rejects.toMatchObject({ code: 'pay.rail_failed' });

      const failed = (await money.listWithdrawals(USER, 50))[0]!;
      expect(failed.attempts).toBe(1);

      // The retry re-holds under `withdraw:<id>:1`. Reusing `:0` would find the
      // released hold, move nothing, and then settle out of a hold that is not
      // there — a balanced book and a user who was never paid.
      const retried = await withdraw();
      expect(retried.status).toBe('sent');
      expect(await availableOf()).toBe('60');
      expect(await holdOf(retried.id, 0)).toBe('0');
      expect(await holdOf(retried.id, 1)).toBe('0');
    });

    it('is idempotent on clientRef — a retried request resumes, it does not debit twice', async () => {
      const first = await withdraw({ clientRef: 'w-42' });
      const second = await withdraw({ clientRef: 'w-42' });

      expect(second.id).toBe(first.id);
      expect(second.status).toBe('sent');
      // 40 once, not 80.
      expect(await availableOf()).toBe('60');
      expect(await sql`SELECT id FROM pay.withdrawals`).toHaveLength(1);
    });

    it('refuses a reused clientRef that names different money', async () => {
      await withdraw({ clientRef: 'w-42', amount: amt('40') });

      await expect(withdraw({ clientRef: 'w-42', amount: amt('50') })).rejects.toMatchObject({ code: 'pay.withdrawal_conflict' });
      await expect(withdraw({ clientRef: 'w-42', destination: { kind: 'bank', ref: 'NL91ABNA0417164300' } })).rejects.toMatchObject({
        code: 'pay.withdrawal_conflict',
      });
      expect(await availableOf()).toBe('60');
    });

    /**
     * CRASH POINT: held, rail never asked.
     *
     * THE ONE BRANCH WHERE VALUE IS IMMOBILISED. The funds are the user's, out
     * of `available` and sitting in `withdraw:<id>:0`. Recoverable by repeating
     * the call, which is why `held` is a real status with its own index.
     */
    it('resumes a withdrawal stuck in `held` and finishes it, without holding twice', async () => {
      const { recipes } = await import('@intafaced/ledger-client');
      const rows = await sql<Array<{ id: string }>>`
        INSERT INTO pay.withdrawals (user_id, asset_id, amount, rail, destination, client_ref, status)
        VALUES (${USER}, 'USDT', 40, 'card-sandbox', ${sql.json({ kind: 'bank', ref: 'DE89370400440532013000' } as never)}, 'w-1', 'held')
        RETURNING id
      `;
      const id = rows[0]!.id;
      await ledger.post(
        recipes.withdrawHold({ userId: USER, assetId: 'USDT', amount: amt('40'), rail: 'card-sandbox', withdrawalId: `${id}:0` }),
      );

      // Immobilised: out of available, not yet gone.
      expect(await availableOf()).toBe('60');
      expect(await holdOf(id, 0)).toBe('40');

      const resumed = await withdraw();

      expect(resumed.id).toBe(id);
      expect(resumed.status).toBe('sent');
      // Still 60 — the resume re-posted the same hold key, which moved nothing.
      expect(await availableOf()).toBe('60');
      expect(await holdOf(id, 0)).toBe('0');
      expect(await boundaryOf()).toBe('-60');
    });

    /**
     * CRASH POINT: held, and the idempotent hold re-post throws.
     *
     * The funds already left `available`. Failing the row here used to stamp
     * `ledger.insufficient_funds` and skip `withdrawReverse`, so the hold stayed
     * put under a terminal status and `attempts` never moved. The release has
     * to land before the row is failed, on the same attempt key.
     */
    it('releases a held withdrawal when the hold re-post throws', async () => {
      const rows = await sql<Array<{ id: string }>>`
        INSERT INTO pay.withdrawals (user_id, asset_id, amount, rail, destination, client_ref, status)
        VALUES (${USER}, 'USDT', 40, 'card-sandbox', ${sql.json({ kind: 'bank', ref: 'DE89370400440532013000' } as never)}, 'w-1', 'held')
        RETURNING id
      `;
      const id = rows[0]!.id;
      await ledger.post(
        recipes.withdrawHold({ userId: USER, assetId: 'USDT', amount: amt('40'), rail: 'card-sandbox', withdrawalId: `${id}:0` }),
      );
      expect(await availableOf()).toBe('60');
      expect(await holdOf(id, 0)).toBe('40');

      let heldReposts = 0;
      const throwing = new Proxy(ledger, {
        get(target, prop, receiver) {
          if (prop === 'post') {
            return async (request: Parameters<MemoryLedger['post']>[0]) => {
              if (request.idempotencyKey.startsWith('withdraw.hold:')) {
                heldReposts += 1;
                if (heldReposts === 1) throw new Error('hold re-post failed');
              }
              return target.post(request);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
      money = new UserMoneyService(sql, throwing, rails, { operatorCreditRails: ['card-sandbox'] });

      await expect(withdraw()).rejects.toThrow(/hold re-post failed/);

      const failed = (await money.listWithdrawals(USER, 50))[0]!;
      expect(failed.id).toBe(id);
      expect(failed.status).toBe('failed');
      expect(failed.failureCode).toBe('rail.failed');
      expect(failed.attempts).toBe(1);
      expect(await holdOf(id, 0)).toBe('0');
      expect(await availableOf()).toBe('100');
      expect(await ledger.getTxByKey(`withdraw.reverse:${id}:0`)).not.toBeNull();

      const retried = await withdraw();
      expect(retried.id).toBe(id);
      expect(retried.status).toBe('sent');
      expect(retried.attempts).toBe(1);
      expect(await availableOf()).toBe('60');
      expect(await holdOf(id, 0)).toBe('0');
      expect(await holdOf(id, 1)).toBe('0');
    });

    it('does not fail a held withdrawal when the release does not land', async () => {
      const rows = await sql<Array<{ id: string }>>`
        INSERT INTO pay.withdrawals (user_id, asset_id, amount, rail, destination, client_ref, status)
        VALUES (${USER}, 'USDT', 40, 'card-sandbox', ${sql.json({ kind: 'bank', ref: 'DE89370400440532013000' } as never)}, 'w-1', 'held')
        RETURNING id
      `;
      const id = rows[0]!.id;
      await ledger.post(
        recipes.withdrawHold({ userId: USER, assetId: 'USDT', amount: amt('40'), rail: 'card-sandbox', withdrawalId: `${id}:0` }),
      );

      const throwing = new Proxy(ledger, {
        get(target, prop, receiver) {
          if (prop === 'post') {
            return async (request: Parameters<MemoryLedger['post']>[0]) => {
              if (request.idempotencyKey.startsWith('withdraw.hold:') || request.idempotencyKey.startsWith('withdraw.reverse:')) {
                throw new Error('ledger post failed');
              }
              return target.post(request);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
      money = new UserMoneyService(sql, throwing, rails, { operatorCreditRails: ['card-sandbox'] });

      await expect(withdraw()).rejects.toThrow(/ledger post failed/);

      const record = (await money.listWithdrawals(USER, 50))[0]!;
      expect(record.status).toBe('held');
      expect(record.attempts).toBe(0);
      expect(record.failureCode).not.toBe('ledger.insufficient_funds');
      expect(await holdOf(id, 0)).toBe('40');
      expect(await availableOf()).toBe('60');
    });

    it('does not label a hold post that throws before funds leave as insufficient funds', async () => {
      const throwing = new Proxy(ledger, {
        get(target, prop, receiver) {
          if (prop === 'post') {
            return async (request: Parameters<MemoryLedger['post']>[0]) => {
              if (request.idempotencyKey.startsWith('withdraw.hold:')) throw new Error('ledger unavailable');
              return target.post(request);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
      money = new UserMoneyService(sql, throwing, rails, { operatorCreditRails: ['card-sandbox'] });

      await expect(withdraw()).rejects.toThrow(/ledger unavailable/);

      const rows = await sql<Array<{ status: string; failure_code: string | null; attempts: number }>>`
        SELECT status, failure_code, attempts FROM pay.withdrawals
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 'pending', failure_code: null, attempts: 0 });
      expect(await availableOf()).toBe('100');
    });

    /**
     * CRASH POINT: rail sent, settle not posted.
     *
     * The payout for this attempt has already been accepted and the row is
     * still `held`: the hold is on the book and `withdraw.settled` is not.
     * The platform is short by that payout until the settle runs. Repeating
     * the call posts the settle once. A finished `sent` row is a different
     * case. If the retry asks the rail again, it must carry the same
     * settlement id as the attempt that already paid.
     */
    it('squares the book when the rail already sent but the settle never posted', async () => {
      const payoutIds: string[] = [];
      const spy = new Proxy(card, {
        get(target, prop, receiver) {
          if (prop === 'payout') {
            return async (...args: Parameters<CardSandboxAdapter['payout']>) => {
              payoutIds.push(args[0]!.settlementId);
              return target.payout(...args);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });

      let settleThrown = false;
      const throwing = new Proxy(ledger, {
        get(target, prop, receiver) {
          if (prop === 'post') {
            return async (request: Parameters<MemoryLedger['post']>[0]) => {
              if (request.idempotencyKey.startsWith('withdraw.settle:') && !settleThrown) {
                settleThrown = true;
                throw new Error('settle post failed');
              }
              return target.post(request);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
      money = new UserMoneyService(sql, throwing, new RailRegistry([spy]), { operatorCreditRails: ['card-sandbox'] });

      await expect(withdraw()).rejects.toThrow(/settle post failed/);

      const held = (await money.listWithdrawals(USER, 50))[0]!;
      expect(held.status).toBe('held');
      expect(held.failureCode).toBeNull();
      expect(held.attempts).toBe(0);
      expect(await holdOf(held.id, 0)).toBe('40');
      expect(await availableOf()).toBe('60');
      expect(await boundaryOf()).toBe('-100');
      expect(await ledger.getTxByKey(`withdraw.settle:${held.id}:0`)).toBeNull();
      const firstPayout = payoutIds[0];
      expect(firstPayout).toBe(`${held.id}:0`);

      const resumed = await withdraw();

      expect(resumed.id).toBe(held.id);
      expect(resumed.status).toBe('sent');
      expect(resumed.attempts).toBe(0);
      expect(await availableOf()).toBe('60');
      expect(await boundaryOf()).toBe('-60');
      expect(await holdOf(held.id, 0)).toBe('0');
      expect(ledger.journal().filter((tx) => tx.reason === 'withdraw.settled')).toHaveLength(1);
      expect(payoutIds.length).toBeGreaterThan(0);
      expect(new Set(payoutIds).size).toBe(1);
      expect(payoutIds.every((id) => id === firstPayout)).toBe(true);
    });

    it('refuses a rail that cannot pay out, before a row exists', async () => {
      await expect(withdraw({ rail: 'not-a-rail' })).rejects.toThrow(/No rail adapter/);
      expect(await sql`SELECT id FROM pay.withdrawals`).toHaveLength(0);
      expect(await availableOf()).toBe('100');
    });

    it('refuses a zero or negative amount before anything is claimed', async () => {
      await expect(withdraw({ amount: 0n })).rejects.toMatchObject({ code: 'pay.invalid_amount' });
      await expect(withdraw({ amount: -1n })).rejects.toMatchObject({ code: 'pay.invalid_amount' });
      expect(await sql`SELECT id FROM pay.withdrawals`).toHaveLength(0);
    });

    it('reads the withdrawable balance from the LEDGER, not from these tables', async () => {
      await withdraw({ amount: amt('40') });
      // Deliberately independent of `pay.deposits` and `pay.withdrawals` — that
      // independence is the whole property reconciliation needs (Doctrine §0.6).
      expect(formatAmount(await money.availableBalance(USER, 'USDT'))).toBe('60');
    });

    it('does not find another user’s withdrawal by id', async () => {
      const record = await withdraw();
      // The service returns the row; the ROUTER is what refuses a stranger.
      // Asserted here so the ownership field the router checks is definitely on
      // the record it checks.
      expect((await money.getWithdrawal(record.id)).userId).toBe(USER);
      expect(await money.listWithdrawals(OTHER_USER, 50)).toHaveLength(0);
    });

    it('reports a missing withdrawal rather than returning nothing', async () => {
      await expect(money.getWithdrawal('00000000-0000-4000-8000-000000000000')).rejects.toBeInstanceOf(PayError);
    });
  });

  // ══ DOUBLE SUBMIT ══════════════════════════════════════════════════════════

  /**
   * THE SAME REQUEST, TWICE, AT THE SAME MOMENT.
   *
   * Everything above drives a retry SEQUENTIALLY — call, await, call again. That
   * is the impatient-user case and the job-that-woke-up case, and it is covered.
   * It is not the case a real client produces: a request times out at the edge
   * while it is still running, the client retries, and now two requests are
   * inside this service at once carrying the same business key.
   *
   * The sequential tests cannot see that. `claimWithdrawal` takes `FOR UPDATE`
   * and then RETURNS — the row lock dies with the claim transaction, so both
   * requests get past the claim and both proceed to hold, rail and settle. What
   * makes that safe is not the unique index alone (both callers find the same
   * row) but the layered idempotency underneath it: the ledger keys on
   * `withdraw.*:<id>:<attempt>` and the rail keys on the same string.
   *
   * These tests exist because that is currently an ARGUMENT, and an argument
   * about whether a user can be debited twice should be a passing test instead.
   */
  describe('double submit — the same key arriving twice at once', () => {
    it('CREDITS ONCE when a webhook is redelivered concurrently', async () => {
      const [a, b] = await Promise.all([deposit({ amount: amt('100') }), deposit({ amount: amt('100') })]);

      expect(b.id).toBe(a.id);
      // 100, not 200. The unique index on (rail, rail_ref) collapses the claim,
      // and the `deposit:<rail>:<railRef>` ledger key collapses the booking.
      expect(await availableOf()).toBe('100');
      expect(await boundaryOf()).toBe('-100');
      expect(await sql`SELECT id FROM pay.deposits`).toHaveLength(1);
    });

    it('DEBITS ONCE when a withdrawal is submitted twice at once', async () => {
      await deposit({ amount: amt('100') });

      const results = await Promise.allSettled([
        withdraw({ amount: amt('40'), clientRef: 'w-race' }),
        withdraw({ amount: amt('40'), clientRef: 'w-race' }),
      ]);

      // Whatever each caller was told, the BOOK is what matters: 40 left once.
      expect(await availableOf()).toBe('60');
      expect(await boundaryOf()).toBe('-60');
      expect(await sql`SELECT id FROM pay.withdrawals`).toHaveLength(1);

      // At least one caller got a definite answer. A pair of failures would mean
      // a client that retried correctly cannot find out what happened.
      expect(results.filter((r) => r.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);

      const record = (await money.listWithdrawals(USER, 50))[0]!;
      expect(record.status).toBe('sent');
      // Nothing left immobilised in either attempt's hold.
      expect(await holdOf(record.id, 0)).toBe('0');
      expect(await holdOf(record.id, 1)).toBe('0');
    });

    it('PAYS THE RAIL ONCE, not twice, when both submissions reach it', async () => {
      // The assertion the ledger cannot make for us. Double-BOOKING is caught by
      // the idempotency key; double-PAYING is caught by nothing on our side —
      // the money has already left. So the rail's own key is inspected directly.
      await deposit({ amount: amt('100') });

      const payoutKeys: string[] = [];
      const spy = new Proxy(card, {
        get(target, prop, receiver) {
          if (prop === 'payout') {
            return async (...args: Parameters<CardSandboxAdapter['payout']>) => {
              payoutKeys.push(args[0]!.settlementId);
              return target.payout(...args);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
      money = new UserMoneyService(sql, ledger, new RailRegistry([spy]), { operatorCreditRails: ['card-sandbox'] });

      await Promise.allSettled([
        withdraw({ amount: amt('40'), clientRef: 'w-race-2' }),
        withdraw({ amount: amt('40'), clientRef: 'w-race-2' }),
      ]);

      // The rail may legitimately be ASKED twice — that is what a retry is. What
      // must be true is that both asks carry the SAME idempotency key, because
      // that key is the only thing between the user and two real payouts.
      expect(new Set(payoutKeys).size).toBe(1);
      expect(await availableOf()).toBe('60');
    });

    /**
     * Two withdraws, one clientRef, both inside the rail before either finishes.
     *
     * A sequential retry is a different story: the second call sees `failed` at
     * claim time and opens the next attempt. That is supposed to pay. This is
     * the overlap where one rail result is a refusal and the other is a send,
     * and the loser must not post the other recipe or rewrite the row.
     *
     * `hold` parks one result after the rail returns and before this service
     * posts, while the other caller is still in `withdraw`. Both promises are
     * in flight together.
     */
    async function overlapWithdraw(holdOk: boolean) {
      await deposit({ amount: amt('100') });
      card.failNext('bank.rejected', 'Beneficiary account closed');

      let arrived = 0;
      let openBoth: () => void = () => undefined;
      const bothInRail = new Promise<void>((resolve) => {
        openBoth = resolve;
      });
      let releaseHeld: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        releaseHeld = resolve;
      });

      const spy = new Proxy(card, {
        get(target, prop, receiver) {
          if (prop === 'payout') {
            return async (...args: Parameters<CardSandboxAdapter['payout']>) => {
              arrived += 1;
              if (arrived === 2) openBoth();
              await bothInRail;
              const result = await target.payout(...args);
              if (result.ok === holdOk) await held;
              return result;
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
      money = new UserMoneyService(sql, ledger, new RailRegistry([spy]), { operatorCreditRails: ['card-sandbox'] });

      const calls = [
        withdraw({ amount: amt('40'), clientRef: 'w-race-relock' }),
        withdraw({ amount: amt('40'), clientRef: 'w-race-relock' }),
      ];
      await Promise.race(calls).then(
        () => undefined,
        () => undefined,
      );
      releaseHeld();
      const results = await Promise.allSettled(calls);
      const record = (await money.listWithdrawals(USER, 50))[0]!;
      return { arrived, results, record };
    }

    it('does not settle an attempt the overlapping call has already reversed', async () => {
      const { arrived, results, record } = await overlapWithdraw(true);

      expect(arrived).toBe(2);
      expect(record.status).toBe('failed');
      expect(record.failureCode).toBe('bank.rejected');
      expect(record.attempts).toBe(1);
      expect(results.every((r) => r.status === 'rejected')).toBe(true);
      for (const result of results) {
        expect(result.status).toBe('rejected');
        if (result.status === 'rejected') expect(result.reason).toMatchObject({ code: 'pay.rail_failed' });
      }

      expect(await ledger.getTxByKey(`withdraw.reverse:${record.id}:0`)).not.toBeNull();
      expect(await ledger.getTxByKey(`withdraw.settle:${record.id}:0`)).toBeNull();
      expect(await ledger.getTxByKey(`withdraw.settle:${record.id}:1`)).toBeNull();
      expect(await availableOf()).toBe('100');
      expect(await boundaryOf()).toBe('-100');
      expect(await holdOf(record.id, 0)).toBe('0');
      expect(await sql`SELECT id FROM pay.withdrawals`).toHaveLength(1);
    });

    it('does not reverse an attempt the overlapping call has already settled', async () => {
      const { arrived, results, record } = await overlapWithdraw(false);

      expect(arrived).toBe(2);
      expect(record.status).toBe('sent');
      expect(record.failureCode).toBeNull();
      expect(record.attempts).toBe(0);
      expect(await ledger.getTxByKey(`withdraw.settle:${record.id}:0`)).not.toBeNull();
      expect(await ledger.getTxByKey(`withdraw.reverse:${record.id}:0`)).toBeNull();
      expect(await availableOf()).toBe('60');
      expect(await boundaryOf()).toBe('-60');
      expect(await holdOf(record.id, 0)).toBe('0');
      expect(await sql`SELECT id FROM pay.withdrawals`).toHaveLength(1);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      expect(fulfilled.length).toBeGreaterThanOrEqual(1);
      for (const result of fulfilled) {
        if (result.status === 'fulfilled') expect(result.value.status).toBe('sent');
      }
      for (const result of results) {
        if (result.status === 'rejected') {
          expect(result.reason).not.toMatchObject({ code: 'pay.rail_failed' });
          expect(String((result.reason as { message?: string }).message ?? '')).not.toMatch(/insufficient/i);
        }
      }
    });

    it('refuses the second submission when the two disagree about the money', async () => {
      await deposit({ amount: amt('100') });

      const results = await Promise.allSettled([
        withdraw({ amount: amt('40'), clientRef: 'w-race-3' }),
        withdraw({ amount: amt('50'), clientRef: 'w-race-3' }),
      ]);

      // Exactly one wins; the other is a conflict, not a second withdrawal. A
      // client reusing a key for different numbers has a bug, and resuming it
      // against the original numbers would send money nobody just asked for.
      const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
      expect(rejected).toHaveLength(1);
      expect(rejected[0]!.reason).toMatchObject({ code: 'pay.withdrawal_conflict' });
      expect(await sql`SELECT id FROM pay.withdrawals`).toHaveLength(1);
    });

    it('keeps two DIFFERENT client references independent under concurrency', async () => {
      // The control for the tests above: idempotency must not have quietly become
      // "one withdrawal at a time per user".
      await deposit({ amount: amt('100') });

      await Promise.all([withdraw({ amount: amt('30'), clientRef: 'w-indep-a' }), withdraw({ amount: amt('20'), clientRef: 'w-indep-b' })]);

      expect(await availableOf()).toBe('50');
      expect(await sql`SELECT id FROM pay.withdrawals`).toHaveLength(2);
    });

    it('does not let two concurrent submissions overdraw the user', async () => {
      // Two DIFFERENT keys, each affordable alone, together more than the user
      // has. The ledger is the only thing that can arbitrate this, which is
      // exactly why the balance is read from it and not from these tables.
      await deposit({ amount: amt('100') });

      const results = await Promise.allSettled([
        withdraw({ amount: amt('80'), clientRef: 'w-over-a' }),
        withdraw({ amount: amt('80'), clientRef: 'w-over-b' }),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      // 100 − 80. Never negative, and never 100 − 160.
      expect(await availableOf()).toBe('20');
      const failed = (await money.listWithdrawals(USER, 50)).find((w) => w.status === 'failed');
      expect(failed?.failureCode).toBe('ledger.insufficient_funds');
    });

    /**
     * THE SANDBOX REFUSAL, on the path a user actually reaches.
     *
     * `rails/posture.test.ts` proves the guard refuses. This proves it refuses
     * BEFORE anything moves — no row, no hold, no rail call. A guard that fired
     * after the hold was posted would immobilise a user's funds for a reason that
     * was knowable before the first write.
     */
    it('REFUSES A SANDBOX RAIL UNDER live-only, before a row or a hold exists', async () => {
      await deposit({ amount: amt('100') });
      money = new UserMoneyService(sql, ledger, rails, {
        operatorCreditRails: ['card-sandbox'],
        valueMovement: 'live-only',
      });

      await expect(withdraw({ amount: amt('40'), clientRef: 'w-sandbox' })).rejects.toMatchObject({ code: 'pay.rail_not_live' });

      // Untouched, and nothing to reconcile.
      expect(await availableOf()).toBe('100');
      expect(await sql`SELECT id FROM pay.withdrawals`).toHaveLength(0);
    });
  });

  // ══ THE ROUND TRIP ═════════════════════════════════════════════════════════

  describe('register → deposit → trade → withdraw, in the book', () => {
    it('conserves value across the whole journey', async () => {
      await deposit({ amount: amt('100'), railRef: 'psp_in' });

      const { recipes } = await import('@intafaced/ledger-client');
      await ledger.post(recipes.orderHold({ orderId: 'ord-9', userId: USER, assetId: 'USDT', amount: amt('30') }));
      await ledger.post(recipes.orderHoldRelease({ orderId: 'ord-9', userId: USER, assetId: 'USDT', amount: amt('30') }));

      await withdraw({ amount: amt('100'), clientRef: 'w-out' });

      // Everything the user had is gone, cleanly, and the boundary is square:
      // 100 came in, 100 went out, and the platform owes nothing.
      expect(await availableOf()).toBe('0');
      expect(await boundaryOf()).toBe('0');
    });
  });
});
