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
import { accountForSpace } from '../spaces/space-service.js';

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

  it('a conflicting propose is not reported as pending', async () => {
    const account = await bank.business.createAccount({
      name: 'Ops Co',
      assetId: 'USDT',
      spendThreshold: amt('100'),
      creatorUserId: MAKER,
    });
    const primary = await bank.spaces.ensurePrimary(MAKER, 'USDT');
    const pot = await bank.spaces.create({ userId: MAKER, assetId: 'USDT', name: 'Vendor' });
    const other = await bank.spaces.create({ userId: MAKER, assetId: 'USDT', name: 'Other' });
    await fund(MAKER, 'USDT', '5000');

    // Opening lookup already missed. The row appears while the hold posts, so
    // the insert loses ON CONFLICT and has to judge the row that won.
    async function proposeAgainst(input: {
      clientId: string;
      toSpaceId: string;
      amount: Amount;
      existing: {
        toSpaceId: string;
        amount: Amount;
        status: 'pending' | 'approved' | 'rejected' | 'cancelled';
        transferId?: string;
        ledgerTxId?: string;
        holdLedgerTxId?: string;
      };
    }) {
      const orig = ledger.post.bind(ledger);
      ledger.post = (async (req: Parameters<MemoryLedger['post']>[0]) => {
        const posted = await orig(req);
        if (req.idempotencyKey === `bank.business.hold:${input.clientId}`) {
          await sql`
            INSERT INTO bank.business_approvals
              (id, account_id, maker_user_id, from_space_id, to_space_id, asset_id, amount, status,
               transfer_id, hold_ledger_tx_id, ledger_tx_id, decided_at)
            VALUES (
              ${input.clientId}::uuid, ${account.id}::uuid, ${MAKER},
              ${primary.id}::uuid, ${input.existing.toSpaceId}::uuid,
              'USDT', ${formatAmount(input.existing.amount)}::numeric,
              ${input.existing.status}::bank.business_approval_status,
              ${input.existing.transferId ?? null}, ${input.existing.holdLedgerTxId ?? null},
              ${input.existing.ledgerTxId ?? null},
              ${input.existing.status === 'pending' ? null : new Date()}
            )
          `;
        }
        return posted;
      }) as MemoryLedger['post'];
      try {
        return await bank.business.proposeTransfer({
          clientId: input.clientId,
          accountId: account.id,
          makerUserId: MAKER,
          fromSpaceId: primary.id,
          toSpaceId: input.toSpaceId,
          amount: input.amount,
        });
      } finally {
        ledger.post = orig;
      }
    }

    await expect(
      proposeAgainst({
        clientId: 'f1580001-0000-4000-8000-000000000001',
        toSpaceId: pot.id,
        amount: amt('250'),
        existing: { toSpaceId: other.id, amount: amt('400'), status: 'pending' },
      }),
    ).rejects.toMatchObject({ code: 'bank.business_request_conflict' });
    expect(formatAmount(await bank.spaces.balanceOf(pot))).toBe('0');
    expect(formatAmount(await bank.spaces.balanceOf(other))).toBe('0');

    const approved = await proposeAgainst({
      clientId: 'f1580002-0000-4000-8000-000000000002',
      toSpaceId: pot.id,
      amount: amt('250'),
      existing: {
        toSpaceId: pot.id,
        amount: amt('250'),
        status: 'approved',
        transferId: 'orig-transfer-f158',
        ledgerTxId: 'orig-ledger-f158',
      },
    });
    expect(approved).toEqual({
      kind: 'posted',
      transferId: 'orig-transfer-f158',
      ledgerTxId: 'orig-ledger-f158',
    });
    expect(formatAmount(await bank.spaces.balanceOf(pot))).toBe('0');

    await expect(
      proposeAgainst({
        clientId: 'f1580003-0000-4000-8000-000000000003',
        toSpaceId: pot.id,
        amount: amt('250'),
        existing: { toSpaceId: pot.id, amount: amt('250'), status: 'rejected' },
      }),
    ).rejects.toMatchObject({ code: 'bank.business_approval_inactive' });

    await expect(
      proposeAgainst({
        clientId: 'f1580004-0000-4000-8000-000000000004',
        toSpaceId: pot.id,
        amount: amt('250'),
        existing: { toSpaceId: pot.id, amount: amt('250'), status: 'cancelled' },
      }),
    ).rejects.toMatchObject({ code: 'bank.business_approval_inactive' });

    const pending = await proposeAgainst({
      clientId: 'f1580005-0000-4000-8000-000000000005',
      toSpaceId: pot.id,
      amount: amt('250'),
      existing: {
        toSpaceId: pot.id,
        amount: amt('250'),
        status: 'pending',
        holdLedgerTxId: 'existing-hold-f158',
      },
    });
    expect(pending).toMatchObject({
      kind: 'pending',
      approval: {
        id: 'f1580005-0000-4000-8000-000000000005',
        status: 'pending',
        toSpaceId: pot.id,
        amount: amt('250'),
        holdLedgerTxId: 'existing-hold-f158',
      },
    });
    expect(formatAmount(await bank.spaces.balanceOf(pot))).toBe('0');
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

  it('a matching payroll retry completes lines that are not all visible yet', async () => {
    const account = await bank.business.createAccount({
      name: 'Ops Co',
      assetId: 'USDT',
      spendThreshold: amt('10'),
      creatorUserId: MAKER,
    });
    const otherAccount = await bank.business.createAccount({
      name: 'Other Co',
      assetId: 'USDT',
      spendThreshold: amt('10'),
      creatorUserId: MAKER,
    });
    const primary = await bank.spaces.ensurePrimary(MAKER, 'USDT');
    const otherSource = await bank.spaces.create({ userId: MAKER, assetId: 'USDT', name: 'Reserve' });
    const alice = await bank.spaces.ensurePrimary(CHECKER, 'USDT');
    const bob = await bank.spaces.create({ userId: MAKER, assetId: 'USDT', name: 'Contractor' });
    const carol = await bank.spaces.create({ userId: MAKER, assetId: 'USDT', name: 'Vendor' });
    await fund(MAKER, 'USDT', '1000');

    const same = [
      { toSpaceId: alice.id, amount: amt('40') },
      { toSpaceId: bob.id, amount: amt('25') },
    ];
    const pay = (payrollId: string, recipients: ReadonlyArray<{ toSpaceId: string; amount: Amount }>) =>
      ledger.post(
        recipes.businessPayroll({
          payrollId,
          from: accountForSpace(primary),
          recipients: recipients.map((line) => ({
            to: line.toSpaceId === alice.id ? accountForSpace(alice) : line.toSpaceId === bob.id ? accountForSpace(bob) : accountForSpace(carol),
            amount: line.amount,
          })),
        }),
      );
    const seedRun = async (
      payrollId: string,
      ledgerTxId: string,
      lines: ReadonlyArray<{ toSpaceId: string; amount: Amount }>,
    ) => {
      await sql`
        INSERT INTO bank.business_payroll_runs
          (id, account_id, actor_user_id, from_space_id, asset_id, ledger_tx_id)
        VALUES (
          ${payrollId}::uuid, ${account.id}::uuid, ${MAKER},
          ${primary.id}::uuid, 'USDT', ${ledgerTxId}
        )
      `;
      for (const line of lines) {
        await sql`
          INSERT INTO bank.business_payroll_lines (payroll_id, to_space_id, amount)
          VALUES (${payrollId}::uuid, ${line.toSpaceId}::uuid, ${formatAmount(line.amount)}::numeric)
        `;
      }
    };
    const run = (
      payrollId: string,
      recipients: ReadonlyArray<{ toSpaceId: string; amount: Amount }>,
      extras?: { accountId?: string; fromSpaceId?: string },
    ) =>
      bank.business.runPayroll({
        payrollId,
        accountId: extras?.accountId ?? account.id,
        actorUserId: MAKER,
        fromSpaceId: extras?.fromSpaceId ?? primary.id,
        recipients,
      });

    const origPost = ledger.post.bind(ledger);
    let payrollPostCalls = 0;
    const racedId = 'a1590001-0000-4000-8000-000000000001';
    let racedTxId = '';
    ledger.post = (async (req: Parameters<MemoryLedger['post']>[0]) => {
      if (req.idempotencyKey.startsWith('bank.business.payroll:')) payrollPostCalls += 1;
      const posted = await origPost(req);
      // Opening lookup already missed. The run row lands before any line.
      if (req.idempotencyKey === `bank.business.payroll:${racedId}` && !racedTxId) {
        racedTxId = posted.id;
        await sql`
          INSERT INTO bank.business_payroll_runs
            (id, account_id, actor_user_id, from_space_id, asset_id, ledger_tx_id)
          VALUES (
            ${racedId}::uuid, ${account.id}::uuid, ${MAKER},
            ${primary.id}::uuid, 'USDT', ${posted.id}
          )
        `;
      }
      return posted;
    }) as MemoryLedger['post'];

    try {
      const raced = await run(racedId, same);
      expect(raced.ledgerTxId).toBe(racedTxId);
      expect(payrollPostCalls).toBe(1);
      expect(raced.recipients).toHaveLength(2);
      expect(raced.recipients).toEqual(
        expect.arrayContaining([
          { toSpaceId: alice.id, amount: amt('40') },
          { toSpaceId: bob.id, amount: amt('25') },
        ]),
      );
      expect(await availableOf(MAKER, 'USDT')).toBe('935');
      expect(formatAmount(await bank.spaces.balanceOf(alice))).toBe('40');
      expect(formatAmount(await bank.spaces.balanceOf(bob))).toBe('25');

      const racedAgain = await run(racedId, same);
      expect(racedAgain.ledgerTxId).toBe(racedTxId);
      expect(payrollPostCalls).toBe(1);
      expect(await availableOf(MAKER, 'USDT')).toBe('935');

      const partialId = 'a1590002-0000-4000-8000-000000000002';
      const partialPosted = await pay(partialId, same);
      await seedRun(partialId, partialPosted.id, [{ toSpaceId: alice.id, amount: amt('40') }]);
      const callsAfterPartialSeed = payrollPostCalls;
      const partial = await run(partialId, same);
      expect(partial.ledgerTxId).toBe(partialPosted.id);
      expect(payrollPostCalls).toBe(callsAfterPartialSeed);
      expect(partial.recipients).toHaveLength(2);
      expect(partial.recipients).toEqual(
        expect.arrayContaining([
          { toSpaceId: alice.id, amount: amt('40') },
          { toSpaceId: bob.id, amount: amt('25') },
        ]),
      );
      expect(await availableOf(MAKER, 'USDT')).toBe('870');

      const bareId = 'a1590003-0000-4000-8000-000000000003';
      const barePosted = await pay(bareId, same);
      await seedRun(bareId, barePosted.id, []);
      const callsAfterBareSeed = payrollPostCalls;
      const bare = await run(bareId, same);
      expect(bare.ledgerTxId).toBe(barePosted.id);
      expect(payrollPostCalls).toBe(callsAfterBareSeed);
      expect(bare.recipients).toHaveLength(2);
      expect(await availableOf(MAKER, 'USDT')).toBe('805');

      const divergentId = 'a1590004-0000-4000-8000-000000000004';
      const divergentPosted = await pay(divergentId, same);
      await seedRun(divergentId, divergentPosted.id, []);
      const callsAfterDivergentSeed = payrollPostCalls;
      await expect(
        run(divergentId, [
          { toSpaceId: alice.id, amount: amt('40') },
          { toSpaceId: carol.id, amount: amt('25') },
        ]),
      ).rejects.toMatchObject({ code: 'bank.business_request_conflict' });
      expect(payrollPostCalls).toBe(callsAfterDivergentSeed);
      expect(formatAmount(await bank.spaces.balanceOf(carol))).toBe('0');
      const divergentLines = await sql<{ to_space_id: string }[]>`
        SELECT to_space_id FROM bank.business_payroll_lines WHERE payroll_id = ${divergentId}::uuid
      `;
      expect(divergentLines).toEqual([]);

      const mismatchId = 'a1590005-0000-4000-8000-000000000005';
      await seedRun(mismatchId, 'orig-partial-mismatch', [{ toSpaceId: alice.id, amount: amt('10') }]);
      const callsAfterMismatch = payrollPostCalls;
      await expect(run(mismatchId, same)).rejects.toMatchObject({ code: 'bank.business_request_conflict' });
      expect(payrollPostCalls).toBe(callsAfterMismatch);
      const mismatchLines = await sql<{ to_space_id: string }[]>`
        SELECT to_space_id FROM bank.business_payroll_lines WHERE payroll_id = ${mismatchId}::uuid
      `;
      expect(mismatchLines.map((line) => line.to_space_id)).toEqual([alice.id]);

      const callsBeforeConflicts = payrollPostCalls;
      await expect(
        run(racedId, [
          { toSpaceId: alice.id, amount: amt('40') },
          { toSpaceId: bob.id, amount: amt('30') },
        ]),
      ).rejects.toMatchObject({ code: 'bank.business_request_conflict' });
      await expect(
        run(racedId, [
          { toSpaceId: alice.id, amount: amt('40') },
          { toSpaceId: carol.id, amount: amt('25') },
        ]),
      ).rejects.toMatchObject({ code: 'bank.business_request_conflict' });
      await expect(run(racedId, same, { fromSpaceId: otherSource.id })).rejects.toMatchObject({
        code: 'bank.business_request_conflict',
      });
      await expect(run(racedId, same, { accountId: otherAccount.id })).rejects.toMatchObject({
        code: 'bank.business_request_conflict',
      });
      expect(payrollPostCalls).toBe(callsBeforeConflicts);
      expect(await availableOf(MAKER, 'USDT')).toBe('740');
      expect(formatAmount(await bank.spaces.balanceOf(alice))).toBe('160');
      expect(formatAmount(await bank.spaces.balanceOf(bob))).toBe('100');
      expect(formatAmount(await bank.spaces.balanceOf(carol))).toBe('0');
      expect(formatAmount(await bank.spaces.balanceOf(otherSource))).toBe('0');

      await sql.unsafe(`
        CREATE OR REPLACE FUNCTION bank.business_payroll_run_lines_present()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM bank.business_payroll_lines WHERE payroll_id = NEW.id
          ) THEN
            RAISE EXCEPTION 'payroll run % committed with zero lines', NEW.id;
          END IF;
          RETURN NEW;
        END;
        $$;
      `);
      await sql.unsafe(`
        CREATE CONSTRAINT TRIGGER business_payroll_run_lines_present
        AFTER INSERT ON bank.business_payroll_runs
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW
        EXECUTE FUNCTION bank.business_payroll_run_lines_present();
      `);
      try {
        const freshId = 'a1590006-0000-4000-8000-000000000006';
        const callsBeforeFresh = payrollPostCalls;
        const fresh = await run(freshId, same);
        expect(payrollPostCalls).toBe(callsBeforeFresh + 1);
        expect(fresh.ledgerTxId).toBeTruthy();
        expect(fresh.recipients).toHaveLength(2);
        expect(fresh.recipients).toEqual(
          expect.arrayContaining([
            { toSpaceId: alice.id, amount: amt('40') },
            { toSpaceId: bob.id, amount: amt('25') },
          ]),
        );
        expect(await availableOf(MAKER, 'USDT')).toBe('675');
        const again = await run(freshId, same);
        expect(again.ledgerTxId).toBe(fresh.ledgerTxId);
        expect(payrollPostCalls).toBe(callsBeforeFresh + 1);
        expect(await availableOf(MAKER, 'USDT')).toBe('675');
        expect(ledger.reconcile()).toEqual({ ok: true });
      } finally {
        await sql.unsafe(`DROP TRIGGER IF EXISTS business_payroll_run_lines_present ON bank.business_payroll_runs`);
        await sql.unsafe(`DROP FUNCTION IF EXISTS bank.business_payroll_run_lines_present()`);
      }
    } finally {
      ledger.post = origPost;
    }
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
