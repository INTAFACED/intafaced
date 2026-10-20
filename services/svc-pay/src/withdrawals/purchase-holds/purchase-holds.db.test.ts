import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, formatAmount, parseAmount as amt, userAvailable } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CardSandboxAdapter } from '../../rails/card-sandbox.js';
import { RailRegistry } from '../../rails/registry.js';
import { UserMoneyService } from '../../user-money-service.js';
import { createWithdrawalEligibility } from '../eligibility.js';
import { PurchaseHoldService } from './service.js';
import { purchaseHoldSource } from './source.js';

/** Purchase holds against a real Postgres and the reference ledger. TEST figures only. */
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_purchase_holds_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

const SECRET = 'svc-pay-purchase-holds-secret-at-least-32-chars';
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const OPERATOR = '99999999-9999-4999-8999-999999999999';
const DESTINATION = { kind: 'bank', ref: 'DE89370400440532013000' };
const T0 = new Date('2026-10-20T10:00:00.000Z');
const HOUR = 3_600_000;

describe('purchase holds (real Postgres)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db!: TestDatabase;
  let ledger: MemoryLedger;
  let money: UserMoneyService;
  let holds: PurchaseHoldService;
  let clock = T0;

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
    // Append-only tables refuse DELETE; TRUNCATE is the test reset.
    await db.sql`TRUNCATE pay.withdrawals, pay.deposits, pay.purchase_holds, pay.purchase_hold_releases, pay.purchase_hold_policy_events RESTART IDENTITY CASCADE`;
    clock = T0;
    ledger = new MemoryLedger();
    holds = new PurchaseHoldService({ sql: db.sql, now: () => clock });
    const rails = new RailRegistry([new CardSandboxAdapter({ secret: SECRET, toleranceSeconds: 300 })]);
    money = new UserMoneyService(db.sql, ledger, rails, { operatorCreditRails: ['card-sandbox'], purchaseHolds: holds.guard() });
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
  const record = (holdRef: string, amount: string, purchasedAt = clock, userId = USER) =>
    holds.record('founder-1', { holdRef, userId, assetId: 'USDT', amount, rail: 'card', purchasedAt: purchasedAt.toISOString() });
  const withdraw = (amount: string, clientRef: string) =>
    money.withdraw({ userId: USER, assetId: 'USDT', amount: amt(amount), rail: 'card-sandbox', destination: DESTINATION, clientRef });
  const withdrawalRows = async () => (await db.sql`SELECT 1 FROM pay.withdrawals`).length;

  it('records a hold once per reference and refuses a different purchase under the same reference', async () => {
    const first = await record('card:pay-1', '60');
    expect(first).toMatchObject({ state: 'held', amount: '60.000000000000000000', releaseAt: null, releasedAt: null });
    const again = await record('card:pay-1', '60');
    expect(again.id).toBe(first.id);
    await expect(record('card:pay-1', '61')).rejects.toMatchObject({ code: 'purchase_hold.ref_differs' });
    await expect(record('card:pay-2', '0')).rejects.toMatchObject({ code: 'purchase_hold.amount_invalid' });
    expect((await holds.list({ limit: 10 })).length).toBe(1);
  });

  it('a hold with no owner-set period stays held, shows no release time and releases nothing', async () => {
    await record('card:pay-1', '60', new Date(T0.getTime() - 1000 * HOUR));
    expect(await holds.policy()).toEqual({ holdSeconds: null, setBy: null, setAt: null });
    expect(await holds.releaseDue('founder-1')).toEqual({ released: [] });
    expect(await holds.held(USER, 'USDT')).toMatchObject({
      heldAmount: '60.000000000000000000',
      holds: 1,
      periodSet: false,
      earliestReleaseAt: null,
    });
  });

  it('withdrawable excludes the held amount until release; the funds stay in the ledger and tradable', async () => {
    await record('card:pay-1', '60');
    await holds.setPolicy('founder-1', { holdSeconds: 3 * 3600 });

    // 100 in the ledger, 60 held: 41 is refused, with the figures, before any claim or ledger move.
    const refusal = await withdraw('41', 'w-1').catch((e: unknown) => e);
    expect(refusal).toMatchObject({ code: 'pay.withdrawal_amount_held', detail: { heldAmount: '60', withdrawable: '40' } });
    expect(await withdrawalRows()).toBe(0);
    expect(await availableOf()).toBe('100');

    expect((await withdraw('40', 'w-2')).status).toBe('sent');
    expect(await availableOf()).toBe('60');

    // Nothing more may leave while the 60 is held.
    await expect(withdraw('1', 'w-3')).rejects.toMatchObject({ code: 'pay.withdrawal_amount_held' });

    // The period passes: the hold releases and the rest may leave.
    clock = new Date(T0.getTime() + 3 * HOUR);
    expect((await withdraw('60', 'w-4')).status).toBe('sent');
    expect(await availableOf()).toBe('0');
  });

  it('a blank period refuses withdrawing held funds with its own code and never guesses', async () => {
    await record('card:pay-1', '60');
    await expect(withdraw('41', 'w-1')).rejects.toMatchObject({ code: 'pay.purchase_hold_period_unset' });
    expect(await withdrawalRows()).toBe(0);
    // Funds above the hold are not held back by the missing period.
    expect((await withdraw('40', 'w-2')).status).toBe('sent');
    // Far in the future, still held: no period means no release.
    clock = new Date(T0.getTime() + 10_000 * HOUR);
    await expect(withdraw('1', 'w-3')).rejects.toMatchObject({ code: 'pay.purchase_hold_period_unset' });
  });

  it('release runs once per hold even when run twice or at the same moment', async () => {
    const a = await record('card:pay-1', '10');
    const b = await record('card:pay-2', '20');
    await record('card:pay-3', '30', new Date(T0.getTime() + 5 * HOUR));
    await holds.setPolicy('founder-1', { holdSeconds: 3600 });
    clock = new Date(T0.getTime() + 2 * HOUR);

    const runs = await Promise.all([holds.releaseDue('job-a'), holds.releaseDue('job-b')]);
    const released = runs.flatMap((r) => r.released).sort();
    expect(released).toEqual([a.id, b.id].sort());
    expect(await holds.releaseDue('job-c')).toEqual({ released: [] });
    const [count] = await db.sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM pay.purchase_hold_releases`;
    expect(count?.n).toBe('2');
    expect(await holds.list({ limit: 10, state: 'released' })).toHaveLength(2);
    expect(await holds.list({ limit: 10, state: 'held' })).toHaveLength(1);
    expect((await holds.held(USER, 'USDT')).heldAmount).toBe('30.000000000000000000');
  });

  it('a retry of a withdrawal that already went is not refused by a later hold', async () => {
    await holds.setPolicy('founder-1', { holdSeconds: 3600 });
    expect((await withdraw('40', 'w-1')).status).toBe('sent');
    await record('card:pay-1', '60');
    const again = await withdraw('40', 'w-1');
    expect(again.status).toBe('sent');
    expect(await withdrawalRows()).toBe(1);
    expect(await availableOf()).toBe('60');
  });

  it('parallel withdrawals under different references cannot together take held funds', async () => {
    await record('card:pay-1', '60');
    await holds.setPolicy('founder-1', { holdSeconds: 3 * 3600 });
    // 100 in the ledger, 60 held: only 40 may leave, however many ask at once.
    const results = await Promise.allSettled([withdraw('40', 'p-1'), withdraw('40', 'p-2'), withdraw('40', 'p-3'), withdraw('40', 'p-4')]);
    const sent = results.filter((r) => r.status === 'fulfilled');
    const refused = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(sent).toHaveLength(1);
    expect(refused.map((r) => r.reason.code)).toEqual([
      'pay.withdrawal_amount_held',
      'pay.withdrawal_amount_held',
      'pay.withdrawal_amount_held',
    ]);
    expect(await withdrawalRows()).toBe(1);
    expect(await availableOf()).toBe('60');
  });

  it('a claimed withdrawal whose hold is not posted yet still counts against the withdrawable amount', async () => {
    await record('card:pay-1', '60');
    await holds.setPolicy('founder-1', { holdSeconds: 3 * 3600 });
    await db.sql`
      INSERT INTO pay.withdrawals (user_id, asset_id, amount, rail, destination, client_ref, status)
      VALUES (${USER}, 'USDT', 30, 'card-sandbox', ${db.sql.json(DESTINATION)}, 'claimed-only', 'pending')`;
    await expect(withdraw('11', 'w-1')).rejects.toMatchObject({ code: 'pay.withdrawal_amount_held', detail: { withdrawable: '10' } });
    expect((await withdraw('10', 'w-2')).status).toBe('sent');
  });

  it('holds are per customer and per asset', async () => {
    await record('card:pay-1', '60', clock, OTHER);
    expect((await holds.held(USER, 'USDT')).heldAmount).toBe('0');
    expect((await withdraw('100', 'w-1')).status).toBe('sent');
  });

  it('eligibility blocks only when nothing is free to withdraw, and names why', async () => {
    const elig = createWithdrawalEligibility({ purchase_hold: purchaseHoldSource(holds.guard(), ledger) });
    const check = async () => (await elig.read(USER, 'USDT')).checks.find((c) => c.reason === 'purchase_hold')!;

    expect(await check()).toMatchObject({ state: 'clear' });
    await record('card:pay-1', '60');
    expect(await check()).toMatchObject({ state: 'clear' });

    await record('card:pay-2', '40');
    expect(await check()).toMatchObject({
      state: 'blocked',
      detail: '100 USDT bought by card, ACH or PayPal is held and the release period has not been set yet',
    });

    await holds.setPolicy('founder-1', { holdSeconds: 3600 });
    expect((await check()).detail).toContain('until 2026-10-20T11:00:00.000Z');

    clock = new Date(T0.getTime() + HOUR);
    expect(await check()).toMatchObject({ state: 'clear', detail: null });
  });

  it('no row is ever edited or deleted', async () => {
    const h = await record('card:pay-1', '60');
    await holds.setPolicy('founder-1', { holdSeconds: 3600 });
    clock = new Date(T0.getTime() + 2 * HOUR);
    await holds.releaseDue('job');
    await expect(db.sql`UPDATE pay.purchase_holds SET amount = 1 WHERE id = ${h.id}`).rejects.toThrow(/not permitted/);
    await expect(db.sql`DELETE FROM pay.purchase_holds WHERE id = ${h.id}`).rejects.toThrow(/not permitted/);
    await expect(db.sql`DELETE FROM pay.purchase_hold_releases WHERE hold_id = ${h.id}`).rejects.toThrow(/not permitted/);
    await expect(db.sql`UPDATE pay.purchase_hold_policy_events SET hold_seconds = 1`).rejects.toThrow(/not permitted/);
  });
});
