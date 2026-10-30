/**
 * BK-earn-03 (J-bank-08 #4, #5): a fixed-term saving's lock date, auto-renew and the renewal job, and the payout
 * schedule. A renewal is one (saving, term) row and a later maturity, and moves no money; a run that fires twice
 * renews once. Enters through the customer router and the ops job.
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
import { createBankServices, memoryRecipientState, RecipientStateUnavailableError, type BankServices } from '../bank-service.js';
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

function caller(bank: BankServices, userId: string, scopes: string[], service?: 'svc-bank') {
  const raw = encodePrincipal(principal(userId, scopes));
  const edge = createEdgeContext({ secret: SECRET, serviceName: 'svc-bank' });
  const ctx = edge({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: `req-${randomUUID()}`,
  });
  // The ops jobs answer only the bank's own scheduler, signed as svc-bank.
  return createBankRouter(bank, {}).createCaller(service ? { ...ctx, service } : ctx);
}

const DAY = 24 * 60 * 60 * 1000;

const day = (at: Date) => at.toISOString().slice(0, 10);
const TERM_DAYS = 30;

describe('fixed-term auto-renew and the payout schedule (BK-earn-03)', () => {
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let ledger: MemoryLedger;
  let accounts: ReturnType<typeof memoryRecipientState>;

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
    await sql`TRUNCATE bank.earn_renewals, bank.earn_rate_changes, bank.interest_accruals, bank.earn_positions, bank.earn_pools RESTART IDENTITY CASCADE`;
    ledger = new MemoryLedger();
    accounts = memoryRecipientState();
  });

  function services(wired = true): BankServices {
    return createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      nativeAssetId: 'IFC',
      ...(wired ? { recipients: accounts } : {}),
    });
  }
  const saver = (bank: BankServices, userId = CUSTOMER) => caller(bank, userId, ['bank:read', 'bank:write']);

  /** A TEST fixed-term pool and a TEST flexible one, the flexible reserve funded, and TEST balances for both savers. */
  async function pools(bank: BankServices) {
    const fixed = await bank.earn.createPool({
      assetId: 'USDT',
      kind: 'fixed',
      name: 'TEST 30 days',
      aprBps: 3650,
      termDays: TERM_DAYS,
      minDeposit: amt('10'),
    });
    const flexible = await bank.earn.createPool({
      assetId: 'USDT',
      kind: 'flexible',
      name: 'TEST flexible',
      aprBps: 3650,
      minDeposit: amt('10'),
    });
    for (const userId of [CUSTOMER, SAVER_B, PAYER]) {
      await ledger.post(recipes.deposit({ userId, assetId: 'USDT', amount: amt('2000'), rail: 'test', railRef: `seed-${userId}` }));
    }
    await ledger.post(
      recipes.feeCharge({ chargeId: 'bank:seed', userId: PAYER, module: 'bank', mode: 'asset', assetId: 'USDT', amount: amt('100') }),
    );
    await bank.earn.fundPool({ poolId: flexible.id, fundingId: 'seed-1', amount: amt('100') });
    return { fixed, flexible };
  }

  async function fixedSaving(bank: BankServices, poolId: string, userId = CUSTOMER, positionId: string = randomUUID()) {
    const opened = await saver(bank, userId).earn.deposit({ poolId, positionId, amount: '1000' });
    return { positionId, maturesAt: new Date(opened.maturesAt!) };
  }

  const ops = (bank: BankServices) => caller(bank, PAYER, ['admin:treasury'], 'svc-bank');

  it('a fixed-term saving shows its lock date, refuses an early take back with the date, and takes auto-renew', async () => {
    const bank = services();
    const { fixed } = await pools(bank);
    const { positionId, maturesAt } = await fixedSaving(bank, fixed.id);
    const [opened] = await saver(bank).earn.positions({ limit: 10, poolId: fixed.id });
    expect(opened).toMatchObject({ id: positionId, maturesAt: maturesAt.toISOString(), autoRenew: false, renewals: 0 });
    expect(maturesAt.getTime() - new Date(opened!.openedAt).getTime()).toBe(TERM_DAYS * DAY);
    await expect(saver(bank).earn.withdraw({ positionId })).rejects.toMatchObject({
      cause: { code: 'bank.position_locked', message: expect.stringContaining(maturesAt.toISOString()) },
    });
    expect(await saver(bank).earn.setAutoRenew({ positionId, on: true })).toEqual({
      positionId,
      autoRenew: true,
      maturesAt: maturesAt.toISOString(),
    });
    // The same choice again changes nothing.
    expect(await saver(bank).earn.setAutoRenew({ positionId, on: true })).toMatchObject({ autoRenew: true });
    const [renewing] = await saver(bank).earn.positions({ limit: 10, poolId: fixed.id });
    expect(renewing).toMatchObject({ autoRenew: true, renewals: 0, maturesAt: maturesAt.toISOString() });
  });

  it('refuses auto-renew on a flexible saving, on someone else’s, on a closed pool and after the term; off is always allowed', async () => {
    const bank = services();
    const { fixed, flexible } = await pools(bank);
    const flexibleId = randomUUID();
    await saver(bank).earn.deposit({ poolId: flexible.id, positionId: flexibleId, amount: '100' });
    await expect(saver(bank).earn.setAutoRenew({ positionId: flexibleId, on: true })).rejects.toMatchObject({
      cause: { code: 'bank.auto_renew_fixed_only' },
    });
    const { positionId } = await fixedSaving(bank, fixed.id);
    await expect(saver(bank, SAVER_B).earn.setAutoRenew({ positionId, on: true })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await sql`UPDATE bank.earn_pools SET status = 'closed' WHERE id = ${fixed.id}`;
    await expect(saver(bank).earn.setAutoRenew({ positionId, on: true })).rejects.toMatchObject({ cause: { code: 'bank.pool_closed' } });
    expect(await saver(bank).earn.setAutoRenew({ positionId, on: false })).toMatchObject({ autoRenew: false });
    await sql`UPDATE bank.earn_pools SET status = 'open' WHERE id = ${fixed.id}`;
    // A term that is over takes back or saves again; it does not start a new one now.
    await sql`UPDATE bank.earn_positions SET opened_at = now() - interval '31 days', matures_at = now() - interval '1 day' WHERE id = ${positionId}`;
    await expect(saver(bank).earn.setAutoRenew({ positionId, on: true })).rejects.toMatchObject({
      cause: { code: 'bank.position_matured' },
    });
    expect((await sql`SELECT auto_renew FROM bank.earn_positions WHERE id = ${positionId}`)[0]).toEqual({ auto_renew: false });
  });

  it('at the term’s end the job starts one new term of the same length and amount, moves no money, and a second run renews nothing', async () => {
    const bank = services();
    const { fixed } = await pools(bank);
    const { positionId, maturesAt } = await fixedSaving(bank, fixed.id);
    await saver(bank).earn.setAutoRenew({ positionId, on: true });
    const stake = await bank.earn.stakedOf(CUSTOMER, 'USDT');
    const posts = ledger.journal().length;
    const at = new Date(maturesAt.getTime() + 60_000);
    const next = new Date(maturesAt.getTime() + TERM_DAYS * DAY).toISOString();
    expect(await ops(bank).ops.renewEarnTerms({ limit: 10, at: at.toISOString() })).toEqual({
      renewed: [{ positionId, terms: [1], maturesAt: next }],
      skipped: [],
    });
    expect(await ops(bank).ops.renewEarnTerms({ limit: 10, at: at.toISOString() })).toEqual({ renewed: [], skipped: [] });
    const rows =
      await sql`SELECT term, previous_matures_at, matures_at, principal::text AS principal FROM bank.earn_renewals WHERE position_id = ${positionId}`;
    expect(rows).toEqual([{ term: 1, previous_matures_at: maturesAt, matures_at: new Date(next), principal: '1000.000000000000000000' }]);
    expect(ledger.journal()).toHaveLength(posts);
    expect(await bank.earn.stakedOf(CUSTOMER, 'USDT')).toBe(stake);
    const [renewed] = await saver(bank).earn.positions({ limit: 10, poolId: fixed.id });
    expect(renewed).toMatchObject({ maturesAt: next, renewals: 1, autoRenew: true, principal: '1000' });
    // The new term locks it again.
    await expect(bank.earn.withdraw(positionId, at)).rejects.toMatchObject({ code: 'bank.position_locked' });
  });

  it('a run long after the end renews each ended term in turn, counted from the end of the one before', async () => {
    const bank = services();
    const { fixed } = await pools(bank);
    const { positionId, maturesAt } = await fixedSaving(bank, fixed.id);
    await saver(bank).earn.setAutoRenew({ positionId, on: true });
    const at = new Date(maturesAt.getTime() + 2 * TERM_DAYS * DAY + 5 * DAY);
    const report = await bank.earn.renewDue({ limit: 10, at });
    expect(report.renewed).toEqual([{ positionId, terms: [1, 2, 3], maturesAt: new Date(maturesAt.getTime() + 3 * TERM_DAYS * DAY) }]);
  });

  it('a saving with auto-renew off is not renewed and can be taken back once its term ends', async () => {
    const bank = services();
    const { fixed } = await pools(bank);
    const { positionId, maturesAt } = await fixedSaving(bank, fixed.id);
    await saver(bank).earn.setAutoRenew({ positionId, on: true });
    await saver(bank).earn.setAutoRenew({ positionId, on: false });
    const at = new Date(maturesAt.getTime() + 60_000);
    expect(await bank.earn.renewDue({ limit: 10, at })).toEqual({ renewed: [], skipped: [] });
    expect(await bank.earn.withdraw(positionId, at)).toMatchObject({ status: 'closed' });
  });

  it('a frozen account or an identity that does not answer leaves the saving as it was, with the reason; no identity refuses the job', async () => {
    const bank = services();
    const { fixed } = await pools(bank);
    const mine = await fixedSaving(bank, fixed.id);
    await saver(bank).earn.setAutoRenew({ positionId: mine.positionId, on: true });
    const at = new Date(mine.maturesAt.getTime() + 60_000);
    accounts.set(CUSTOMER, 'frozen');
    expect(await bank.earn.renewDue({ limit: 10, at })).toEqual({
      renewed: [],
      skipped: [{ positionId: mine.positionId, code: 'bank.account_not_active' }],
    });
    accounts.set(CUSTOMER, 'active');
    accounts.failWith(new RecipientStateUnavailableError('identity is down'));
    expect((await bank.earn.renewDue({ limit: 10, at })).skipped).toEqual([
      { positionId: mine.positionId, code: 'bank.recipient_check_unavailable' },
    ]);
    accounts.failWith(null);
    await expect(services(false).earn.renewDue({ limit: 10, at })).rejects.toMatchObject({ code: 'bank.recipient_check_unset' });
    expect(await sql`SELECT 1 FROM bank.earn_renewals`).toHaveLength(0);
    expect((await sql`SELECT matures_at FROM bank.earn_positions WHERE id = ${mine.positionId}`)[0]).toEqual({
      matures_at: mine.maturesAt,
    });
    // Taken back after its term, as the reason says it can be.
    expect(await bank.earn.withdraw(mine.positionId, at)).toMatchObject({ status: 'closed' });
  });

  it('a pool closed to new savings renews nothing, and its saving can be taken back once the term ends', async () => {
    const bank = services();
    const { fixed } = await pools(bank);
    const mine = await fixedSaving(bank, fixed.id);
    await saver(bank).earn.setAutoRenew({ positionId: mine.positionId, on: true });
    await sql`UPDATE bank.earn_pools SET status = 'closed' WHERE id = ${fixed.id}`;
    const at = new Date(mine.maturesAt.getTime() + 60_000);
    expect(await bank.earn.renewDue({ limit: 10, at })).toEqual({ renewed: [], skipped: [] });
    expect(await bank.earn.withdraw(mine.positionId, at)).toMatchObject({ status: 'closed' });
  });

  it('a stake pot that no longer holds the principal (a take back half done) is not relocked, so its replay can finish', async () => {
    const bank = services();
    const { fixed } = await pools(bank);
    const mine = await fixedSaving(bank, fixed.id);
    await saver(bank).earn.setAutoRenew({ positionId: mine.positionId, on: true });
    // The take back's ledger post landed and the close did not.
    await ledger.post(
      recipes.earnWithdraw({ positionId: mine.positionId, poolId: fixed.id, userId: CUSTOMER, assetId: 'USDT', amount: amt('1000') }),
    );
    const at = new Date(mine.maturesAt.getTime() + 60_000);
    expect((await bank.earn.renewDue({ limit: 10, at })).skipped).toEqual([
      { positionId: mine.positionId, code: 'bank.earn_principal_mismatch' },
    ]);
    // The replay closes it on the same key, once.
    expect(await bank.earn.withdraw(mine.positionId, at)).toMatchObject({ status: 'closed' });
  });

  it('skipped savings do not fill the run: a saving after them by id still renews within the limit', async () => {
    const bank = services();
    const { fixed } = await pools(bank);
    // The frozen account's saving comes first by id, so it is the first one the run meets.
    const frozen = await fixedSaving(bank, fixed.id, SAVER_B, '00000000-0000-4000-8000-000000000001');
    const mine = await fixedSaving(bank, fixed.id, CUSTOMER, '00000000-0000-4000-8000-000000000002');
    await saver(bank, SAVER_B).earn.setAutoRenew({ positionId: frozen.positionId, on: true });
    await saver(bank).earn.setAutoRenew({ positionId: mine.positionId, on: true });
    accounts.set(SAVER_B, 'frozen');
    const at = new Date(Math.max(mine.maturesAt.getTime(), frozen.maturesAt.getTime()) + 60_000);
    const report = await bank.earn.renewDue({ limit: 1, at });
    expect(report.renewed.map((r) => r.positionId)).toEqual([mine.positionId]);
    expect(report.skipped).toEqual([{ positionId: frozen.positionId, code: 'bank.account_not_active' }]);
  });

  it('a blank batch size refuses, and the job renews only the pool it is asked about', async () => {
    const bank = services();
    const { fixed } = await pools(bank);
    const other = await bank.earn.createPool({
      assetId: 'USDT',
      kind: 'fixed',
      name: 'TEST other',
      aprBps: 100,
      termDays: 10,
      minDeposit: amt('1'),
    });
    const mine = await fixedSaving(bank, fixed.id);
    const theirs = await fixedSaving(bank, other.id, SAVER_B);
    await saver(bank).earn.setAutoRenew({ positionId: mine.positionId, on: true });
    await saver(bank, SAVER_B).earn.setAutoRenew({ positionId: theirs.positionId, on: true });
    const at = new Date(mine.maturesAt.getTime() + 60_000);
    await expect(ops(bank).ops.renewEarnTerms({ at: at.toISOString() })).rejects.toMatchObject({
      cause: { code: 'bank.earn_renew_batch_limit_unset' },
    });
    const report = await ops(bank).ops.renewEarnTerms({ limit: 10, poolId: fixed.id, at: at.toISOString() });
    expect(report.renewed.map((r) => r.positionId)).toEqual([mine.positionId]);
  });

  it('the payout schedule is daily: the next payout is the saving’s first day, then the day after the last one paid, closed pool or not', async () => {
    const bank = services();
    const { flexible } = await pools(bank);
    await saver(bank).earn.deposit({ poolId: flexible.id, positionId: randomUUID(), amount: '1000' });
    const [opened] = await saver(bank).earn.positions({ limit: 10, poolId: flexible.id });
    const firstDay = new Date(opened!.accruesFrom);
    expect(opened!.nextPayoutOn).toBe(day(firstDay));
    await bank.earn.accrue({ poolId: flexible.id, at: new Date(firstDay.getTime() + 60 * 60 * 1000) });
    // One payout for the day, however often the job runs.
    expect((await bank.earn.accrue({ poolId: flexible.id, at: new Date(firstDay.getTime() + 2 * 60 * 60 * 1000) })).alreadyAccrued).toBe(
      true,
    );
    const [paid] = await saver(bank).earn.positions({ limit: 10, poolId: flexible.id });
    expect(paid!.nextPayoutOn).toBe(day(new Date(firstDay.getTime() + DAY)));
    expect((await saver(bank).earn.interestHistory({ poolId: flexible.id, limit: 10 })).days).toHaveLength(1);
    await sql`UPDATE bank.earn_pools SET status = 'closed' WHERE id = ${flexible.id}`;
    const [closed] = await saver(bank).earn.positions({ limit: 10, poolId: flexible.id });
    // A closed pool still pays the savings it holds (BK-earn-04): the schedule keeps its next day.
    expect(closed!.nextPayoutOn).toBe(day(new Date(firstDay.getTime() + DAY)));
  });
});
