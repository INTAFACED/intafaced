/**
 * The dormancy fee (RC-bank-01, J-bank-16 #7), against Postgres and the in-memory ledger.
 *
 * PG-hard: a missing database fails the suite. CI uses TEST_DATABASE_URL; without it, Testcontainers `postgres:16-alpine`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, houseFees, parseAmount as amt, recipes, userAvailable } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { memoryLedgerHistory } from '../analytics/ledger-history.js';
import { DORMANCY_MODULE, DormancyService, parseDormancyRules } from './dormancy.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine').start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

const RULES = parseDormancyRules(JSON.stringify([{ assetId: 'USDT', fee: '5', inactiveDays: 365, noticeLeadDays: 30, version: 'test-1' }]));
const DAY = 86_400_000;

describe('the dormancy fee (J-bank-16 #7, PG-hard)', () => {
  let stop: () => Promise<void> = async () => undefined;
  let db: TestDatabase;
  let ledger: MemoryLedger;
  let dormancy: DormancyService;
  let user: string;

  beforeAll(async () => {
    const admin = await openAdmin();
    stop = admin.stop;
    db = await createTestDatabase({ service: 'bank', url: admin.url, migrations });
  }, 180_000);
  afterAll(async () => {
    await db?.drop();
    await stop();
  }, 60_000);
  beforeEach(() => {
    ledger = new MemoryLedger();
    dormancy = new DormancyService(db.sql, ledger, memoryLedgerHistory(ledger), RULES);
    user = randomUUID();
  });

  const fund = (amount: string) =>
    ledger.post(recipes.deposit({ userId: user, assetId: 'USDT', amount: amt(amount), rail: 'local-test', railRef: randomUUID() }));
  const balance = async () => (await ledger.balance(userAvailable(user, 'USDT'))).amount;
  const quietUntil = () => new Date(Date.now() + 366 * DAY);
  const debitDay = (at: Date) => new Date(at.getTime() + 30 * DAY).toISOString().slice(0, 10);

  it('notices a quiet account once, naming the fee and the debit date', async () => {
    await fund('20');
    const at = quietUntil();
    expect((await dormancy.run({ at, userIds: [user] })).noticed).toEqual([
      { userId: user, assetId: 'USDT', fee: '5', debitDate: debitDay(at) },
    ]);
    expect((await dormancy.run({ at, userIds: [user] })).noticed).toEqual([]);
    expect(await dormancy.notices(user)).toEqual([expect.objectContaining({ state: 'noticed', fee: '5', debitDate: debitDay(at) })]);
    // Too early for a debit: nothing settles.
    expect((await dormancy.run({ at: new Date(at.getTime() + DAY), userIds: [user] })).settled).toEqual([]);
  });

  it('gives no notice to an account active within the rule, or one that never moved', async () => {
    await fund('20');
    expect((await dormancy.run({ at: new Date(Date.now() + 100 * DAY), userIds: [user] })).noticed).toEqual([]);
    expect((await dormancy.run({ at: quietUntil(), userIds: [randomUUID()] })).noticed).toEqual([]);
  });

  it('takes no fee after a full withdrawal: a zero balance on the debit date is skipped_zero', async () => {
    await fund('20');
    const at = quietUntil();
    await dormancy.run({ at, userIds: [user] });
    await ledger.post(
      recipes.feeCharge({ chargeId: randomUUID(), userId: user, module: 'trade', mode: 'asset', assetId: 'USDT', amount: amt('20') }),
    );
    expect(await balance()).toBe(0n);
    const { settled } = await dormancy.run({ at: new Date(`${debitDay(at)}T00:01:00Z`), userIds: [user] });
    expect(settled).toEqual([{ userId: user, assetId: 'USDT', debitDate: debitDay(at), outcome: 'skipped_zero' }]);
    expect(await balance()).toBe(0n);
    expect((await dormancy.notices(user))[0]).toMatchObject({ state: 'skipped_zero', ledgerTxId: null });
  });

  it('cancels the notice on activity after it, and skips a balance below the fee without part-charging', async () => {
    await fund('20');
    const at = quietUntil();
    await dormancy.run({ at, userIds: [user] });
    await fund('1');
    const { settled } = await dormancy.run({ at: new Date(`${debitDay(at)}T00:01:00Z`), userIds: [user] });
    expect(settled[0]!.outcome).toBe('cancelled');

    const poor = randomUUID();
    await ledger.post(recipes.deposit({ userId: poor, assetId: 'USDT', amount: amt('3'), rail: 'local-test', railRef: randomUUID() }));
    await dormancy.run({ at, userIds: [poor] });
    const later = await dormancy.run({ at: new Date(`${debitDay(at)}T00:01:00Z`), userIds: [poor] });
    expect(later.settled[0]!.outcome).toBe('skipped_insufficient');
    expect((await ledger.balance(userAvailable(poor, 'USDT'))).amount).toBe(amt('3'));
  });

  it('charges the noticed fee once through feeCharge, and a replay charges nothing more', async () => {
    await fund('20');
    const at = quietUntil();
    await dormancy.run({ at, userIds: [user] });
    const due = new Date(`${debitDay(at)}T00:01:00Z`);
    expect((await dormancy.run({ at: due, userIds: [user] })).settled[0]!.outcome).toBe('charged');
    expect((await dormancy.run({ at: due, userIds: [user] })).settled).toEqual([]);
    expect(await balance()).toBe(amt('15'));
    expect((await ledger.balance(houseFees(DORMANCY_MODULE, 'USDT'))).amount).toBe(amt('5'));
    const [notice] = await dormancy.notices(user);
    expect(notice).toMatchObject({ state: 'charged' });
    expect(ledger.journal().find((tx) => tx.id === notice!.ledgerTxId)?.idempotencyKey).toBe(
      `fee:${DORMANCY_MODULE}:${user}:USDT:${debitDay(at)}`,
    );
  });

  it('refuses bank.dormancy_rule_unset with no rule, and reads a rule not in shape as none', async () => {
    const none = new DormancyService(db.sql, ledger, memoryLedgerHistory(ledger), parseDormancyRules(undefined));
    await expect(none.run({ at: quietUntil(), userIds: [user] })).rejects.toMatchObject({ code: 'bank.dormancy_rule_unset' });
    expect(
      parseDormancyRules(JSON.stringify([{ assetId: 'USDT', fee: 5, inactiveDays: 365, noticeLeadDays: 30, version: 'x' }])),
    ).toBeNull();
    expect(
      parseDormancyRules(JSON.stringify([{ assetId: 'USDT', fee: '0', inactiveDays: 365, noticeLeadDays: 30, version: 'x' }])),
    ).toBeNull();
  });
});
