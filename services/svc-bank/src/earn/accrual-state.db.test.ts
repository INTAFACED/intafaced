/**
 * BK-earn-01 (J-bank-08 #3): where a saving stands in the daily accrual. A deposit waits for its first full UTC day,
 * then accrues; a day the bank already paid its owner from the pool counts too. The figure paid for a day is the one
 * the pool page's calculator shows. Enters through the customer router.
 *
 * Postgres (TEST_DATABASE_URL) and a MemoryLedger. Does not start Docker.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, parseAmount as amt, recipes } from '@intafaced/ledger-client';
import { createBankServices, memoryRecipientState, type BankServices } from '../bank-service.js';
import { memoryLedgerHistory } from '../analytics/ledger-history.js';
import { createBankRouter } from '../router.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '../..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const SECRET = 'c'.repeat(32);
const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const PAYER = '59999999-9999-4999-8999-999999999999';
const SAVER_B = '22222222-2222-4222-8222-222222222222';
const SID = '99999999-9999-4999-8999-999999999999';

function principal(userId: string, scopes: string[]): Principal {
  return { sub: userId, userId, sid: SID, scopes, tier: 'full', mfa: true, expiresAt: new Date(Date.now() + 60_000) } as Principal;
}

function caller(bank: BankServices, userId: string, scopes: string[]) {
  const raw = encodePrincipal(principal(userId, scopes));
  const edge = createEdgeContext({ secret: SECRET, serviceName: 'svc-bank' });
  return createBankRouter(bank, {}).createCaller(
    edge({
      headers: {
        'x-intafaced-principal': raw,
        'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
        'x-intafaced-region': 'DE',
      },
      id: `req-${randomUUID()}`,
    }),
  );
}

const DAY = 24 * 60 * 60 * 1000;
const midnight = (at: Date) => new Date(`${at.toISOString().slice(0, 10)}T00:00:00.000Z`);

describe('earn accrual state (BK-earn-01)', () => {
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let ledger: MemoryLedger;

  beforeAll(async () => {
    const raw = process.env.TEST_DATABASE_URL?.trim();
    if (!raw) throw new Error('TEST_DATABASE_URL is unset. This suite does not start Docker.');
    const url = new URL(raw);
    if (url.pathname === '/test') url.pathname = '/intafaced_test';
    db = await createTestDatabase({ service: 'bank', url: url.toString(), migrations });
    sql = db.sql;
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
  });

  beforeEach(async () => {
    await sql`TRUNCATE bank.earn_rate_changes, bank.interest_accruals, bank.earn_positions, bank.earn_pools RESTART IDENTITY CASCADE`;
    ledger = new MemoryLedger();
  });

  function services(): BankServices {
    return createBankServices(sql, ledger, memoryLedgerHistory(ledger), { nativeAssetId: 'IFC', recipients: memoryRecipientState() });
  }
  const saver = (bank: BankServices, userId = CUSTOMER) => caller(bank, userId, ['bank:read', 'bank:write']);

  /** A TEST pool with a funded reserve and TEST balances for both savers. */
  async function pool(bank: BankServices) {
    const created = await bank.earn.createPool({
      assetId: 'USDT',
      kind: 'flexible',
      name: 'TEST accrual',
      aprBps: 3650,
      minDeposit: amt('10'),
    });
    for (const userId of [CUSTOMER, SAVER_B, PAYER]) {
      await ledger.post(recipes.deposit({ userId, assetId: 'USDT', amount: amt('2000'), rail: 'test', railRef: `seed-${userId}` }));
    }
    await ledger.post(
      recipes.feeCharge({ chargeId: 'bank:seed', userId: PAYER, module: 'bank', mode: 'asset', assetId: 'USDT', amount: amt('100') }),
    );
    await bank.earn.fundPool({ poolId: created.id, fundingId: 'seed-1', amount: amt('100') });
    return created;
  }

  it('a deposit under the minimum is refused; one at it waits for its first full UTC day', async () => {
    const bank = services();
    const { id: poolId } = await pool(bank);
    await expect(saver(bank).earn.deposit({ poolId, positionId: randomUUID(), amount: '5' })).rejects.toMatchObject({
      cause: { code: 'bank.below_minimum' },
    });
    expect(await saver(bank).earn.positions({ limit: 10, poolId })).toEqual([]);

    const positionId = randomUUID();
    await saver(bank).earn.deposit({ poolId, positionId, amount: '1000' });
    const [position] = await saver(bank).earn.positions({ limit: 10, poolId });
    expect(position).toMatchObject({ id: positionId, accrual: 'waiting' });
    // Its first day begins at the UTC midnight after it opened, whatever the clock reads by the time it is checked.
    expect(position!.accruesFrom).toBe(new Date(midnight(new Date(position!.openedAt)).getTime() + DAY).toISOString());
  });

  it('accrues once its first day is paid, and that day pays exactly the calculator’s figure', async () => {
    const bank = services();
    const { id: poolId } = await pool(bank);
    await saver(bank).earn.deposit({ poolId, positionId: randomUUID(), amount: '1000' });
    const [opened] = await saver(bank).earn.positions({ limit: 10, poolId });
    // The bank's job pays the saving's first day (a scheduler at that day's hour): 1000 at 36.5% is exactly 1.
    const firstDay = new Date(opened!.accruesFrom);
    expect((await bank.earn.accrue({ poolId, at: new Date(firstDay.getTime() + 60 * 60 * 1000) })).paid).toBe(amt('1'));
    const [position] = await saver(bank).earn.positions({ limit: 10, poolId });
    expect(position!.accrual).toBe('accruing');
    const history = await saver(bank).earn.interestHistory({ poolId, limit: 10 });
    expect(history.days.map((day) => [day.date, day.amount])).toEqual([[opened!.accruesFrom.slice(0, 10), '1']]);
  });

  it('a saving opened before today began accrues by the clock alone', async () => {
    const bank = services();
    const { id: poolId } = await pool(bank);
    const yesterday = new Date(Date.now() - DAY);
    await bank.earn.deposit({ poolId, userId: CUSTOMER, amount: amt('20'), positionId: randomUUID(), now: yesterday });
    const [position] = await saver(bank).earn.positions({ limit: 10 });
    expect(position).toMatchObject({ accrual: 'accruing', accruesFrom: midnight(new Date(yesterday.getTime() + DAY)).toISOString() });
  });

  it('a day paid to someone else, or to the same person before this saving opened, does not start it', async () => {
    const bank = services();
    const { id: poolId } = await pool(bank);
    const older = randomUUID();
    await saver(bank).earn.deposit({ poolId, positionId: older, amount: '1000' });
    await saver(bank, SAVER_B).earn.deposit({ poolId, positionId: randomUUID(), amount: '1000' });
    // Two days ahead is paid to both savers' first savings; this saver opens a second one after that run.
    await bank.earn.accrue({ poolId, at: new Date(Date.now() + 2 * DAY) });
    const newer = randomUUID();
    await saver(bank).earn.deposit({ poolId, positionId: newer, amount: '1000' });
    const mine = await saver(bank).earn.positions({ limit: 10, poolId });
    expect(Object.fromEntries(mine.map((row) => [row.id, row.accrual]))).toEqual({ [older]: 'accruing', [newer]: 'waiting' });
    const [theirs] = await saver(bank, SAVER_B).earn.positions({ limit: 10, poolId });
    expect(theirs!.accrual).toBe('accruing');
  });

  it('a closed pool keeps paying the savings it holds (BK-earn-04), and a saving whose day rounds to nothing says so', async () => {
    const bank = services();
    const { id: poolId } = await pool(bank);
    const dust = await bank.earn.createPool({ assetId: 'USDT', kind: 'flexible', name: 'TEST dust', aprBps: 1, minDeposit: amt('0') });
    await saver(bank).earn.deposit({ poolId: dust.id, positionId: randomUUID(), amount: '0.000000000000000001' });
    await bank.earn.deposit({ poolId, userId: CUSTOMER, amount: amt('20'), positionId: randomUUID(), now: new Date(Date.now() - DAY) });
    expect((await saver(bank).earn.positions({ limit: 10, poolId: dust.id })).map((row) => row.accrual)).toEqual(['below_unit']);
    await sql`UPDATE bank.earn_pools SET status = 'closed' WHERE id = ${poolId}`;
    expect((await saver(bank).earn.positions({ limit: 10, poolId })).map((row) => row.accrual)).toEqual(['accruing']);
    // 20 at 36.5% is 0.02 a day, paid by the closed pool to its one saver.
    expect(await bank.earn.accrue({ poolId, at: new Date() })).toMatchObject({ paid: amt('0.02'), recipients: 1 });
  });
});
