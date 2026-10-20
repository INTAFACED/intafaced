import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import {
  MemoryLedger,
  LedgerError,
  formatAmount,
  parseAmount,
  recipes,
  userAvailable,
  type Amount,
  type LedgerClient,
  type PostRequest,
} from '@intafaced/ledger-client';
import { createBankServices, memoryRecipientState, type BankServices } from '../bank-service.js';
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

/** The receipt shape `services/svc-bank/src/ledger-client.ts` returns from `post` and `getTxByKey`: no entries. */
function ledgerThatHidesEntries(inner: MemoryLedger): LedgerClient {
  return {
    async post(request: PostRequest) {
      const posted = await inner.post(request);
      return { ...posted, entries: [] };
    },
    balance: (ref) => inner.balance(ref),
    balances: (ownerType, ownerId) => inner.balances(ownerType, ownerId),
    getTx: (txId) => inner.getTx(txId),
    async getTxByKey(idempotencyKey) {
      const found = await inner.getTxByKey(idempotencyKey);
      return found ? { ...found, entries: [] } : null;
    },
  };
}

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
    bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), { nativeAssetId: 'IFC', recipients: memoryRecipientState() });
  });

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  it('posts under threshold without a checker', async () => {
    const account = await bank.business.createAccount({
      accountId: randomUUID(),
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
      accountId: randomUUID(),
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
      accountId: randomUUID(),
      name: 'Ops Co',
      assetId: 'USDT',
      spendThreshold: amt('100'),
      creatorUserId: MAKER,
    });
    const primary = await bank.spaces.ensurePrimary(MAKER, 'USDT');
    const pot = await bank.spaces.create({ userId: MAKER, assetId: 'USDT', name: 'Vendor' });
    const other = await bank.spaces.create({ userId: MAKER, assetId: 'USDT', name: 'Other' });
    await fund(MAKER, 'USDT', '5000');

    // Existing durable instructions control retries before any post. An
    // approved over-threshold winner names a checker who is not the maker (0029).
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
      await sql`
            INSERT INTO bank.business_approvals
              (id, account_id, maker_user_id, checker_user_id, from_space_id, to_space_id, asset_id, amount, status,
               transfer_id, hold_ledger_tx_id, ledger_tx_id, decided_at)
            VALUES (
              ${input.clientId}::uuid, ${account.id}::uuid, ${MAKER},
              ${input.existing.status === 'approved' ? CHECKER : null},
              ${primary.id}::uuid, ${input.existing.toSpaceId}::uuid,
              'USDT', ${formatAmount(input.existing.amount)}::numeric,
              ${input.existing.status}::bank.business_approval_status,
              ${input.existing.transferId ?? null}, ${input.existing.holdLedgerTxId ?? null},
              ${input.existing.ledgerTxId ?? null},
              ${input.existing.status === 'pending' ? null : new Date()}
            )
          `;
      return bank.business.proposeTransfer({
        clientId: input.clientId,
        accountId: account.id,
        makerUserId: MAKER,
        fromSpaceId: primary.id,
        toSpaceId: input.toSpaceId,
        amount: input.amount,
      });
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
      accountId: randomUUID(),
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

  async function approvalFixture() {
    const account = await bank.business.createAccount({
      accountId: randomUUID(),
      name: 'Recovery Co',
      assetId: 'USDT',
      spendThreshold: amt('100'),
      creatorUserId: MAKER,
    });
    await bank.business.addMember({ accountId: account.id, actorUserId: MAKER, userId: CHECKER, role: 'checker' });
    const primary = await bank.spaces.ensurePrimary(MAKER, 'USDT');
    const pot = await bank.spaces.create({ userId: MAKER, assetId: 'USDT', name: 'Recovery destination' });
    await fund(MAKER, 'USDT', '1000');
    return { account, primary, pot };
  }

  it('reconciles a committed settle after its acknowledgement is lost without releasing the hold', async () => {
    const { account, primary, pot } = await approvalFixture();
    const proposed = await bank.business.proposeTransfer({
      clientId: randomUUID(),
      accountId: account.id,
      makerUserId: MAKER,
      fromSpaceId: primary.id,
      toSpaceId: pot.id,
      amount: amt('250'),
    });
    if (proposed.kind !== 'pending') throw new Error('expected pending');
    const originalPost = ledger.post.bind(ledger);
    ledger.post = async (request) => {
      const posted = await originalPost(request);
      if (request.idempotencyKey.startsWith('bank.business.settle:'))
        throw new LedgerError('settle acknowledgement lost', 'ledger.unavailable');
      return posted;
    };
    const settled = await bank.business.approve({ approvalId: proposed.approval.id, checkerUserId: CHECKER });
    expect(await bank.business.approve({ approvalId: proposed.approval.id, checkerUserId: CHECKER })).toEqual(settled);
    const rows = await sql<Array<{ status: string; ledger_tx_id: string | null; rejection_code: string | null }>>`
      SELECT status, ledger_tx_id, rejection_code FROM bank.business_approvals WHERE id = ${proposed.approval.id}
    `;
    expect(rows).toEqual([{ status: 'approved', ledger_tx_id: settled.ledgerTxId, rejection_code: null }]);
    expect(await availableOf(MAKER, 'USDT')).toBe('750');
    expect(formatAmount(await bank.spaces.balanceOf(pot))).toBe('250');
    expect(ledger.journal().filter((tx) => tx.idempotencyKey === `bank.business.settle:${proposed.approval.id}`)).toHaveLength(1);
    expect(ledger.journal().some((tx) => tx.idempotencyKey.startsWith('bank.business.release:'))).toBe(false);
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it.each(['20', '250'])('claims immediate terms before a concurrent changed proposal of %s', async (conflictingAmount) => {
    const { account, primary, pot } = await approvalFixture();
    const other = await bank.spaces.create({ userId: MAKER, assetId: 'USDT', name: 'Conflicting destination' });
    const clientId = randomUUID();
    const input = { clientId, accountId: account.id, makerUserId: MAKER, fromSpaceId: primary.id, toSpaceId: pot.id, amount: amt('10') };
    const originalPost = ledger.post.bind(ledger);
    let arrived!: () => void;
    const atPost = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let pause = true;
    ledger.post = async (request) => {
      const posted = await originalPost(request);
      if (pause && request.idempotencyKey === `bank.transfer.own:${clientId}:0`) {
        pause = false;
        arrived();
        await gate;
      }
      return posted;
    };
    const first = bank.business.proposeTransfer(input);
    await atPost;
    try {
      await expect(bank.business.proposeTransfer({ ...input, toSpaceId: other.id, amount: amt(conflictingAmount) })).rejects.toMatchObject({
        code: 'bank.business_request_conflict',
      });
    } finally {
      resume();
      await first.catch(() => undefined);
    }
    const result = await first;
    expect(result.kind).toBe('posted');
    const rows = await sql<Array<{ amount: string; to_space_id: string; ledger_tx_id: string }>>`
      SELECT amount::text AS amount, to_space_id, ledger_tx_id FROM bank.business_approvals WHERE id = ${clientId}
    `;
    expect(rows).toEqual([
      { amount: '10.000000000000000000', to_space_id: pot.id, ledger_tx_id: result.kind === 'posted' ? result.ledgerTxId : '' },
    ]);
    expect(await availableOf(MAKER, 'USDT')).toBe('990');
    expect(formatAmount(await bank.spaces.balanceOf(pot))).toBe('10');
    expect(formatAmount(await bank.spaces.balanceOf(other))).toBe('0');
    expect(ledger.journal().filter((tx) => tx.idempotencyKey === `bank.transfer.own:${clientId}:0`)).toHaveLength(1);
  });

  it.each(['400', '20'])('claims over-threshold terms before a concurrent changed proposal of %s', async (conflictingAmount) => {
    const { account, primary, pot } = await approvalFixture();
    const other = await bank.spaces.create({ userId: MAKER, assetId: 'USDT', name: 'Conflicting destination' });
    const clientId = randomUUID();
    const input = { clientId, accountId: account.id, makerUserId: MAKER, fromSpaceId: primary.id, toSpaceId: pot.id, amount: amt('250') };
    const originalPost = ledger.post.bind(ledger);
    let arrived!: () => void;
    const atPost = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let pause = true;
    ledger.post = async (request) => {
      const posted = await originalPost(request);
      if (pause && request.idempotencyKey === `bank.business.hold:${clientId}`) {
        pause = false;
        arrived();
        await gate;
      }
      return posted;
    };
    const first = bank.business.proposeTransfer(input);
    await atPost;
    try {
      await expect(bank.business.proposeTransfer({ ...input, toSpaceId: other.id, amount: amt(conflictingAmount) })).rejects.toMatchObject({
        code: 'bank.business_request_conflict',
      });
    } finally {
      resume();
      await first.catch(() => undefined);
    }
    const result = await first;
    expect(result.kind).toBe('pending');
    const rows = await sql<Array<{ amount: string; to_space_id: string; hold_ledger_tx_id: string }>>`
      SELECT amount::text AS amount, to_space_id, hold_ledger_tx_id FROM bank.business_approvals WHERE id = ${clientId}
    `;
    expect(rows).toEqual([
      {
        amount: '250.000000000000000000',
        to_space_id: pot.id,
        hold_ledger_tx_id: result.kind === 'pending' ? result.approval.holdLedgerTxId : '',
      },
    ]);
    expect(await availableOf(MAKER, 'USDT')).toBe('750');
    expect(formatAmount(await bank.spaces.balanceOf(pot))).toBe('0');
    expect(formatAmount(await bank.spaces.balanceOf(other))).toBe('0');
    expect(ledger.journal().filter((tx) => tx.idempotencyKey === `bank.business.hold:${clientId}`)).toHaveLength(1);
  });

  it.each([
    { committed: true, lookupUnavailable: true },
    { committed: false, lookupUnavailable: false },
  ])('keeps an unknown settlement recoverable without releasing its hold: %j', async ({ committed, lookupUnavailable }) => {
    const { account, primary, pot } = await approvalFixture();
    const proposed = await bank.business.proposeTransfer({
      clientId: randomUUID(),
      accountId: account.id,
      makerUserId: MAKER,
      fromSpaceId: primary.id,
      toSpaceId: pot.id,
      amount: amt('250'),
    });
    if (proposed.kind !== 'pending') throw new Error('expected pending');
    const originalPost = ledger.post.bind(ledger);
    const originalLookup = ledger.getTxByKey.bind(ledger);
    ledger.post = async (request) => {
      if (request.idempotencyKey.startsWith('bank.business.settle:')) {
        if (committed) await originalPost(request);
        throw new LedgerError('unknown settlement outcome', 'ledger.unavailable');
      }
      return originalPost(request);
    };
    ledger.getTxByKey = async (key) => {
      if (lookupUnavailable) throw new LedgerError('receipt lookup unavailable', 'ledger.unavailable');
      return originalLookup(key);
    };
    await expect(bank.business.approve({ approvalId: proposed.approval.id, checkerUserId: CHECKER })).rejects.toMatchObject({
      code: 'ledger.unavailable',
    });
    const rows = await sql<Array<{ status: string; ledger_tx_id: string | null; rejection_code: string | null }>>`
        SELECT status, ledger_tx_id, rejection_code FROM bank.business_approvals WHERE id = ${proposed.approval.id}
      `;
    expect(rows).toEqual([{ status: 'approved', ledger_tx_id: null, rejection_code: null }]);
    expect(await availableOf(MAKER, 'USDT')).toBe('750');
    expect(formatAmount(await bank.spaces.balanceOf(pot))).toBe(committed ? '250' : '0');
    expect(ledger.journal().some((tx) => tx.idempotencyKey.startsWith('bank.business.release:'))).toBe(false);
    ledger.post = originalPost;
    ledger.getTxByKey = originalLookup;
    const recovered = await bank.business.approve({ approvalId: proposed.approval.id, checkerUserId: CHECKER });
    expect(await bank.business.approve({ approvalId: proposed.approval.id, checkerUserId: CHECKER })).toEqual(recovered);
    expect(formatAmount(await bank.spaces.balanceOf(pot))).toBe('250');
    expect(ledger.journal().filter((tx) => tx.idempotencyKey === `bank.business.settle:${proposed.approval.id}`)).toHaveLength(1);
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('a stale definitive rejection cannot release a settlement another retry already recorded', async () => {
    const { account, primary, pot } = await approvalFixture();
    const proposed = await bank.business.proposeTransfer({
      clientId: randomUUID(),
      accountId: account.id,
      makerUserId: MAKER,
      fromSpaceId: primary.id,
      toSpaceId: pot.id,
      amount: amt('250'),
    });
    if (proposed.kind !== 'pending') throw new Error('expected pending');
    const originalPost = ledger.post.bind(ledger);
    const originalLookup = ledger.getTxByKey.bind(ledger);
    let fail = true;
    let arrived!: () => void;
    const waiting = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    ledger.post = async (request) => {
      if (fail && request.idempotencyKey.startsWith('bank.business.settle:')) {
        fail = false;
        throw new LedgerError('settle refused', 'ledger.insufficient_funds');
      }
      return originalPost(request);
    };
    ledger.getTxByKey = async (key) => {
      if (key === `bank.business.settle:${proposed.approval.id}`) {
        arrived();
        await gate;
        return null; // The failed contender's receipt read began before the winning retry.
      }
      return originalLookup(key);
    };
    const first = bank.business.approve({ approvalId: proposed.approval.id, checkerUserId: CHECKER });
    await waiting;
    const second = await bank.business.approve({ approvalId: proposed.approval.id, checkerUserId: CHECKER });
    resume();
    expect(await first).toEqual(second);
    expect(formatAmount(await bank.spaces.balanceOf(pot))).toBe('250');
    expect(ledger.journal().filter((tx) => tx.idempotencyKey === `bank.business.settle:${proposed.approval.id}`)).toHaveLength(1);
    expect(ledger.journal().some((tx) => tx.idempotencyKey.startsWith('bank.business.release:'))).toBe(false);
  });

  it('identical concurrent immediate proposals return one verified transfer', async () => {
    const { account, primary, pot } = await approvalFixture();
    const input = {
      clientId: randomUUID(),
      accountId: account.id,
      makerUserId: MAKER,
      fromSpaceId: primary.id,
      toSpaceId: pot.id,
      amount: amt('10'),
    };
    const results = await Promise.all([bank.business.proposeTransfer(input), bank.business.proposeTransfer(input)]);
    expect(results[0]).toEqual(results[1]);
    expect(await bank.business.proposeTransfer(input)).toEqual(results[0]);
    expect(await availableOf(MAKER, 'USDT')).toBe('990');
    expect(formatAmount(await bank.spaces.balanceOf(pot))).toBe('10');
    expect(ledger.journal().filter((tx) => tx.idempotencyKey === `bank.transfer.own:${input.clientId}:0`)).toHaveLength(1);
  });

  it.each([false, true])('identical approval proposals recover an unknown hold outcome: committed=%s', async (committed) => {
    const { account, primary, pot } = await approvalFixture();
    const input = {
      clientId: randomUUID(),
      accountId: account.id,
      makerUserId: MAKER,
      fromSpaceId: primary.id,
      toSpaceId: pot.id,
      amount: amt('250'),
    };
    const originalPost = ledger.post.bind(ledger);
    ledger.post = async (request) => {
      const posted = committed ? await originalPost(request) : null;
      if (request.idempotencyKey === `bank.business.hold:${input.clientId}`)
        throw new LedgerError('hold acknowledgement lost', 'ledger.unavailable');
      return posted ?? originalPost(request);
    };
    await expect(bank.business.proposeTransfer(input)).rejects.toMatchObject({ code: 'ledger.unavailable' });
    await expect(bank.business.proposeTransfer({ ...input, amount: amt('20') })).rejects.toMatchObject({
      code: 'bank.business_request_conflict',
    });
    await expect(bank.business.approve({ approvalId: input.clientId, checkerUserId: CHECKER })).rejects.toMatchObject({
      code: 'bank.business_approval_inactive',
    });
    ledger.post = originalPost;
    const results = await Promise.all([bank.business.proposeTransfer(input), bank.business.proposeTransfer(input)]);
    expect(results[0]).toEqual(results[1]);
    expect(await bank.business.proposeTransfer(input)).toEqual(results[0]);
    expect(await availableOf(MAKER, 'USDT')).toBe('750');
    expect(ledger.journal().filter((tx) => tx.idempotencyKey === `bank.business.hold:${input.clientId}`)).toHaveLength(1);
    await bank.business.cancel({ approvalId: input.clientId, actorUserId: MAKER });
    expect(await availableOf(MAKER, 'USDT')).toBe('1000');
  });

  it.each([false, true])('cancellation releases a hold arriving after its original intent: committed=%s', async (committed) => {
    const { account, primary, pot } = await approvalFixture();
    const input = {
      clientId: randomUUID(),
      accountId: account.id,
      makerUserId: MAKER,
      fromSpaceId: primary.id,
      toSpaceId: pot.id,
      amount: amt('250'),
    };
    const originalPost = ledger.post.bind(ledger);
    let arrived!: () => void;
    const waiting = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    ledger.post = async (request) => {
      if (request.idempotencyKey !== `bank.business.hold:${input.clientId}`) return originalPost(request);
      const posted = committed ? await originalPost(request) : null;
      arrived();
      await gate;
      return posted ?? originalPost(request);
    };
    const proposing = bank.business.proposeTransfer(input);
    await waiting;
    try {
      await bank.business.cancel({ approvalId: input.clientId, actorUserId: MAKER });
    } finally {
      resume();
      await proposing.catch(() => undefined);
    }
    await expect(proposing).rejects.toMatchObject({ code: 'bank.business_approval_inactive' });
    await bank.business.cancel({ approvalId: input.clientId, actorUserId: MAKER });
    expect(await availableOf(MAKER, 'USDT')).toBe('1000');
    expect(formatAmount(await bank.spaces.balanceOf(pot))).toBe('0');
    expect(ledger.journal().filter((tx) => tx.idempotencyKey === `bank.business.hold:${input.clientId}`)).toHaveLength(1);
    expect(ledger.journal().filter((tx) => tx.idempotencyKey === `bank.business.release:${input.clientId}`)).toHaveLength(1);
  });

  it('an immediate proposal with a lost acknowledgement retains its original terms and recovers the same transfer', async () => {
    const { account, primary, pot } = await approvalFixture();
    const input = {
      clientId: randomUUID(),
      accountId: account.id,
      makerUserId: MAKER,
      fromSpaceId: primary.id,
      toSpaceId: pot.id,
      amount: amt('10'),
    };
    const originalPost = ledger.post.bind(ledger);
    ledger.post = async (request) => {
      const posted = await originalPost(request);
      if (request.idempotencyKey === `bank.transfer.own:${input.clientId}:0`)
        throw new LedgerError('transfer acknowledgement lost', 'ledger.unavailable');
      return posted;
    };
    await expect(bank.business.proposeTransfer(input)).rejects.toMatchObject({ code: 'ledger.unavailable' });
    await expect(bank.business.proposeTransfer({ ...input, amount: amt('20') })).rejects.toMatchObject({
      code: 'bank.business_request_conflict',
    });
    await expect(bank.business.approve({ approvalId: input.clientId, checkerUserId: CHECKER })).rejects.toMatchObject({
      code: 'bank.business_approval_inactive',
    });
    ledger.post = originalPost;
    const recovered = await bank.business.proposeTransfer(input);
    expect(await bank.business.proposeTransfer(input)).toEqual(recovered);
    expect(formatAmount(await bank.spaces.balanceOf(pot))).toBe('10');
    expect(ledger.journal().filter((tx) => tx.idempotencyKey === `bank.transfer.own:${input.clientId}:0`)).toHaveLength(1);
  });

  it('a legacy approval hold without a row refuses changed terms and recovers one reserved amount', async () => {
    const { account, primary, pot } = await approvalFixture();
    const input = {
      clientId: randomUUID(),
      accountId: account.id,
      makerUserId: MAKER,
      fromSpaceId: primary.id,
      toSpaceId: pot.id,
      amount: amt('250'),
    };
    const original = await ledger.post(
      recipes.businessApprovalHold({ approvalId: input.clientId, from: userAvailable(MAKER, 'USDT'), amount: input.amount }),
    );
    await expect(bank.business.proposeTransfer({ ...input, amount: amt('20') })).rejects.toMatchObject({
      code: 'bank.business_request_conflict',
    });
    expect(await sql`SELECT id FROM bank.business_approvals WHERE id = ${input.clientId}`).toHaveLength(0);
    const recovered = await bank.business.proposeTransfer(input);
    expect(recovered.kind).toBe('pending');
    if (recovered.kind !== 'pending') throw new Error('expected pending');
    expect(recovered.approval.holdLedgerTxId).toBe(original.id);
    expect(await availableOf(MAKER, 'USDT')).toBe('750');
    expect(ledger.journal().filter((tx) => tx.idempotencyKey === `bank.business.hold:${input.clientId}`)).toHaveLength(1);
    await bank.business.cancel({ approvalId: input.clientId, actorUserId: MAKER });
    expect(await availableOf(MAKER, 'USDT')).toBe('1000');
  });

  it('a legacy immediate transfer without an approval row refuses changed terms and recovers its original receipt', async () => {
    const { account, primary, pot } = await approvalFixture();
    const input = {
      clientId: randomUUID(),
      accountId: account.id,
      makerUserId: MAKER,
      fromSpaceId: primary.id,
      toSpaceId: pot.id,
      amount: amt('10'),
    };
    const original = await bank.transfers.transfer({
      transferId: input.clientId,
      fromSpaceId: primary.id,
      toSpaceId: pot.id,
      amount: input.amount,
    });
    await expect(bank.business.proposeTransfer({ ...input, amount: amt('20') })).rejects.toMatchObject({
      code: 'bank.business_request_conflict',
    });
    expect(await sql`SELECT id FROM bank.business_approvals WHERE id = ${input.clientId}`).toHaveLength(0);
    expect(await bank.business.proposeTransfer(input)).toEqual({
      kind: 'posted',
      transferId: input.clientId,
      ledgerTxId: original.ledgerTxId,
    });
    expect(ledger.journal().filter((tx) => tx.idempotencyKey === `bank.transfer.own:${input.clientId}:0`)).toHaveLength(1);
  });

  it('a failing settle posts the release once and a second approve does not settle', async () => {
    const account = await bank.business.createAccount({
      accountId: randomUUID(),
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
    let settlePosts = 0;
    let releasePosts = 0;
    ledger.post = (async (req: Parameters<MemoryLedger['post']>[0]) => {
      if (req.idempotencyKey.startsWith('bank.business.settle:')) {
        settlePosts += 1;
        throw new LedgerError('settle refused', 'ledger.insufficient_funds');
      }
      if (req.idempotencyKey.startsWith('bank.business.release:')) releasePosts += 1;
      return orig(req);
    }) as MemoryLedger['post'];

    await expect(bank.business.approve({ approvalId: proposed.approval.id, checkerUserId: CHECKER })).rejects.toThrow(
      /settle did not post and the hold was released/,
    );
    expect(settlePosts).toBe(1);
    expect(releasePosts).toBe(1);
    expect(await availableOf(MAKER, 'USDT')).toBe('1000');
    expect(formatAmount(await bank.spaces.balanceOf(pot))).toBe('0');

    const rows = await sql<Array<{ status: string; rejection_code: string | null; ledger_tx_id: string | null; amount: string }>>`
      SELECT status::text AS status, rejection_code, ledger_tx_id, amount::text AS amount
        FROM bank.business_approvals WHERE id = ${proposed.approval.id}::uuid
    `;
    expect(rows[0]?.status).toBe('rejected');
    expect(rows[0]?.rejection_code).toBe('bank.business_settle_unposted');
    expect(rows[0]?.ledger_tx_id).toBeNull();
    expect(formatAmount(parseAmount(rows[0]!.amount))).toBe('250');

    await expect(bank.business.approve({ approvalId: proposed.approval.id, checkerUserId: CHECKER })).rejects.toMatchObject({
      code: 'bank.business_approval_inactive',
    });
    expect(settlePosts).toBe(1);
    expect(releasePosts).toBe(1);
    const released = ledger.journal().filter((tx) => tx.idempotencyKey === `bank.business.release:${proposed.approval.id}`);
    expect(released).toHaveLength(1);
    expect(released[0]!.entries.map((entry) => formatAmount(entry.amount))).toEqual(['250', '250']);
    expect(ledger.journal().filter((tx) => tx.reason === 'bank.business.approval.settled')).toHaveLength(0);
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('a release that throws after a failed settle leaves the row unapproved and a later approve does not settle', async () => {
    const account = await bank.business.createAccount({
      accountId: randomUUID(),
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
    let settlePosts = 0;
    let releasePosts = 0;
    ledger.post = (async (req: Parameters<MemoryLedger['post']>[0]) => {
      if (req.idempotencyKey.startsWith('bank.business.settle:')) {
        settlePosts += 1;
        throw new LedgerError('settle refused', 'ledger.insufficient_funds');
      }
      if (req.idempotencyKey.startsWith('bank.business.release:')) {
        releasePosts += 1;
        throw new Error('release down');
      }
      return orig(req);
    }) as MemoryLedger['post'];

    await expect(bank.business.approve({ approvalId: proposed.approval.id, checkerUserId: CHECKER })).rejects.toThrow(/release down/);
    expect(settlePosts).toBe(1);
    expect(releasePosts).toBe(1);
    expect(await availableOf(MAKER, 'USDT')).toBe('750');

    const rows = await sql<Array<{ status: string; rejection_code: string | null; ledger_tx_id: string | null }>>`
      SELECT status::text AS status, rejection_code, ledger_tx_id
        FROM bank.business_approvals WHERE id = ${proposed.approval.id}::uuid
    `;
    expect(rows[0]?.status).not.toBe('approved');
    expect(rows[0]?.status).toBe('rejected');
    expect(rows[0]?.rejection_code).toBe('bank.business_settle_unposted');
    expect(rows[0]?.ledger_tx_id).toBeNull();

    await expect(bank.business.approve({ approvalId: proposed.approval.id, checkerUserId: CHECKER })).rejects.toMatchObject({
      code: 'bank.business_approval_inactive',
    });
    expect(settlePosts).toBe(1);
    expect(releasePosts).toBe(1);
    expect(ledger.journal().filter((tx) => tx.reason === 'bank.business.approval.settled')).toHaveLength(0);
    expect(ledger.journal().filter((tx) => tx.idempotencyKey === `bank.business.release:${proposed.approval.id}`)).toHaveLength(0);
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('a release that dies after reject returns the hold on the next reject', async () => {
    const account = await bank.business.createAccount({
      accountId: randomUUID(),
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
      accountId: randomUUID(),
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
      accountId: randomUUID(),
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
      accountId: randomUUID(),
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
      accountId: randomUUID(),
      name: 'Ops Co',
      assetId: 'USDT',
      spendThreshold: amt('100'),
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
      accountId: randomUUID(),
      name: 'Ops Co',
      assetId: 'USDT',
      spendThreshold: amt('100'),
      creatorUserId: MAKER,
    });
    const otherAccount = await bank.business.createAccount({
      accountId: randomUUID(),
      name: 'Other Co',
      assetId: 'USDT',
      spendThreshold: amt('100'),
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
            to:
              line.toSpaceId === alice.id
                ? accountForSpace(alice)
                : line.toSpaceId === bob.id
                  ? accountForSpace(bob)
                  : accountForSpace(carol),
            amount: line.amount,
          })),
        }),
      );
    const seedRun = async (payrollId: string, ledgerTxId: string, lines: ReadonlyArray<{ toSpaceId: string; amount: Amount }>) => {
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
      expect(payrollPostCalls).toBe(2);
      expect(await availableOf(MAKER, 'USDT')).toBe('935');

      const partialId = 'a1590002-0000-4000-8000-000000000002';
      const partialPosted = await pay(partialId, same);
      await seedRun(partialId, partialPosted.id, [{ toSpaceId: alice.id, amount: amt('40') }]);
      const callsAfterPartialSeed = payrollPostCalls;
      const partial = await run(partialId, same);
      expect(partial.ledgerTxId).toBe(partialPosted.id);
      expect(payrollPostCalls).toBe(callsAfterPartialSeed + 1);
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
      expect(payrollPostCalls).toBe(callsAfterBareSeed + 1);
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
      expect(payrollPostCalls).toBe(callsAfterDivergentSeed + 1);
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
        expect(payrollPostCalls).toBe(callsBeforeFresh + 2);
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

  it('records a payroll when the ledger client returns no entries', async () => {
    const inner = new MemoryLedger();
    const hidden = ledgerThatHidesEntries(inner);
    const bankStub = createBankServices(sql, hidden, memoryLedgerHistory(inner), {
      nativeAssetId: 'IFC',
      recipients: memoryRecipientState(),
    });
    const account = await bankStub.business.createAccount({
      accountId: randomUUID(),
      name: 'Ops Co',
      assetId: 'USDT',
      spendThreshold: amt('100'),
      creatorUserId: MAKER,
    });
    const primary = await bankStub.spaces.ensurePrimary(MAKER, 'USDT');
    const alice = await bankStub.spaces.ensurePrimary(CHECKER, 'USDT');
    const bob = await bankStub.spaces.create({ userId: MAKER, assetId: 'USDT', name: 'Contractor' });
    await inner.post(
      recipes.deposit({
        userId: MAKER,
        assetId: 'USDT',
        amount: amt('1000'),
        rail: 'test',
        railRef: 'stub-payroll-fund',
      }),
    );
    const available = async () => formatAmount((await inner.balance(userAvailable(MAKER, 'USDT'))).amount);
    const movements = (payrollId: string) =>
      inner.journal().filter((tx) => tx.idempotencyKey === `bank.business.payroll:${payrollId}`).length;
    const same = [
      { toSpaceId: alice.id, amount: amt('40') },
      { toSpaceId: bob.id, amount: amt('25') },
    ];
    const run = (payrollId: string, recipients: ReadonlyArray<{ toSpaceId: string; amount: Amount }>) =>
      bankStub.business.runPayroll({
        payrollId,
        accountId: account.id,
        actorUserId: MAKER,
        fromSpaceId: primary.id,
        recipients,
      });
    const book = (payrollId: string) =>
      inner.post(
        recipes.businessPayroll({
          payrollId,
          from: accountForSpace(primary),
          recipients: [
            { to: accountForSpace(alice), amount: amt('40') },
            { to: accountForSpace(bob), amount: amt('25') },
          ],
        }),
      );

    const payId = 'a1590011-0000-4000-8000-000000000011';
    const paid = await run(payId, same);
    expect(paid.ledgerTxId).toBeTruthy();
    expect(paid.recipients).toHaveLength(2);
    expect(paid.recipients).toEqual(
      expect.arrayContaining([
        { toSpaceId: alice.id, amount: amt('40') },
        { toSpaceId: bob.id, amount: amt('25') },
      ]),
    );
    expect(await available()).toBe('935');
    expect(formatAmount(await bankStub.spaces.balanceOf(alice))).toBe('40');
    expect(formatAmount(await bankStub.spaces.balanceOf(bob))).toBe('25');
    expect(movements(payId)).toBe(1);

    const again = await run(payId, same);
    expect(again.ledgerTxId).toBe(paid.ledgerTxId);
    expect(movements(payId)).toBe(1);
    expect(await available()).toBe('935');

    const partialId = 'a1590012-0000-4000-8000-000000000012';
    const partialPosted = await book(partialId);
    await sql`
      INSERT INTO bank.business_payroll_runs
        (id, account_id, actor_user_id, from_space_id, asset_id, ledger_tx_id)
      VALUES (
        ${partialId}::uuid, ${account.id}::uuid, ${MAKER},
        ${primary.id}::uuid, 'USDT', ${partialPosted.id}
      )
    `;
    await sql`
      INSERT INTO bank.business_payroll_lines (payroll_id, to_space_id, amount)
      VALUES (${partialId}::uuid, ${alice.id}::uuid, ${formatAmount(amt('40'))}::numeric)
    `;
    const partial = await run(partialId, same);
    expect(partial.ledgerTxId).toBe(partialPosted.id);
    expect(partial.recipients).toHaveLength(2);
    expect(partial.recipients).toEqual(
      expect.arrayContaining([
        { toSpaceId: alice.id, amount: amt('40') },
        { toSpaceId: bob.id, amount: amt('25') },
      ]),
    );
    expect(movements(partialId)).toBe(1);
    expect(await available()).toBe('870');

    const shortId = 'a1590013-0000-4000-8000-000000000013';
    const shortPosted = await book(shortId);
    await sql`
      INSERT INTO bank.business_payroll_runs
        (id, account_id, actor_user_id, from_space_id, asset_id, ledger_tx_id)
      VALUES (
        ${shortId}::uuid, ${account.id}::uuid, ${MAKER},
        ${primary.id}::uuid, 'USDT', ${shortPosted.id}
      )
    `;
    await sql`
      INSERT INTO bank.business_payroll_lines (payroll_id, to_space_id, amount)
      VALUES (${shortId}::uuid, ${alice.id}::uuid, ${formatAmount(amt('40'))}::numeric)
    `;
    // The booked payment pays alice AND bob; this retry names only alice. The ledger refuses a reused
    // key with a different body, so a client that hides entries can no longer paper over it (this used
    // to return the booked tx and record one recipient while the ledger had paid two).
    await expect(run(shortId, [{ toSpaceId: alice.id, amount: amt('40') }])).rejects.toMatchObject({
      code: 'bank.business_request_conflict',
    });
    expect(movements(shortId)).toBe(1);
    const shortLines = await sql<{ to_space_id: string }[]>`
      SELECT to_space_id FROM bank.business_payroll_lines WHERE payroll_id = ${shortId}::uuid ORDER BY to_space_id
    `;
    expect(shortLines.map((line) => line.to_space_id)).toEqual([alice.id]);

    const raceId = 'a1590014-0000-4000-8000-000000000014';
    const origPost = hidden.post.bind(hidden);
    let racedTx = '';
    hidden.post = (async (req: PostRequest) => {
      const posted = await origPost(req);
      if (req.idempotencyKey === `bank.business.payroll:${raceId}` && !racedTx) {
        racedTx = posted.id;
        await sql`
          INSERT INTO bank.business_payroll_runs
            (id, account_id, actor_user_id, from_space_id, asset_id, ledger_tx_id)
          VALUES (
            ${raceId}::uuid, ${account.id}::uuid, ${MAKER},
            ${primary.id}::uuid, 'USDT', ${posted.id}
          )
        `;
      }
      return posted;
    }) as LedgerClient['post'];
    try {
      const raced = await run(raceId, same);
      expect(raced.ledgerTxId).toBe(racedTx);
      expect(raced.recipients).toHaveLength(2);
      expect(movements(raceId)).toBe(1);
    } finally {
      hidden.post = origPost;
    }

    const replayId = 'a1590015-0000-4000-8000-000000000015';
    await sql.unsafe(`DROP TRIGGER IF EXISTS payroll_run_fail_first ON bank.business_payroll_runs`);
    await sql.unsafe(`DROP FUNCTION IF EXISTS bank.payroll_run_fail_first()`);
    await sql.unsafe(`DROP SEQUENCE IF EXISTS bank.payroll_run_attempt_l159`);
    await sql.unsafe(`CREATE SEQUENCE bank.payroll_run_attempt_l159`);
    await sql.unsafe(`
      CREATE OR REPLACE FUNCTION bank.payroll_run_fail_first()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF nextval('bank.payroll_run_attempt_l159') = 1 THEN
          RAISE EXCEPTION 'run insert rolled back';
        END IF;
        RETURN NEW;
      END;
      $$;
    `);
    await sql.unsafe(`DROP TRIGGER IF EXISTS payroll_run_fail_first ON bank.business_payroll_runs`);
    await sql.unsafe(`
      CREATE TRIGGER payroll_run_fail_first
      BEFORE INSERT ON bank.business_payroll_runs
      FOR EACH ROW
      EXECUTE FUNCTION bank.payroll_run_fail_first();
    `);
    try {
      await expect(run(replayId, same)).rejects.toThrow(/run insert rolled back/);
      const replayed = await run(replayId, same);
      expect(replayed.ledgerTxId).toBeTruthy();
      expect(replayed.recipients).toHaveLength(2);
      expect(replayed.recipients).toEqual(
        expect.arrayContaining([
          { toSpaceId: alice.id, amount: amt('40') },
          { toSpaceId: bob.id, amount: amt('25') },
        ]),
      );
      expect(movements(replayId)).toBe(1);
      expect(await available()).toBe('675');
    } finally {
      await sql.unsafe(`DROP TRIGGER IF EXISTS payroll_run_fail_first ON bank.business_payroll_runs`);
      await sql.unsafe(`DROP FUNCTION IF EXISTS bank.payroll_run_fail_first()`);
      await sql.unsafe(`DROP SEQUENCE IF EXISTS bank.payroll_run_attempt_l159`);
    }
  });

  it('a shorter payroll conflicts when the booked payment still includes the dropped recipient', async () => {
    const account = await bank.business.createAccount({
      accountId: randomUUID(),
      name: 'Ops Co',
      assetId: 'USDT',
      spendThreshold: amt('100'),
      creatorUserId: MAKER,
    });
    const primary = await bank.spaces.ensurePrimary(MAKER, 'USDT');
    const alice = await bank.spaces.ensurePrimary(CHECKER, 'USDT');
    const bob = await bank.spaces.create({ userId: MAKER, assetId: 'USDT', name: 'Contractor' });
    await fund(MAKER, 'USDT', '1000');
    const payrollId = 'a1590016-0000-4000-8000-000000000016';
    const posted = await ledger.post(
      recipes.businessPayroll({
        payrollId,
        from: accountForSpace(primary),
        recipients: [
          { to: accountForSpace(alice), amount: amt('40') },
          { to: accountForSpace(bob), amount: amt('25') },
        ],
      }),
    );
    await sql`
      INSERT INTO bank.business_payroll_runs
        (id, account_id, actor_user_id, from_space_id, asset_id, ledger_tx_id)
      VALUES (
        ${payrollId}::uuid, ${account.id}::uuid, ${MAKER},
        ${primary.id}::uuid, 'USDT', ${posted.id}
      )
    `;
    await sql`
      INSERT INTO bank.business_payroll_lines (payroll_id, to_space_id, amount)
      VALUES (${payrollId}::uuid, ${alice.id}::uuid, ${formatAmount(amt('40'))}::numeric)
    `;

    await expect(
      bank.business.runPayroll({
        payrollId,
        accountId: account.id,
        actorUserId: MAKER,
        fromSpaceId: primary.id,
        recipients: [{ toSpaceId: alice.id, amount: amt('40') }],
      }),
    ).rejects.toMatchObject({ code: 'bank.business_request_conflict' });

    const lines = await sql<{ to_space_id: string }[]>`
      SELECT to_space_id FROM bank.business_payroll_lines WHERE payroll_id = ${payrollId}::uuid ORDER BY to_space_id
    `;
    expect(lines.map((line) => line.to_space_id)).toEqual([alice.id]);
    expect(await availableOf(MAKER, 'USDT')).toBe('935');
    expect(formatAmount(await bank.spaces.balanceOf(alice))).toBe('40');
    expect(formatAmount(await bank.spaces.balanceOf(bob))).toBe('25');
    expect(ledger.journal().filter((tx) => tx.idempotencyKey === `bank.business.payroll:${payrollId}`)).toHaveLength(1);
  });

  it('refuses mixed-asset payroll as rate unset — never invents FX', async () => {
    const account = await bank.business.createAccount({
      accountId: randomUUID(),
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

  it('refuses an over-threshold payroll from one admin or maker and still posts under it', async () => {
    const account = await bank.business.createAccount({
      accountId: randomUUID(),
      name: 'Ops Co',
      assetId: 'USDT',
      spendThreshold: amt('100'),
      creatorUserId: MAKER,
    });
    await bank.business.addMember({
      accountId: account.id,
      actorUserId: MAKER,
      userId: CHECKER,
      role: 'maker',
    });
    const adminFrom = await bank.spaces.ensurePrimary(MAKER, 'USDT');
    const makerFrom = await bank.spaces.ensurePrimary(CHECKER, 'USDT');
    const alice = await bank.spaces.create({ userId: MAKER, assetId: 'USDT', name: 'Alice' });
    const bob = await bank.spaces.create({ userId: MAKER, assetId: 'USDT', name: 'Bob' });
    await fund(MAKER, 'USDT', '500');
    await fund(CHECKER, 'USDT', '500');
    const payrollOrHold = () =>
      ledger
        .journal()
        .filter((tx) => tx.idempotencyKey.startsWith('bank.business.payroll:') || tx.idempotencyKey.startsWith('bank.business.hold:'));

    await expect(
      bank.business.runPayroll({
        payrollId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        accountId: account.id,
        actorUserId: MAKER,
        fromSpaceId: adminFrom.id,
        recipients: [
          { toSpaceId: alice.id, amount: amt('60') },
          { toSpaceId: bob.id, amount: amt('40') },
        ],
      }),
    ).rejects.toMatchObject({
      code: 'bank.business_self_approve',
      message: expect.stringMatching(/dual control is required/i),
    });

    await expect(
      bank.business.runPayroll({
        payrollId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        accountId: account.id,
        actorUserId: CHECKER,
        fromSpaceId: makerFrom.id,
        recipients: [{ toSpaceId: alice.id, amount: amt('100') }],
      }),
    ).rejects.toMatchObject({
      code: 'bank.business_self_approve',
      message: expect.stringMatching(/dual control is required/i),
    });

    expect(await availableOf(MAKER, 'USDT')).toBe('500');
    expect(await availableOf(CHECKER, 'USDT')).toBe('500');
    expect(formatAmount(await bank.spaces.balanceOf(alice))).toBe('0');
    expect(formatAmount(await bank.spaces.balanceOf(bob))).toBe('0');
    expect(payrollOrHold()).toHaveLength(0);
    const approvals = await sql<{ id: string }[]>`SELECT id FROM bank.business_approvals`;
    const runs = await sql<{ id: string }[]>`SELECT id FROM bank.business_payroll_runs`;
    expect(approvals).toHaveLength(0);
    expect(runs).toHaveLength(0);

    const under = await bank.business.runPayroll({
      payrollId: 'abababab-abab-4bab-8bab-abababababab',
      accountId: account.id,
      actorUserId: MAKER,
      fromSpaceId: adminFrom.id,
      recipients: [
        { toSpaceId: alice.id, amount: amt('40') },
        { toSpaceId: bob.id, amount: amt('25') },
      ],
    });
    expect(under.ledgerTxId).toBeTruthy();
    expect(await availableOf(MAKER, 'USDT')).toBe('435');
    expect(await availableOf(CHECKER, 'USDT')).toBe('500');
    expect(formatAmount(await bank.spaces.balanceOf(alice))).toBe('40');
    expect(formatAmount(await bank.spaces.balanceOf(bob))).toBe('25');
    expect(ledger.journal().filter((tx) => tx.idempotencyKey.startsWith('bank.business.payroll:'))).toHaveLength(1);
    expect(ledger.journal().filter((tx) => tx.idempotencyKey.startsWith('bank.business.hold:'))).toHaveLength(0);
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('refuses an empty payroll', async () => {
    const account = await bank.business.createAccount({
      accountId: randomUUID(),
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
      accountId: randomUUID(),
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
