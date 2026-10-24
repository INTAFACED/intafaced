import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import {
  MemoryLedger,
  formatAmount,
  parseAmount as amt,
  recipes,
  userAvailable,
  withdrawalHoldAccount,
  type LedgerClient,
} from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CardSandboxAdapter } from '../rails/card-sandbox.js';
import { RailRegistry } from '../rails/registry.js';
import { UserMoneyService } from '../user-money-service.js';
import { createWithdrawalHistory } from './history.js';
import { isCancellable, WITHDRAWAL_CANCELED_CODE } from './status.js';

/** Cancelling a withdrawal against a real Postgres and the reference ledger. TEST figures only. */
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_withdrawal_cancel_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

const SECRET = 'svc-pay-withdrawal-cancel-secret-at-least-32';
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const OPERATOR = '99999999-9999-4999-8999-999999999999';
const DESTINATION = { kind: 'bank', ref: 'DE89370400440532013000' };

describe('cancel a withdrawal (real Postgres)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db!: TestDatabase;
  let ledger: MemoryLedger;
  let money: UserMoneyService;
  let card: CardSandboxAdapter;
  let rails: RailRegistry;

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
    await db.sql`TRUNCATE pay.withdrawals, pay.deposits RESTART IDENTITY CASCADE`;
    ledger = new MemoryLedger();
    card = new CardSandboxAdapter({ secret: SECRET, toleranceSeconds: 300 });
    rails = new RailRegistry([card]);
    money = new UserMoneyService(db.sql, ledger, rails, { operatorCreditRails: ['card-sandbox'] });
    await money.credit({
      userId: USER,
      assetId: 'USDT',
      amount: amt('100'),
      rail: 'card-sandbox',
      railRef: 'psp_ref_1',
      creditedBy: OPERATOR,
    });
  });

  const availableOf = async () => formatAmount((await ledger.balance(userAvailable(USER, 'USDT'))).amount);
  const holdOf = async (id: string, attempt: number) =>
    formatAmount((await ledger.balance(withdrawalHoldAccount(USER, 'USDT', `${id}:${attempt}`))).amount);
  const reverseTxs = async (id: string, attempt: number) => (await ledger.getTxByKey(`withdraw.reverse:${id}:${attempt}`)) !== null;

  async function row(
    status: string,
    o: { clientRef?: string; userId?: string; attempts?: number; railRef?: string } = {},
  ): Promise<string> {
    const [r] = await db.sql<Array<{ id: string }>>`
      INSERT INTO pay.withdrawals (user_id, asset_id, amount, rail, destination, client_ref, rail_ref, status, attempts)
      VALUES (${o.userId ?? USER}, 'USDT', 40, 'card-sandbox', ${db.sql.json(DESTINATION)}, ${o.clientRef ?? 'w-1'},
              ${status === 'sent' ? (o.railRef ?? 'rail-1') : null}, ${status}::pay.withdrawal_status, ${o.attempts ?? 0})
      RETURNING id`;
    return r!.id;
  }

  const holdFor = (id: string, attempt = 0) =>
    ledger.post(
      recipes.withdrawHold({ userId: USER, assetId: 'USDT', amount: amt('40'), rail: 'card-sandbox', withdrawalId: `${id}:${attempt}` }),
    );

  it('a pending withdrawal with no hold is cancelled and posts nothing', async () => {
    const id = await row('pending');
    const before = await availableOf();

    const out = await money.cancelWithdrawal({ userId: USER, withdrawalId: id });

    expect(out.status).toBe('failed');
    expect(out.failureCode).toBe(WITHDRAWAL_CANCELED_CODE);
    expect(await availableOf()).toBe(before);
    expect(await reverseTxs(id, 0)).toBe(false);
  });

  it('a pending withdrawal whose hold was booked before a crash is reversed once, and twice is still once', async () => {
    const id = await row('pending');
    await holdFor(id);
    expect(await availableOf()).toBe('60');
    expect(await holdOf(id, 0)).toBe('40');

    await money.cancelWithdrawal({ userId: USER, withdrawalId: id });
    const again = await money.cancelWithdrawal({ userId: USER, withdrawalId: id });

    expect(again.failureCode).toBe(WITHDRAWAL_CANCELED_CODE);
    expect(await availableOf()).toBe('100');
    expect(await holdOf(id, 0)).toBe('0');
    expect(await reverseTxs(id, 0)).toBe(true);
  });

  it('a crash after the reverse and before the row update is finished by the repeat, with one reverse', async () => {
    const id = await row('pending');
    await holdFor(id);
    await ledger.post(
      recipes.withdrawReverse({ userId: USER, assetId: 'USDT', amount: amt('40'), rail: 'card-sandbox', withdrawalId: `${id}:0` }),
    );
    expect(await availableOf()).toBe('100');

    const out = await money.cancelWithdrawal({ userId: USER, withdrawalId: id });

    expect(out.failureCode).toBe(WITHDRAWAL_CANCELED_CODE);
    expect(await availableOf()).toBe('100');
    expect(await holdOf(id, 0)).toBe('0');
  });

  it('a crash after the reverse and before the row update never lets a retry send the returned funds', async () => {
    const id = await row('pending', { clientRef: 'w-crash' });
    await holdFor(id);
    // The ledger commits the reverse, then the caller dies before it hears back.
    const dying = new Proxy(ledger, {
      get(target, prop) {
        if (prop === 'post') {
          return async (req: Parameters<LedgerClient['post']>[0]) => {
            const out = await target.post(req);
            if (req.idempotencyKey.startsWith('withdraw.reverse:')) throw new Error('process died');
            return out;
          };
        }
        const value = Reflect.get(target, prop) as unknown;
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    }) as LedgerClient;
    const crashing = new UserMoneyService(db.sql, dying, rails, { operatorCreditRails: ['card-sandbox'] });
    await expect(crashing.cancelWithdrawal({ userId: USER, withdrawalId: id })).rejects.toBeDefined();
    expect(await availableOf()).toBe('100');
    const [mid] = await db.sql<
      Array<{ status: string; failure_code: string | null }>
    >`SELECT status::text, failure_code FROM pay.withdrawals WHERE id = ${id}`;
    expect(mid).toEqual({ status: 'pending', failure_code: WITHDRAWAL_CANCELED_CODE });

    // The client retries the send with the same reference: refused, nothing leaves, nothing is held again.
    await expect(
      money.withdraw({
        userId: USER,
        assetId: 'USDT',
        amount: amt('40'),
        rail: 'card-sandbox',
        destination: DESTINATION,
        clientRef: 'w-crash',
      }),
    ).rejects.toMatchObject({ code: 'pay.withdrawal_canceled' });
    expect(await availableOf()).toBe('100');
    expect(await holdOf(id, 0)).toBe('0');
    const [attempts] = await db.sql<
      Array<{ n: string }>
    >`SELECT count(*)::text AS n FROM pay.withdrawal_rail_attempts WHERE withdrawal_id = ${id}`;
    expect(attempts!.n).toBe('0');

    // A repeat of the cancel finishes it, with the one reverse.
    const done = await money.cancelWithdrawal({ userId: USER, withdrawalId: id });
    expect(done).toMatchObject({ status: 'failed', failureCode: WITHDRAWAL_CANCELED_CODE });
    expect(await availableOf()).toBe('100');
    expect(await reverseTxs(id, 0)).toBe(true);
  });

  it('a held withdrawal stays held with its funds in the hold', async () => {
    const id = await row('held');
    await holdFor(id);

    await expect(money.cancelWithdrawal({ userId: USER, withdrawalId: id })).rejects.toMatchObject({
      code: 'pay.withdrawal_not_cancellable',
    });

    expect(await holdOf(id, 0)).toBe('40');
    expect(await availableOf()).toBe('60');
    const [after] = await db.sql<Array<{ status: string }>>`SELECT status::text FROM pay.withdrawals WHERE id = ${id}`;
    expect(after!.status).toBe('held');
  });

  it('a sent withdrawal is refused and nothing moves', async () => {
    const id = await row('sent');
    await expect(money.cancelWithdrawal({ userId: USER, withdrawalId: id })).rejects.toMatchObject({
      code: 'pay.withdrawal_not_cancellable',
    });
    expect(await availableOf()).toBe('100');
  });

  it('a failed withdrawal (hold already reversed) is refused, not marked cancelled', async () => {
    const id = await row('failed');
    await db.sql`UPDATE pay.withdrawals SET failure_code = 'rail.refused' WHERE id = ${id}`;
    await expect(money.cancelWithdrawal({ userId: USER, withdrawalId: id })).rejects.toMatchObject({
      code: 'pay.withdrawal_not_cancellable',
    });
    const [after] = await db.sql<Array<{ failure_code: string }>>`SELECT failure_code FROM pay.withdrawals WHERE id = ${id}`;
    expect(after!.failure_code).toBe('rail.refused');
  });

  it('a pending row with a send attempt on record is refused (dispatch unknown)', async () => {
    const id = await row('pending');
    await db.sql`INSERT INTO pay.withdrawal_rail_attempts(withdrawal_id, attempt, outcome) VALUES (${id}, 0, 'requested')`;
    await expect(money.cancelWithdrawal({ userId: USER, withdrawalId: id })).rejects.toMatchObject({
      code: 'pay.withdrawal_not_cancellable',
    });
  });

  it("another account's id and an unknown id are both not found", async () => {
    const mine = await row('pending');
    await expect(money.cancelWithdrawal({ userId: OTHER, withdrawalId: mine })).rejects.toMatchObject({ code: 'pay.withdrawal_not_found' });
    await expect(money.cancelWithdrawal({ userId: USER, withdrawalId: '33333333-3333-4333-8333-333333333333' })).rejects.toMatchObject({
      code: 'pay.withdrawal_not_found',
    });
    const [after] = await db.sql<Array<{ status: string }>>`SELECT status::text FROM pay.withdrawals WHERE id = ${mine}`;
    expect(after!.status).toBe('pending');
  });

  it('a ledger that cannot be read leaves the withdrawal pending', async () => {
    const id = await row('pending');
    const blind = new Proxy(ledger, {
      get(target, prop) {
        if (prop === 'getTxByKey') return () => Promise.reject(new Error('ledger unreachable'));
        const value = Reflect.get(target, prop) as unknown;
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    }) as LedgerClient;
    const service = new UserMoneyService(db.sql, blind, rails, { operatorCreditRails: ['card-sandbox'] });

    await expect(service.cancelWithdrawal({ userId: USER, withdrawalId: id })).rejects.toMatchObject({
      code: 'pay.ledger_outcome_unknown',
    });

    const [after] = await db.sql<Array<{ status: string }>>`SELECT status::text FROM pay.withdrawals WHERE id = ${id}`;
    expect(after!.status).toBe('pending');
  });

  it('the same client reference never reopens a cancelled withdrawal, and a new one is a new withdrawal', async () => {
    const id = await row('pending', { clientRef: 'w-cancel' });
    await money.cancelWithdrawal({ userId: USER, withdrawalId: id });

    await expect(
      money.withdraw({
        userId: USER,
        assetId: 'USDT',
        amount: amt('40'),
        rail: 'card-sandbox',
        destination: DESTINATION,
        clientRef: 'w-cancel',
      }),
    ).rejects.toMatchObject({ code: 'pay.withdrawal_canceled' });
    expect(await availableOf()).toBe('100');

    const fresh = await money.withdraw({
      userId: USER,
      assetId: 'USDT',
      amount: amt('40'),
      rail: 'card-sandbox',
      destination: DESTINATION,
      clientRef: 'w-new',
    });
    expect(fresh.status).toBe('sent');
  });

  it('history shows it as canceled, not failed, and the filters split them', async () => {
    const cancelled = await row('pending', { clientRef: 'a' });
    const failed = await row('failed', { clientRef: 'b' });
    await db.sql`UPDATE pay.withdrawals SET failure_code = 'rail.refused' WHERE id = ${failed}`;
    await money.cancelWithdrawal({ userId: USER, withdrawalId: cancelled });
    const history = createWithdrawalHistory(db.sql);

    const all = await history.search(USER, { limit: 10 });
    const byId = new Map(all.items.map((i) => [i.id, i]));
    expect(byId.get(cancelled)!.status).toBe('canceled');
    expect(byId.get(cancelled)!.failure).toBeNull();
    expect(byId.get(failed)!.status).toBe('failed');

    expect((await history.search(USER, { limit: 10, status: 'canceled' })).items.map((i) => i.id)).toEqual([cancelled]);
    expect((await history.search(USER, { limit: 10, status: 'failed' })).items.map((i) => i.id)).toEqual([failed]);
  });

  // ── W-withdraw-07: a held withdrawal, judged by its dispatch journal ──

  /** A held row as `withdraw` leaves it: marked journalled, its hold booked, and optionally a journal row for its attempt. */
  async function heldRow(journal: 'requested' | 'accepted' | null, o: { clientRef?: string; hold?: boolean } = {}): Promise<string> {
    const id = await row('held', { clientRef: o.clientRef ?? 'w-held' });
    await db.sql`UPDATE pay.withdrawals SET dispatch_journaled = true WHERE id = ${id}`;
    if (o.hold !== false) await holdFor(id);
    if (journal) {
      await db.sql`
        INSERT INTO pay.withdrawal_rail_attempts (withdrawal_id, attempt, outcome, rail_ref)
        VALUES (${id}, 0, ${journal}, ${journal === 'accepted' ? 'rail-tx-1' : null})`;
    }
    return id;
  }
  const statusOf = async (id: string) =>
    (
      await db.sql<Array<{ status: string; failure_code: string | null }>>`
      SELECT status::text, failure_code FROM pay.withdrawals WHERE id = ${id}`
    )[0];

  it('a held withdrawal the journal proves was never sent is cancelled: the hold goes back once, and twice is still once', async () => {
    const id = await heldRow(null);
    expect(await availableOf()).toBe('60');

    const first = await money.cancelWithdrawal({ userId: USER, withdrawalId: id });
    const again = await money.cancelWithdrawal({ userId: USER, withdrawalId: id });

    expect(first).toMatchObject({ status: 'failed', failureCode: WITHDRAWAL_CANCELED_CODE, holdReleased: true });
    expect(again).toMatchObject({ status: 'failed', failureCode: WITHDRAWAL_CANCELED_CODE, holdReleased: true });
    expect(await availableOf()).toBe('100');
    expect(await holdOf(id, 0)).toBe('0');
    expect(await reverseTxs(id, 0)).toBe(true);
    expect(await statusOf(id)).toEqual({ status: 'failed', failure_code: WITHDRAWAL_CANCELED_CODE });
  });

  it('a requested withdrawal with no hold says nothing went back', async () => {
    const id = await row('pending');
    const out = await money.cancelWithdrawal({ userId: USER, withdrawalId: id });
    expect(out.holdReleased).toBe(false);
    expect((await money.cancelWithdrawal({ userId: USER, withdrawalId: id })).holdReleased).toBe(false);
  });

  it('a send whose reply was lost is refused and stays held with its funds in the hold', async () => {
    const id = await heldRow('requested');

    await expect(money.cancelWithdrawal({ userId: USER, withdrawalId: id })).rejects.toMatchObject({
      code: 'pay.withdrawal_not_cancellable',
      detail: { state: 'dispatching' },
    });

    expect(await statusOf(id)).toEqual({ status: 'held', failure_code: null });
    expect(await holdOf(id, 0)).toBe('40');
    expect(await availableOf()).toBe('60');
    expect(await reverseTxs(id, 0)).toBe(false);
  });

  it('a broadcast withdrawal is refused as broadcast and nothing moves', async () => {
    const id = await heldRow('accepted');

    await expect(money.cancelWithdrawal({ userId: USER, withdrawalId: id })).rejects.toMatchObject({
      code: 'pay.withdrawal_not_cancellable',
      detail: { state: 'broadcast' },
    });

    expect(await statusOf(id)).toEqual({ status: 'held', failure_code: null });
    expect(await holdOf(id, 0)).toBe('40');
    expect(await reverseTxs(id, 0)).toBe(false);
  });

  it('a held row with no hold on the ledger is refused, and nothing is credited', async () => {
    const id = await heldRow(null, { hold: false });

    await expect(money.cancelWithdrawal({ userId: USER, withdrawalId: id })).rejects.toMatchObject({
      code: 'pay.withdrawal_not_cancellable',
    });

    expect(await availableOf()).toBe('100');
    expect(await reverseTxs(id, 0)).toBe(false);
    expect(await statusOf(id)).toEqual({ status: 'held', failure_code: null });
  });

  it('a cancel of a held row that stopped after its intent is finished by the repeat, with one reverse, and a send never resumes it', async () => {
    const id = await heldRow(null, { clientRef: 'w-held-crash' });
    const dying = new Proxy(ledger, {
      get(target, prop) {
        if (prop === 'post') {
          return async (req: Parameters<LedgerClient['post']>[0]) => {
            const out = await target.post(req);
            if (req.idempotencyKey.startsWith('withdraw.reverse:')) throw new Error('process died');
            return out;
          };
        }
        const value = Reflect.get(target, prop) as unknown;
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    }) as LedgerClient;
    const crashing = new UserMoneyService(db.sql, dying, rails, { operatorCreditRails: ['card-sandbox'] });
    await expect(crashing.cancelWithdrawal({ userId: USER, withdrawalId: id })).rejects.toMatchObject({
      code: 'pay.ledger_outcome_unknown',
    });
    expect(await statusOf(id)).toEqual({ status: 'held', failure_code: WITHDRAWAL_CANCELED_CODE });

    await expect(
      money.withdraw({
        userId: USER,
        assetId: 'USDT',
        amount: amt('40'),
        rail: 'card-sandbox',
        destination: DESTINATION,
        clientRef: 'w-held-crash',
      }),
    ).rejects.toMatchObject({ code: 'pay.withdrawal_canceled' });
    const [attempts] = await db.sql<Array<{ n: string }>>`
      SELECT count(*)::text AS n FROM pay.withdrawal_rail_attempts WHERE withdrawal_id = ${id}`;
    expect(attempts!.n).toBe('0');

    const done = await money.cancelWithdrawal({ userId: USER, withdrawalId: id });
    expect(done).toMatchObject({ status: 'failed', failureCode: WITHDRAWAL_CANCELED_CODE, holdReleased: true });
    expect(await availableOf()).toBe('100');
    expect(await holdOf(id, 0)).toBe('0');
  });

  it('a cancel racing a send on the same reference: the lock decides, and the loser is refused', async () => {
    const id = await heldRow(null, { clientRef: 'w-race' });
    const [a, b] = await Promise.allSettled([
      money.cancelWithdrawal({ userId: USER, withdrawalId: id }),
      money.withdraw({
        userId: USER,
        assetId: 'USDT',
        amount: amt('40'),
        rail: 'card-sandbox',
        destination: DESTINATION,
        clientRef: 'w-race',
      }),
    ]);
    const after = await statusOf(id);
    if (a.status === 'fulfilled') {
      // The cancel won: the send is refused and the funds are back once.
      expect(b).toMatchObject({ status: 'rejected', reason: { code: 'pay.withdrawal_canceled' } });
      expect(after).toEqual({ status: 'failed', failure_code: WITHDRAWAL_CANCELED_CODE });
      expect(await availableOf()).toBe('100');
    } else {
      // The send won: it was sent, and the cancel was refused.
      expect(a.reason).toMatchObject({ code: 'pay.withdrawal_not_cancellable' });
      expect(after!.status).toBe('sent');
      expect(await availableOf()).toBe('60');
    }
    expect(await holdOf(id, 0)).toBe('0');
  });

  it('withdraw marks the move into held as journalled, and the reads carry the journal', async () => {
    const sent = await money.withdraw({
      userId: USER,
      assetId: 'USDT',
      amount: amt('40'),
      rail: 'card-sandbox',
      destination: DESTINATION,
      clientRef: 'w-marked',
    });
    const [marked] = await db.sql<Array<{ dispatch_journaled: boolean | null }>>`
      SELECT dispatch_journaled FROM pay.withdrawals WHERE id = ${sent.id}`;
    expect(marked!.dispatch_journaled).toBe(true);
    expect(await money.getWithdrawal(sent.id)).toMatchObject({ status: 'sent', journal: 'accepted', dispatchJournaled: true });

    const held = await heldRow('requested', { clientRef: 'w-read' });
    const legacy = await row('held', { clientRef: 'w-legacy' });
    const listed = new Map((await money.listWithdrawals(USER, 10)).map((w) => [w.id, w]));
    expect(listed.get(held)).toMatchObject({ journal: 'requested', dispatchJournaled: true });
    expect(listed.get(legacy)).toMatchObject({ journal: null, dispatchJournaled: null });
  });

  it('a held row carrying a refusal code is refused like the page says, and its hold stays', async () => {
    const id = await heldRow(null, { clientRef: 'w-held-refused' });
    await db.sql`UPDATE pay.withdrawals SET failure_code = 'rail.refused' WHERE id = ${id}`;
    const [read] = (await money.listWithdrawals(USER, 10)).filter((w) => w.id === id);
    expect(isCancellable(read!.status, read!.failureCode, read!.journal, read!.dispatchJournaled)).toBe(false);

    await expect(money.cancelWithdrawal({ userId: USER, withdrawalId: id })).rejects.toMatchObject({
      code: 'pay.withdrawal_not_cancellable',
    });
    expect(await holdOf(id, 0)).toBe('40');
    expect(await reverseTxs(id, 0)).toBe(false);
  });
});
