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
import { WITHDRAWAL_DROPPED_CODE } from './status.js';

/** Returning a held withdrawal after its chain transaction was dropped, against a real Postgres and the reference ledger. TEST figures only. */
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
    .withDatabase('intafaced_withdrawal_reverse_dropped_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

const SECRET = 'svc-pay-withdrawal-reverse-dropped-secret-32';
const USER = '11111111-1111-4111-8111-111111111111';
const OPERATOR = '99999999-9999-4999-8999-999999999999';
const DESTINATION = { kind: 'bank', ref: 'DE89370400440532013000' };

describe('reverse a dropped withdrawal (real Postgres)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db!: TestDatabase;
  let ledger: MemoryLedger;
  let money: UserMoneyService;
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
    rails = new RailRegistry([new CardSandboxAdapter({ secret: SECRET, toleranceSeconds: 300 })]);
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
  const reversed = async (id: string, attempt: number) => (await ledger.getTxByKey(`withdraw.reverse:${id}:${attempt}`)) !== null;

  async function row(status: string, attempts = 0): Promise<string> {
    const [r] = await db.sql<Array<{ id: string }>>`
      INSERT INTO pay.withdrawals (user_id, asset_id, amount, rail, destination, client_ref, rail_ref, status, attempts)
      VALUES (${USER}, 'USDT', 40, 'card-sandbox', ${db.sql.json(DESTINATION)}, ${`w-${Math.random()}`},
              ${status === 'sent' ? 'rail-1' : null}, ${status}::pay.withdrawal_status, ${attempts})
      RETURNING id`;
    return r!.id;
  }
  const hold = (id: string, attempt = 0) =>
    ledger.post(
      recipes.withdrawHold({ userId: USER, assetId: 'USDT', amount: amt('40'), rail: 'card-sandbox', withdrawalId: `${id}:${attempt}` }),
    );

  it('returns the hold once under the attempt key; the row reads failed with the dropped code; a repeat changes nothing', async () => {
    const id = await row('held', 2);
    await hold(id, 2);
    expect(await availableOf()).toBe('60');

    const out = await money.reverseDroppedWithdrawal({ withdrawalId: id });
    const again = await money.reverseDroppedWithdrawal({ withdrawalId: id });

    expect(out).toMatchObject({ status: 'failed', failureCode: WITHDRAWAL_DROPPED_CODE, attempts: 3 });
    expect(again).toMatchObject({ status: 'failed', failureCode: WITHDRAWAL_DROPPED_CODE });
    expect(await availableOf()).toBe('100');
    expect(await holdOf(id, 2)).toBe('0');
    expect(await reversed(id, 2)).toBe(true);
    const [stored] = await db.sql<
      Array<{ status: string; attempts: number }>
    >`SELECT status::text, attempts FROM pay.withdrawals WHERE id = ${id}`;
    expect(stored).toEqual({ status: 'failed', attempts: 3 });
  });

  it('a crash after the reverse and before the row update is finished by the repeat, with one reverse', async () => {
    const id = await row('held');
    await hold(id);
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
    await expect(crashing.reverseDroppedWithdrawal({ withdrawalId: id })).rejects.toMatchObject({ code: 'pay.ledger_outcome_unknown' });
    const [mid] = await db.sql<Array<{ status: string }>>`SELECT status::text FROM pay.withdrawals WHERE id = ${id}`;
    expect(mid!.status).toBe('held');
    expect(await availableOf()).toBe('100');

    const done = await money.reverseDroppedWithdrawal({ withdrawalId: id });
    expect(done.failureCode).toBe(WITHDRAWAL_DROPPED_CODE);
    expect(await availableOf()).toBe('100');
    expect(await holdOf(id, 0)).toBe('0');
  });

  it('refuses a pending, sent or failed row and a held row with no hold on the ledger, and posts nothing', async () => {
    await money.credit({
      userId: USER,
      assetId: 'USDT',
      amount: amt('100'),
      rail: 'card-sandbox',
      railRef: 'psp_ref_2',
      creditedBy: OPERATOR,
    });
    for (const status of ['pending', 'sent', 'failed']) {
      const id = await row(status);
      await hold(id); // even with a hold on the ledger, only a held row is reversed
      await expect(money.reverseDroppedWithdrawal({ withdrawalId: id })).rejects.toMatchObject({ code: 'pay.withdrawal_not_reversible' });
      expect(await reversed(id, 0)).toBe(false);
    }
    const noHold = await row('held');
    await expect(money.reverseDroppedWithdrawal({ withdrawalId: noHold })).rejects.toMatchObject({ code: 'pay.withdrawal_not_reversible' });
    expect(await reversed(noHold, 0)).toBe(false);
    await expect(money.reverseDroppedWithdrawal({ withdrawalId: '00000000-0000-4000-8000-000000000000' })).rejects.toMatchObject({
      code: 'pay.withdrawal_not_found',
    });
  });

  it('an unreadable ledger leaves the row held', async () => {
    const id = await row('held');
    await hold(id);
    const blind = new Proxy(ledger, {
      get(target, prop) {
        if (prop === 'getTxByKey') return async () => Promise.reject(new Error('ledger down'));
        const value = Reflect.get(target, prop) as unknown;
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    }) as LedgerClient;
    const svc = new UserMoneyService(db.sql, blind, rails, { operatorCreditRails: ['card-sandbox'] });
    await expect(svc.reverseDroppedWithdrawal({ withdrawalId: id })).rejects.toMatchObject({ code: 'pay.ledger_outcome_unknown' });
    const [r] = await db.sql<Array<{ status: string }>>`SELECT status::text FROM pay.withdrawals WHERE id = ${id}`;
    expect(r!.status).toBe('held');
    expect(await availableOf()).toBe('60');
  });
});
