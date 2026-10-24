/**
 * BK-pots-03 (J-bank-07 #4): the bills pot. A standing order from the person's bills pot that finds too little is
 * refused like any other, unless the person turned the fallback on: then the shortfall moves from the main account into
 * the pot first, and the order pays once.
 *
 * Postgres (TEST_DATABASE_URL) and a MemoryLedger. Each case drives the runner with its own `now`.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  MemoryLedger,
  formatAmount,
  parseAmount as amt,
  recipes,
  subAccountAvailable,
  userAvailable,
  type LedgerClient,
} from '@intafaced/ledger-client';
import { memoryLedgerHistory } from '../analytics/ledger-history.js';
import { createBankServices } from '../bank-service.js';

const USER = '41111111-1111-4111-8111-111111111111';
const OTHER = '42222222-2222-4222-8222-222222222222';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const MIGRATIONS = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));
const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';

const db: TestDatabase = await createTestDatabase({ service: 'bank', url: DB_URL, migrations: MIGRATIONS });
const sql = db.sql;

afterAll(async () => {
  await db.drop();
}, 30_000);

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-11-02T09:00:00.000Z');
const TOMORROW = new Date(NOW.getTime() + DAY);
const DUE = new Date(TOMORROW.getTime() + 60_000);

let ledger: MemoryLedger;

beforeEach(async () => {
  await sql`
    TRUNCATE bank.bills_pots, bank.schedule_revisions, bank.transfer_executions, bank.scheduled_transfers, bank.spaces
    RESTART IDENTITY CASCADE
  `;
  ledger = new MemoryLedger();
});

function services() {
  return createBankServices(sql, ledger, memoryLedgerHistory(ledger), { scheduleEditCutoffMinutes: '60' });
}

async function fund(amount: string) {
  await ledger.post(recipes.deposit({ userId: USER, assetId: 'USDT', amount: amt(amount), rail: 'test', railRef: randomUUID() }));
}

const balance = async (spaceId: string) => formatAmount((await ledger.balance(subAccountAvailable(spaceId, 'USDT'))).amount);
const main = async () => formatAmount((await ledger.balance(userAvailable(USER, 'USDT'))).amount);
const topUps = () => ledger.journal().filter((tx) => tx.idempotencyKey.includes(':bills-fallback:'));

/** A bills pot holding `held`, a payee space, and a TEST bill of `bill` paid from the pot tomorrow. */
async function billFromPot(bank: ReturnType<typeof services>, opts: { mainHolds: string; held: string; bill: string }) {
  const account = await bank.spaces.ensurePrimary(USER, 'USDT');
  const pot = await bank.spaces.create({ userId: USER, assetId: 'USDT', name: 'Bills TEST' });
  const payee = await bank.spaces.create({ userId: USER, assetId: 'USDT', name: 'Landlord TEST' });
  await fund(opts.mainHolds);
  if (amt(opts.held) > 0n) {
    await bank.transfers.transfer({
      transferId: `fill-${randomUUID()}`,
      fromSpaceId: account.id,
      toSpaceId: pot.id,
      amount: amt(opts.held),
    });
  }
  const order = await bank.transfers.schedule({
    userId: USER,
    fromSpaceId: pot.id,
    toSpaceId: payee.id,
    amount: amt(opts.bill),
    cadence: 'once',
    startsAt: TOMORROW,
    scheduleId: randomUUID(),
  });
  return { account, pot, payee, order };
}

describe('a standing order from the bills pot that finds too little', () => {
  it('with the fallback on, moves the shortfall from the main account and pays once', async () => {
    const bank = services();
    const { pot, payee, order } = await billFromPot(bank, { mainHolds: '20', held: '5', bill: '8' });
    await bank.billsPots.set(USER, pot.id, true);
    expect(await bank.transfers.runDueTransfers({ now: DUE, limit: 10 })).toMatchObject({ settled: 1, rejected: 0 });
    expect(await balance(payee.id)).toBe('8');
    expect(await balance(pot.id)).toBe('0');
    // Main held 15 after filling the pot: the shortfall of 3 moved, once.
    expect(await main()).toBe('12');
    expect(topUps()).toHaveLength(1);
    expect(await bank.transfers.executions(order.id, 10)).toEqual([
      expect.objectContaining({ occurrence: 0, amount: '8', status: 'settled', rejectionCode: null }),
    ]);
    // Run again: nothing more moves.
    const posts = ledger.journal().length;
    await bank.transfers.runDueTransfers({ now: new Date(DUE.getTime() + DAY), limit: 10 });
    expect(ledger.journal().length).toBe(posts);
  });

  it('with the fallback off (the default), is recorded as failed and moves nothing', async () => {
    const bank = services();
    const { pot, payee, order } = await billFromPot(bank, { mainHolds: '20', held: '5', bill: '8' });
    await bank.billsPots.set(USER, pot.id, false);
    const posts = ledger.journal().length;
    expect(await bank.transfers.runDueTransfers({ now: DUE, limit: 10 })).toMatchObject({ settled: 0, rejected: 1 });
    expect(ledger.journal().length).toBe(posts);
    expect(await balance(payee.id)).toBe('0');
    expect(await balance(pot.id)).toBe('5');
    expect(await main()).toBe('15');
    expect(await bank.transfers.executions(order.id, 10)).toEqual([
      expect.objectContaining({ status: 'rejected', rejectionCode: 'ledger.insufficient_funds' }),
    ]);
  });

  it('a pot that is not the bills pot never tops up, whatever another pot says', async () => {
    const bank = services();
    const { order } = await billFromPot(bank, { mainHolds: '20', held: '5', bill: '8' });
    const other = await bank.spaces.create({ userId: USER, assetId: 'USDT', name: 'Other TEST' });
    await bank.billsPots.set(USER, other.id, true);
    expect(await bank.transfers.runDueTransfers({ now: DUE, limit: 10 })).toMatchObject({ rejected: 1 });
    expect(topUps()).toHaveLength(0);
    expect(await bank.transfers.executions(order.id, 10)).toEqual([expect.objectContaining({ status: 'rejected' })]);
  });

  it('when the main account cannot cover the shortfall either, nothing moves and the bill is recorded as failed', async () => {
    const bank = services();
    const { pot, payee, order } = await billFromPot(bank, { mainHolds: '6', held: '5', bill: '8' });
    await bank.billsPots.set(USER, pot.id, true);
    expect(await main()).toBe('1');
    expect(await bank.transfers.runDueTransfers({ now: DUE, limit: 10 })).toMatchObject({ settled: 0, rejected: 1 });
    expect(topUps()).toHaveLength(0);
    expect(await balance(pot.id)).toBe('5');
    expect(await balance(payee.id)).toBe('0');
    expect(await main()).toBe('1');
    expect(await bank.transfers.executions(order.id, 10)).toEqual([
      expect.objectContaining({ status: 'rejected', rejectionCode: 'ledger.insufficient_funds' }),
    ]);
  });

  it('a pass that dies after the top-up finds it on the next pass: one top-up, and the bill pays once', async () => {
    const bank = services();
    const { pot, payee } = await billFromPot(bank, { mainHolds: '20', held: '5', bill: '8' });
    await bank.billsPots.set(USER, pot.id, true);
    // The first post refuses for too little; the top-up lands; the retry's post is lost before the book.
    const real = ledger.post.bind(ledger);
    let orderPosts = 0;
    ledger.post = (async (req: Parameters<LedgerClient['post']>[0]) => {
      if (req.idempotencyKey.startsWith('bank.transfer.sched:') && ++orderPosts === 2) throw new Error('socket hang up');
      return real(req);
    }) as typeof ledger.post;
    const first = await bank.transfers.runDueTransfers({ now: DUE, limit: 10 });
    expect(first.settled).toBe(0);
    expect(topUps()).toHaveLength(1);
    expect(await balance(pot.id)).toBe('8');
    expect(await balance(payee.id)).toBe('0');

    expect(await bank.transfers.runDueTransfers({ now: new Date(DUE.getTime() + 60_000), limit: 10 })).toMatchObject({ settled: 1 });
    expect(topUps()).toHaveLength(1);
    expect(await balance(payee.id)).toBe('8');
    expect(await balance(pot.id)).toBe('0');
    expect(await main()).toBe('12');
  });
});

describe('choosing the bills pot', () => {
  it('takes one of the person’s own live pots, moves the role between pots, and archiving ends it', async () => {
    const bank = services();
    const account = await bank.spaces.ensurePrimary(USER, 'USDT');
    const bills = await bank.spaces.create({ userId: USER, assetId: 'USDT', name: 'Bills TEST' });
    const other = await bank.spaces.create({ userId: USER, assetId: 'USDT', name: 'Other TEST' });
    const theirs = await bank.spaces.create({ userId: OTHER, assetId: 'USDT', name: 'Theirs TEST' });

    await expect(bank.billsPots.set(USER, account.id, true)).rejects.toMatchObject({ code: 'bank.space_change_invalid' });
    await expect(bank.billsPots.set(USER, theirs.id, true)).rejects.toMatchObject({ code: 'bank.space_not_found' });
    await expect(bank.billsPots.clear(USER, theirs.id)).rejects.toMatchObject({ code: 'bank.space_not_found' });

    expect(await bank.billsPots.set(USER, bills.id, false)).toMatchObject({ spaceId: bills.id, assetId: 'USDT', fallback: false });
    expect(await bank.billsPots.set(USER, bills.id, true)).toMatchObject({ spaceId: bills.id, fallback: true });
    expect(await bank.billsPots.list(USER)).toEqual([expect.objectContaining({ spaceId: bills.id, fallback: true })]);

    await bank.billsPots.set(USER, other.id, false);
    expect(await bank.billsPots.list(USER)).toEqual([expect.objectContaining({ spaceId: other.id, fallback: false })]);
    expect(await bank.billsPots.forSpace(bills.id)).toBeNull();

    await bank.billsPots.clear(USER, other.id);
    expect(await bank.billsPots.list(USER)).toEqual([]);

    await bank.billsPots.set(USER, bills.id, true);
    await bank.spaces.archive(bills.id);
    await expect(bank.billsPots.set(USER, bills.id, true)).rejects.toMatchObject({ code: 'bank.space_archived' });
    await bank.billsPots.released(bills.id);
    expect(await bank.billsPots.list(USER)).toEqual([]);
  });
});
