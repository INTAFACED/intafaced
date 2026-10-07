import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, formatAmount, parseAmount, recipes, userAvailable, type Amount } from '@intafaced/ledger-client';
import { createBankServices, type BankServices } from '../bank-service.js';
import { memoryLedgerHistory } from '../analytics/ledger-history.js';

/**
 * Unit card — bank.business dual-control LEDger holds (wave 13 L03)
 *
 * 1. Promise: §31:811 / Engine A Done bar — maker/checker holds
 * 2. Break on tip: over-threshold "pending" left available spendable (paper hold only)
 * 3. Done bar: over-threshold reserves purposed hold; concurrent drain fails;
 *    approve settles hold→dest; reject/cancel releases hold; self-approve refused
 * 4. Class M
 * 5. Paths: services/svc-bank/** · packages/ledger-client recipes (shared money path)
 * 6. RED: this suite (available drops on propose; cancel restores)
 * 7. Collision: claim-check clear; Denon #1625–1627 no svc-bank paths
 *
 * H8a PG-hard: this file never `describe.skip` / `postgresAvailable`. CI uses
 * TEST_DATABASE_URL (per-run database via `createTestDatabase` so schema-qualified
 * `bank.*` SQL stays on `bank`). Local without that env starts Testcontainers
 * `postgres:16-alpine`. Docker/PG down is a failed suite, not a green skip.
 * The admin URL is `TEST_DATABASE_URL`, not `TEST_DATABASE_URL_BANK`: creating a
 * database needs CREATEDB, which the per-service roles deliberately lack.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '../..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const MAKER = '11111111-1111-4111-8111-111111111111';
const CHECKER = '22222222-2222-4222-8222-222222222222';
const amt = (v: string): Amount => parseAmount(v);

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
      `H8a: svc-bank business is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

describe('business (source)', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

describe('maker/checker dual control with ledger holds', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let ledger: MemoryLedger;
  let bank: BankServices;

  async function fund(userId: string, assetId: string, value: string) {
    await ledger.post(
      recipes.deposit({
        userId,
        assetId,
        amount: amt(value),
        rail: 'test',
        railRef: `${userId}:${assetId}:${Math.random()}`,
      }),
    );
  }

  const availableOf = async (userId: string, assetId: string) =>
    formatAmount((await ledger.balance(userAvailable(userId, assetId))).amount);

  beforeAll(async () => {
    const admin = await openH8aAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'bank', url: admin.url, migrations });
    sql = db.sql;
  }, 120_000);

  beforeEach(async () => {
    await sql`
      TRUNCATE bank.business_payroll_lines, bank.business_payroll_runs,
               bank.business_approvals, bank.business_members, bank.business_accounts,
               bank.transfer_executions, bank.scheduled_transfers, bank.spaces
      RESTART IDENTITY CASCADE
    `;
    ledger = new MemoryLedger();
    bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), { nativeAssetId: 'IFC' });
  });

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  it('posts under threshold without a checker', async () => {
    const account = await bank.business.createAccount({
      name: 'Ops Co',
      assetId: 'USDT',
      spendThreshold: amt('500'),
      creatorUserId: MAKER,
    });
    const primary = await bank.spaces.ensurePrimary(MAKER, 'USDT');
    const pot = await bank.spaces.create({ userId: MAKER, assetId: 'USDT', name: 'Vendor' });
    await fund(MAKER, 'USDT', '200');

    const result = await bank.business.proposeTransfer({
      clientId: randomUUID(),
      accountId: account.id,
      makerUserId: MAKER,
      fromSpaceId: primary.id,
      toSpaceId: pot.id,
      amount: amt('100'),
    });
    expect(result.kind).toBe('posted');
    expect(await availableOf(MAKER, 'USDT')).toBe('100');
    expect(formatAmount(await bank.spaces.balanceOf(pot))).toBe('100');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('an under-threshold propose remembers its client id', async () => {
    const clientId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const account = await bank.business.createAccount({
      name: 'Ops Co',
      assetId: 'USDT',
      spendThreshold: amt('500'),
      creatorUserId: MAKER,
    });
    await bank.business.addMember({
      accountId: account.id,
      actorUserId: MAKER,
      userId: CHECKER,
      role: 'checker',
    });
    const primary = await bank.spaces.ensurePrimary(MAKER, 'USDT');
    const pot = await bank.spaces.create({ userId: MAKER, assetId: 'USDT', name: 'Vendor' });
    const other = await bank.spaces.create({ userId: MAKER, assetId: 'USDT', name: 'Other' });
    await fund(MAKER, 'USDT', '1000');

    const posted = await bank.business.proposeTransfer({
      clientId,
      accountId: account.id,
      makerUserId: MAKER,
      fromSpaceId: primary.id,
      toSpaceId: pot.id,
      amount: amt('100'),
    });
    expect(posted.kind).toBe('posted');
    if (posted.kind !== 'posted') throw new Error('expected posted');
    expect(await availableOf(MAKER, 'USDT')).toBe('900');
    expect(formatAmount(await bank.spaces.balanceOf(pot))).toBe('100');

    // The same instruction is now at or above the spend floor. Terms did not change.
    await sql`
      UPDATE bank.business_accounts
         SET spend_threshold = ${formatAmount(amt('50'))}::numeric
       WHERE id = ${account.id}::uuid
    `;

    await expect(
      bank.business.proposeTransfer({
        clientId,
        accountId: account.id,
        makerUserId: MAKER,
        fromSpaceId: primary.id,
        toSpaceId: other.id,
        amount: amt('100'),
      }),
    ).rejects.toMatchObject({ code: 'bank.business_request_conflict' });
    expect(await availableOf(MAKER, 'USDT')).toBe('900');
    expect(formatAmount(await bank.spaces.balanceOf(pot))).toBe('100');
    expect(formatAmount(await bank.spaces.balanceOf(other))).toBe('0');

    const again = await bank.business.proposeTransfer({
      clientId,
      accountId: account.id,
      makerUserId: MAKER,
      fromSpaceId: primary.id,
      toSpaceId: pot.id,
      amount: amt('100'),
    });
    expect(again).toEqual({ kind: 'posted', transferId: posted.transferId, ledgerTxId: posted.ledgerTxId });
    expect(await availableOf(MAKER, 'USDT')).toBe('900');
    expect(formatAmount(await bank.spaces.balanceOf(pot))).toBe('100');

    const settled = await bank.business.approve({ approvalId: clientId, checkerUserId: CHECKER });
    expect(settled).toEqual({ transferId: posted.transferId, ledgerTxId: posted.ledgerTxId });
    expect(await availableOf(MAKER, 'USDT')).toBe('900');
    expect(formatAmount(await bank.spaces.balanceOf(pot))).toBe('100');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('reserves over-threshold on propose; checker settle lands at destination', async () => {
    const account = await bank.business.createAccount({
      name: 'Ops Co',
      assetId: 'USDT',
      spendThreshold: amt('100'),
      creatorUserId: MAKER,
    });
    await bank.business.addMember({
      accountId: account.id,
      actorUserId: MAKER,
      userId: CHECKER,
      role: 'checker',
    });
    const primary = await bank.spaces.ensurePrimary(MAKER, 'USDT');
    const pot = await bank.spaces.create({ userId: MAKER, assetId: 'USDT', name: 'Payroll' });
    await fund(MAKER, 'USDT', '1000');

    const proposed = await bank.business.proposeTransfer({
      clientId: randomUUID(),
      accountId: account.id,
      makerUserId: MAKER,
      fromSpaceId: primary.id,
      toSpaceId: pot.id,
      amount: amt('250'),
    });
    expect(proposed.kind).toBe('pending');
    // LEDger hold: available drops immediately; pot not credited yet.
    expect(await availableOf(MAKER, 'USDT')).toBe('750');
    expect(formatAmount(await bank.spaces.balanceOf(pot))).toBe('0');
    if (proposed.kind !== 'pending') throw new Error('expected pending');
    expect(proposed.approval.holdLedgerTxId).toBeTruthy();

    await expect(
      bank.business.approve({
        approvalId: proposed.approval.id,
        checkerUserId: MAKER,
      }),
    ).rejects.toMatchObject({ code: 'bank.business_self_approve' });

    const posted = await bank.business.approve({
      approvalId: proposed.approval.id,
      checkerUserId: CHECKER,
    });
    expect(posted.ledgerTxId).toBeTruthy();
    expect(await availableOf(MAKER, 'USDT')).toBe('750');
    expect(formatAmount(await bank.spaces.balanceOf(pot))).toBe('250');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('a settle that dies after the row is approved finishes on the next approve', async () => {
    const account = await bank.business.createAccount({
      name: 'Ops Co',
      assetId: 'USDT',
      spendThreshold: amt('100'),
      creatorUserId: MAKER,
    });
    await bank.business.addMember({
      accountId: account.id,
      actorUserId: MAKER,
      userId: CHECKER,
      role: 'checker',
    });
    const primary = await bank.spaces.ensurePrimary(MAKER, 'USDT');
    const pot = await bank.spaces.create({ userId: MAKER, assetId: 'USDT', name: 'Payroll' });
    await fund(MAKER, 'USDT', '1000');
    const proposed = await bank.business.proposeTransfer({
      clientId: randomUUID(),
      accountId: account.id,
      makerUserId: MAKER,
      fromSpaceId: primary.id,
      toSpaceId: pot.id,
      amount: amt('250'),
    });
    if (proposed.kind !== 'pending') throw new Error('expected pending');

    const orig = ledger.post.bind(ledger);
    let failSettle = true;
    ledger.post = (async (req: Parameters<MemoryLedger['post']>[0]) => {
      if (failSettle && req.idempotencyKey.startsWith('bank.business.settle:')) {
        failSettle = false;
        throw new Error('settle down');
      }
      return orig(req);
    }) as MemoryLedger['post'];

    await expect(bank.business.approve({ approvalId: proposed.approval.id, checkerUserId: CHECKER })).rejects.toThrow(/settle down/);
    expect(formatAmount(await bank.spaces.balanceOf(pot))).toBe('0');

    const posted = await bank.business.approve({ approvalId: proposed.approval.id, checkerUserId: CHECKER });
    expect(posted.ledgerTxId).toBeTruthy();
    expect(await availableOf(MAKER, 'USDT')).toBe('750');
    expect(formatAmount(await bank.spaces.balanceOf(pot))).toBe('250');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('a release that dies after reject returns the hold on the next reject', async () => {
    const account = await bank.business.createAccount({
      name: 'Ops Co',
      assetId: 'USDT',
      spendThreshold: amt('100'),
      creatorUserId: MAKER,
    });
    await bank.business.addMember({
      accountId: account.id,
      actorUserId: MAKER,
      userId: CHECKER,
      role: 'checker',
    });
    const primary = await bank.spaces.ensurePrimary(MAKER, 'USDT');
    const pot = await bank.spaces.create({ userId: MAKER, assetId: 'USDT', name: 'Payroll' });
    await fund(MAKER, 'USDT', '1000');
    const proposed = await bank.business.proposeTransfer({
      clientId: randomUUID(),
      accountId: account.id,
      makerUserId: MAKER,
      fromSpaceId: primary.id,
      toSpaceId: pot.id,
      amount: amt('250'),
    });
    if (proposed.kind !== 'pending') throw new Error('expected pending');

    const orig = ledger.post.bind(ledger);
    let failRelease = true;
    ledger.post = (async (req: Parameters<MemoryLedger['post']>[0]) => {
      if (failRelease && req.idempotencyKey.startsWith('bank.business.release:')) {
        failRelease = false;
        throw new Error('release down');
      }
      return orig(req);
    }) as MemoryLedger['post'];

    await expect(bank.business.reject({ approvalId: proposed.approval.id, checkerUserId: CHECKER })).rejects.toThrow(/release down/);
    expect(await availableOf(MAKER, 'USDT')).toBe('750');

    await bank.business.reject({ approvalId: proposed.approval.id, checkerUserId: CHECKER });
    expect(await availableOf(MAKER, 'USDT')).toBe('1000');
    expect(formatAmount(await bank.spaces.balanceOf(pot))).toBe('0');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('held funds cannot be double-spent while pending', async () => {
    const account = await bank.business.createAccount({
      name: 'Ops Co',
      assetId: 'USDT',
      spendThreshold: amt('50'),
      creatorUserId: MAKER,
    });
    await bank.business.addMember({
      accountId: account.id,
      actorUserId: MAKER,
      userId: CHECKER,
      role: 'checker',
    });
    const primary = await bank.spaces.ensurePrimary(MAKER, 'USDT');
    const pot = await bank.spaces.create({ userId: MAKER, assetId: 'USDT', name: 'A' });
    const other = await bank.spaces.create({ userId: MAKER, assetId: 'USDT', name: 'B' });
    await fund(MAKER, 'USDT', '100');

    const proposed = await bank.business.proposeTransfer({
      clientId: randomUUID(),
      accountId: account.id,
      makerUserId: MAKER,
      fromSpaceId: primary.id,
      toSpaceId: pot.id,
      amount: amt('100'),
    });
    if (proposed.kind !== 'pending') throw new Error('expected pending');
    expect(await availableOf(MAKER, 'USDT')).toBe('0');

    await expect(
      bank.transfers.transfer({
        transferId: 'drain-attempt',
        fromSpaceId: primary.id,
        toSpaceId: other.id,
        amount: amt('1'),
      }),
    ).rejects.toBeTruthy();

    await bank.business.approve({ approvalId: proposed.approval.id, checkerUserId: CHECKER });
    expect(formatAmount(await bank.spaces.balanceOf(pot))).toBe('100');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('reject releases the hold back to available', async () => {
    const account = await bank.business.createAccount({
      name: 'Ops Co',
      assetId: 'USDT',
      spendThreshold: amt('10'),
      creatorUserId: MAKER,
    });
    await bank.business.addMember({
      accountId: account.id,
      actorUserId: MAKER,
      userId: CHECKER,
      role: 'checker',
    });
    const primary = await bank.spaces.ensurePrimary(MAKER, 'USDT');
    const pot = await bank.spaces.create({ userId: MAKER, assetId: 'USDT', name: 'X' });
    await fund(MAKER, 'USDT', '100');

    const proposed = await bank.business.proposeTransfer({
      clientId: randomUUID(),
      accountId: account.id,
      makerUserId: MAKER,
      fromSpaceId: primary.id,
      toSpaceId: pot.id,
      amount: amt('50'),
    });
    if (proposed.kind !== 'pending') throw new Error('expected pending');
    expect(await availableOf(MAKER, 'USDT')).toBe('50');

    await bank.business.reject({ approvalId: proposed.approval.id, checkerUserId: CHECKER });
    expect(await availableOf(MAKER, 'USDT')).toBe('100');
    expect(formatAmount(await bank.spaces.balanceOf(pot))).toBe('0');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('maker cancel releases the hold', async () => {
    const account = await bank.business.createAccount({
      name: 'Ops Co',
      assetId: 'USDT',
      spendThreshold: amt('10'),
      creatorUserId: MAKER,
    });
    const primary = await bank.spaces.ensurePrimary(MAKER, 'USDT');
    const pot = await bank.spaces.create({ userId: MAKER, assetId: 'USDT', name: 'Y' });
    await fund(MAKER, 'USDT', '80');

    const proposed = await bank.business.proposeTransfer({
      clientId: randomUUID(),
      accountId: account.id,
      makerUserId: MAKER,
      fromSpaceId: primary.id,
      toSpaceId: pot.id,
      amount: amt('40'),
    });
    if (proposed.kind !== 'pending') throw new Error('expected pending');
    expect(await availableOf(MAKER, 'USDT')).toBe('40');

    await bank.business.cancel({ approvalId: proposed.approval.id, actorUserId: MAKER });
    expect(await availableOf(MAKER, 'USDT')).toBe('80');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('pays every payroll recipient in one post, or none when short', async () => {
    const account = await bank.business.createAccount({
      name: 'Ops Co',
      assetId: 'USDT',
      spendThreshold: amt('10'),
      creatorUserId: MAKER,
    });
    const primary = await bank.spaces.ensurePrimary(MAKER, 'USDT');
    const alice = await bank.spaces.ensurePrimary(CHECKER, 'USDT');
    const bob = await bank.spaces.create({ userId: MAKER, assetId: 'USDT', name: 'Contractor' });
    await fund(MAKER, 'USDT', '100');
    const payrollId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

    const run = await bank.business.runPayroll({
      payrollId,
      accountId: account.id,
      actorUserId: MAKER,
      fromSpaceId: primary.id,
      recipients: [
        { toSpaceId: alice.id, amount: amt('40') },
        { toSpaceId: bob.id, amount: amt('25') },
      ],
    });
    expect(run.ledgerTxId).toBeTruthy();
    expect(await availableOf(MAKER, 'USDT')).toBe('35');
    expect(formatAmount(await bank.spaces.balanceOf(alice))).toBe('40');
    expect(formatAmount(await bank.spaces.balanceOf(bob))).toBe('25');
    expect(ledger.reconcile()).toEqual({ ok: true });

    const again = await bank.business.runPayroll({
      payrollId,
      accountId: account.id,
      actorUserId: MAKER,
      fromSpaceId: primary.id,
      recipients: [
        { toSpaceId: alice.id, amount: amt('40') },
        { toSpaceId: bob.id, amount: amt('25') },
      ],
    });
    expect(again.ledgerTxId).toBe(run.ledgerTxId);
    expect(await availableOf(MAKER, 'USDT')).toBe('35');

    await expect(
      bank.business.runPayroll({
        payrollId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        accountId: account.id,
        actorUserId: MAKER,
        fromSpaceId: primary.id,
        recipients: [
          { toSpaceId: alice.id, amount: amt('30') },
          { toSpaceId: bob.id, amount: amt('10') },
        ],
      }),
    ).rejects.toBeTruthy();
    expect(await availableOf(MAKER, 'USDT')).toBe('35');
    expect(formatAmount(await bank.spaces.balanceOf(alice))).toBe('40');
    expect(formatAmount(await bank.spaces.balanceOf(bob))).toBe('25');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('refuses mixed-asset payroll as rate unset — never invents FX', async () => {
    const account = await bank.business.createAccount({
      name: 'Ops Co',
      assetId: 'USDT',
      spendThreshold: amt('10'),
      creatorUserId: MAKER,
    });
    const primary = await bank.spaces.ensurePrimary(MAKER, 'USDT');
    const eur = await bank.spaces.ensurePrimary(CHECKER, 'EUR');
    await fund(MAKER, 'USDT', '100');

    await expect(
      bank.business.runPayroll({
        payrollId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        accountId: account.id,
        actorUserId: MAKER,
        fromSpaceId: primary.id,
        recipients: [{ toSpaceId: eur.id, amount: amt('10') }],
      }),
    ).rejects.toMatchObject({ code: 'bank.business_payroll_rate_unset' });
    expect(await availableOf(MAKER, 'USDT')).toBe('100');
    expect(formatAmount(await bank.spaces.balanceOf(eur))).toBe('0');
  });

  it('refuses an empty payroll', async () => {
    const account = await bank.business.createAccount({
      name: 'Ops Co',
      assetId: 'USDT',
      spendThreshold: amt('10'),
      creatorUserId: MAKER,
    });
    const primary = await bank.spaces.ensurePrimary(MAKER, 'USDT');
    await expect(
      bank.business.runPayroll({
        payrollId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        accountId: account.id,
        actorUserId: MAKER,
        fromSpaceId: primary.id,
        recipients: [],
      }),
    ).rejects.toMatchObject({ code: 'bank.business_payroll_empty' });
  });

  it('refuses a non-member checker', async () => {
    const account = await bank.business.createAccount({
      name: 'Ops Co',
      assetId: 'USDT',
      spendThreshold: amt('10'),
      creatorUserId: MAKER,
    });
    const primary = await bank.spaces.ensurePrimary(MAKER, 'USDT');
    const pot = await bank.spaces.create({ userId: MAKER, assetId: 'USDT', name: 'X' });
    await fund(MAKER, 'USDT', '100');
    const proposed = await bank.business.proposeTransfer({
      clientId: randomUUID(),
      accountId: account.id,
      makerUserId: MAKER,
      fromSpaceId: primary.id,
      toSpaceId: pot.id,
      amount: amt('50'),
    });
    if (proposed.kind !== 'pending') throw new Error('expected pending');
    await expect(bank.business.approve({ approvalId: proposed.approval.id, checkerUserId: CHECKER })).rejects.toMatchObject({
      code: 'bank.business_not_member',
    });
  });
});
