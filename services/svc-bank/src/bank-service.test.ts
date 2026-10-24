import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { describe, expect, it, beforeAll, beforeEach, afterAll } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import {
  LedgerError,
  MemoryLedger,
  earnPoolReserve,
  earnStakeAccount,
  formatAmount,
  houseFees,
  parseAmount as amt,
  recipes,
  subAccountAvailable,
  userAvailable,
  userStake,
  type LedgerClient,
} from '@intafaced/ledger-client';
import { createBankServices, memoryRecipientState, type BankServices } from './bank-service.js';
import { createBankRouter } from './router.js';
import { accountForSpace } from './spaces/space-service.js';
import { memoryLedgerHistory } from './analytics/ledger-history.js';
import { occurrenceStart, planDue, dueOccurrence } from './transfers/schedule.js';
import { PAUSED_SKIP_REASON } from './transfers/transfer-service.js';
import { dailyInterest, planAccrual } from './earn/interest.js';
import { categorise } from './analytics/spend.js';
import { BankError } from './errors.js';

/**
 * svc-bank money paths.
 *
 * The ledger here is `MemoryLedger` — the reference implementation, which the
 * conformance suite proves behaves identically to svc-ledger's Postgres engine
 * (§4.4). That equivalence is what makes it legitimate here: these tests are
 * about svc-bank's recipes, ordering and idempotency, not about the ledger.
 *
 * Postgres is real, because the claim-row / ledger interaction is exactly where
 * a double-fire bug would hide.
 *
 * The tRPC boundary is exercised at the bottom of this file rather than in a
 * `router.test.ts` of its own. The reason used to be a constraint: svc-bank's
 * SQL is schema-qualified (`bank.spaces`), so `createTestDb`'s per-suite schema
 * could not isolate it the way it isolates svc-ledger, and two files truncating
 * the shared `bank` schema in parallel `beforeEach` hooks raced each other.
 *
 * That constraint is gone. `createTestDatabase` isolates by DATABASE, so the
 * schema keeps its real name and a second file would get its own `bank.spaces`
 * to truncate. Splitting the router out is now merely a choice nobody has had a
 * reason to make — not something the harness forbids.
 *
 * H8a PG-hard: this file never `describe.skip` / `postgresAvailable`. CI uses
 * TEST_DATABASE_URL (per-run database via `createTestDatabase` so schema-qualified
 * `bank.*` SQL stays on `bank`). Local without that env starts Testcontainers
 * `postgres:16-alpine`. Docker/PG down is a failed suite, not a green skip.
 * The admin URL is `TEST_DATABASE_URL`, not `TEST_DATABASE_URL_BANK`: creating a
 * database needs CREATEDB, which the per-service roles deliberately lack.
 */

const here = dirname(fileURLToPath(import.meta.url));

/** Every forward migration, in order — read from disk so a new one is exercised the moment it lands. */
const drizzle = join(here, '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const USER_C = '33333333-3333-4333-8333-333333333333';
/** An id identity does not know: the only kind of "missing" recipient there is. */
const NO_SUCH_USER = '77777777-7777-4777-8777-777777777777';

const DAY_MS = 24 * 60 * 60 * 1000;

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
      `H8a: svc-bank money is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

describe('svc-bank money (source)', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

/**
 * One `information_schema.columns` row. Precision and scale are type metadata,
 * not a money amount.
 */
type BankSchemaColumn = {
  table_name: string;
  column_name: string;
  data_type: string;
  numeric_precision: number | null;
  numeric_scale: number | null;
};

function bankColumnRef(column: Pick<BankSchemaColumn, 'table_name' | 'column_name'>): string {
  return `${column.table_name}.${column.column_name}`;
}

type MoneyColumnGuardResult = {
  ok: boolean;
  illegalType: string[];
  wrongScale: string[];
  undeclared: string[];
  missing: string[];
};

const ILLEGAL_MONEY_DATA_TYPES = new Set(['double precision', 'real', 'money']);

/**
 * Columns the schema guard treats as money, judged against the allowlist.
 * Legal money is `numeric(38,18)` and named on the allowlist. `double precision`,
 * `real`, and `money` fail even when named there. `numeric(38)` at any other
 * scale fails even when named there.
 */
function moneyColumnGuard(columns: readonly BankSchemaColumn[], allowlist: Readonly<Record<string, string>>): MoneyColumnGuardResult {
  const illegalType = columns.filter((column) => ILLEGAL_MONEY_DATA_TYPES.has(column.data_type)).map(bankColumnRef);
  const wrongScale = columns
    .filter((column) => column.data_type === 'numeric' && column.numeric_precision === 38 && column.numeric_scale !== 18)
    .map(bankColumnRef);
  const exact = columns
    .filter((column) => column.data_type === 'numeric' && column.numeric_precision === 38 && column.numeric_scale === 18)
    .map(bankColumnRef);
  const undeclared = exact.filter((name) => !(name in allowlist));
  const present = new Set(exact);
  const missing = Object.keys(allowlist).filter((name) => !present.has(name));
  return {
    ok: illegalType.length === 0 && wrongScale.length === 0 && undeclared.length === 0 && missing.length === 0,
    illegalType,
    wrongScale,
    undeclared,
    missing,
  };
}

function moneyScaleFixtureRow(
  column_name: string,
  data_type: string,
  numeric_precision: number | null,
  numeric_scale: number | null,
): BankSchemaColumn {
  return { table_name: 'fixture', column_name, data_type, numeric_precision, numeric_scale };
}

/** In-memory column rows. Nothing here is created in the bank schema. */
function moneyScaleFixtureReport(): Record<string, { ok: boolean; illegalType: string[]; wrongScale: string[] }> {
  const allowlist: Record<string, string> = {
    'fixture.kept': 'an allowlisted numeric(38,18) column',
  };
  const kept = moneyScaleFixtureRow('kept', 'numeric', 38, 18);
  const judge = (columns: readonly BankSchemaColumn[]) => {
    const result = moneyColumnGuard(columns, allowlist);
    return { ok: result.ok, illegalType: result.illegalType, wrongScale: result.wrongScale };
  };
  return {
    'numeric(38,18)': judge([kept]),
    'double precision': judge([kept, moneyScaleFixtureRow('slipped', 'double precision', 53, null)]),
    real: judge([kept, moneyScaleFixtureRow('slipped', 'real', 24, null)]),
    money: judge([kept, moneyScaleFixtureRow('slipped', 'money', null, null)]),
    'numeric(38) scale not 18': judge([moneyScaleFixtureRow('kept', 'numeric', 38, 0)]),
  };
}

describe('svc-bank money PG-hard', () => {
  // 0002 is in the list so THE SCHEMA GUARD BELOW SEES THE LOAN TABLES: what
  // this file owns is the money-column allowlist, and a guard that cannot see
  // half the schema is not guarding it.
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase;
  let sql: TestDatabase['sql'];

  let ledger: MemoryLedger;
  let bank: BankServices;
  let router: ReturnType<typeof createBankRouter>;

  /** Put real value in a user's available balance, the way a deposit would. */
  async function fund(userId: string, assetId: string, value: string) {
    await ledger.post(
      recipes.deposit({ userId, assetId, amount: amt(value), rail: 'test', railRef: `${userId}:${assetId}:${Math.random()}` }),
    );
  }

  /** Accrue bank fee revenue, which is what funds an earn pool's reserve. */
  async function accrueBankFees(assetId: string, value: string) {
    const payer = '99999999-9999-4999-8999-999999999999';
    await fund(payer, assetId, value);
    await ledger.post(
      recipes.feeCharge({
        chargeId: `bank:${Math.random()}`,
        userId: payer,
        module: 'bank',
        mode: 'asset',
        assetId,
        amount: amt(value),
      }),
    );
  }

  const availableOf = async (userId: string, assetId: string) =>
    formatAmount((await ledger.balance(userAvailable(userId, assetId))).amount);
  const stakedOf = async (userId: string, assetId: string) => {
    const all = await ledger.balances('user', userId);
    const total = all.filter((b) => b.account.kind === 'stake' && b.account.assetId === assetId).reduce((acc, b) => acc + b.amount, 0n);
    return formatAmount(total);
  };

  beforeEach(async () => {
    await sql`
      TRUNCATE bank.business_payroll_lines, bank.business_payroll_runs,
               bank.business_approvals, bank.business_members, bank.business_accounts,
               bank.auto_invest_runs, bank.auto_invest_rules,
               bank.interest_accruals, bank.earn_positions, bank.earn_pools,
               bank.transfer_executions, bank.scheduled_transfers, bank.spaces,
               bank.card_cashback, bank.card_settlements, bank.card_authorizations, bank.cards,
               bank.ramp_offramps, bank.ramp_onramps, bank.user_withdraw_destinations
      RESTART IDENTITY CASCADE
    `;
    ledger = new MemoryLedger();
    bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      // A labelled TEST space limit, so the router's create and restore doors are open in this suite.
      spaceLimit: '50',
      nativeAssetId: 'IFC',
      recipients: memoryRecipientState({ [NO_SUCH_USER]: 'not_found' }),
    });
    router = createBankRouter(bank);
  }, 30_000);

  beforeAll(async () => {
    const admin = await openH8aAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'bank', url: admin.url, migrations });
    sql = db.sql;
  }, 120_000);

  /**
   * 30s, not vitest's default 10s. Dropping a DATABASE is heavier than closing a
   * pool, and when several suite files tear down at the same moment Postgres
   * serialises the drops. The work still finishes well inside this; the default
   * was sized for `sql.end()`, which is all this hook used to do.
   */
  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  // ══ Spaces ════════════════════════════════════════════════════════════════

  describe('spaces are views, not balances', () => {
    it('maps the primary space to the user own available ledger account', async () => {
      const primary = await bank.spaces.ensurePrimary(USER_A, 'USDT');
      expect(accountForSpace(primary)).toEqual(userAvailable(USER_A, 'USDT'));
    });

    it('maps a named space to its own subaccount ledger account', async () => {
      const space = await bank.spaces.create({ userId: USER_A, assetId: 'USDT', name: 'Rent' });
      expect(accountForSpace(space)).toEqual(subAccountAvailable(space.id, 'USDT'));
    });

    it('reports exactly the ledger balance for the primary space', async () => {
      const primary = await bank.spaces.ensurePrimary(USER_A, 'USDT');
      await fund(USER_A, 'USDT', '1250.5');

      const fromService = formatAmount(await bank.spaces.balanceOf(primary));
      const fromLedger = formatAmount((await ledger.balance(userAvailable(USER_A, 'USDT'))).amount);

      expect(fromService).toBe(fromLedger);
      expect(fromService).toBe('1250.5');
    });

    it('keeps only one primary space per user per asset under concurrency', async () => {
      const results = await Promise.all(Array.from({ length: 6 }, () => bank.spaces.ensurePrimary(USER_A, 'EUR')));
      const ids = new Set(results.map((s) => s.id));
      expect(ids.size).toBe(1);

      const rows = await sql`SELECT id FROM bank.spaces WHERE user_id = ${USER_A} AND asset_id = 'EUR' AND kind = 'primary'`;
      expect(rows).toHaveLength(1);
    });

    it('supports many assets for one user — the multi-currency surface', async () => {
      for (const asset of ['USDT', 'EUR', 'BTC']) {
        await bank.spaces.ensurePrimary(USER_A, asset);
        await fund(USER_A, asset, '10');
      }
      const overview = await bank.spaces.overview(USER_A, undefined, 50);
      expect(overview.map((s) => s.assetId).sort()).toEqual(['BTC', 'EUR', 'USDT']);
      expect(overview.every((s) => s.balance === '10')).toBe(true);
    });

    it('surfaces assets the user holds but has never named', async () => {
      await bank.spaces.ensurePrimary(USER_A, 'USDT');
      await fund(USER_A, 'USDT', '5');
      await fund(USER_A, 'BTC', '0.25');

      const unnamed = await bank.spaces.unnamedAssets(USER_A);
      expect(unnamed).toEqual([{ assetId: 'BTC', balance: '0.25' }]);
    });

    it('lists the main account of every asset the user holds, even when the money never came through the bank', async () => {
      // A deposit or a fill credits the user's main account directly; no space row exists for it yet.
      await fund(USER_A, 'USDT', '100');
      await fund(USER_A, 'BTC', '0.25');
      const overview = await bank.spaces.overview(USER_A, undefined, 50);
      expect(overview.map((s) => [s.assetId, s.kind, s.balance])).toEqual([
        ['BTC', 'primary', '0.25'],
        ['USDT', 'primary', '100'],
      ]);
      expect(await bank.spaces.overview(USER_A, undefined, 50)).toHaveLength(2);
      expect(await sql`SELECT id FROM bank.spaces WHERE user_id = ${USER_A}`).toHaveLength(2);
      // Asking for one asset opens only that one; an asset with nothing in it opens nothing.
      await fund(USER_B, 'USDT', '1');
      await fund(USER_B, 'EUR', '2');
      expect((await bank.spaces.overview(USER_B, 'USDT', 50)).map((s) => s.assetId)).toEqual(['USDT']);
      expect(await bank.spaces.findPrimary(USER_B, 'EUR')).toBeNull();
      expect(await bank.spaces.overview(USER_C, undefined, 50)).toEqual([]);
      // No value moved: labels only.
      expect(ledger.totalsByAsset().USDT).toBe('0');
    });

    it('archiving a space moves no value', async () => {
      const primary = await bank.spaces.ensurePrimary(USER_A, 'USDT');
      const pot = await bank.spaces.create({ userId: USER_A, assetId: 'USDT', name: 'Holiday' });
      await fund(USER_A, 'USDT', '100');
      await bank.transfers.transfer({ transferId: 'seed-holiday-1', fromSpaceId: primary.id, toSpaceId: pot.id, amount: amt('40') });

      await bank.spaces.archive(pot.id);

      expect(formatAmount((await ledger.balance(subAccountAvailable(pot.id, 'USDT'))).amount)).toBe('40');
      expect(ledger.totalsByAsset().USDT).toBe('0');
    });

    it('refuses to archive the primary space — it is the account itself', async () => {
      const primary = await bank.spaces.ensurePrimary(USER_A, 'USDT');
      await expect(bank.spaces.archive(primary.id)).rejects.toMatchObject({ code: 'bank.space_archived' });
    });

    it('archive of a funded named space leaves the subaccount balance and closes the books', async () => {
      const primary = await bank.spaces.ensurePrimary(USER_A, 'USDT');
      const pot = await bank.spaces.create({ userId: USER_A, assetId: 'USDT', name: 'Holiday' });
      await fund(USER_A, 'USDT', '100');
      await bank.transfers.transfer({ transferId: 'seed-holiday-archive', fromSpaceId: primary.id, toSpaceId: pot.id, amount: amt('40') });

      const posts = ledger.journal().length;
      await bank.spaces.archive(pot.id);

      expect(ledger.journal().length).toBe(posts);
      expect(formatAmount((await ledger.balance(subAccountAvailable(pot.id, 'USDT'))).amount)).toBe('40');
      expect(await availableOf(USER_A, 'USDT')).toBe('60');
      expect(ledger.totalsByAsset().USDT).toBe('0');
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('overview still returns an archived named space while its balance is greater than zero', async () => {
      const primary = await bank.spaces.ensurePrimary(USER_A, 'USDT');
      const pot = await bank.spaces.create({ userId: USER_A, assetId: 'USDT', name: 'Holiday' });
      await fund(USER_A, 'USDT', '100');
      await bank.transfers.transfer({ transferId: 'seed-holiday-visible', fromSpaceId: primary.id, toSpaceId: pot.id, amount: amt('40') });
      await bank.spaces.archive(pot.id);

      const overview = await bank.spaces.overview(USER_A, undefined, 50);
      const visible = overview.find((space) => space.id === pot.id);
      expect(visible).toMatchObject({ name: 'Holiday', balance: '40', kind: 'named' });
      expect(visible?.archivedAt).toBeInstanceOf(Date);
      expect(typeof visible?.balance).toBe('string');
    });

    it('overview omits an archived named space whose balance is zero', async () => {
      await bank.spaces.ensurePrimary(USER_A, 'USDT');
      const empty = await bank.spaces.create({ userId: USER_A, assetId: 'USDT', name: 'Empty jar' });
      await bank.spaces.archive(empty.id);

      const overview = await bank.spaces.overview(USER_A, undefined, 50);
      expect(overview.map((space) => space.id)).not.toContain(empty.id);
      expect(overview.map((space) => space.name)).toContain('Main');
    });

    it('resolveForDebit and resolveForCredit still refuse an archived space', async () => {
      const primary = await bank.spaces.ensurePrimary(USER_A, 'USDT');
      const pot = await bank.spaces.create({ userId: USER_A, assetId: 'USDT', name: 'Holiday' });
      await fund(USER_A, 'USDT', '100');
      await bank.transfers.transfer({ transferId: 'seed-holiday-refuse', fromSpaceId: primary.id, toSpaceId: pot.id, amount: amt('40') });
      await bank.spaces.archive(pot.id);

      await expect(bank.spaces.resolveForDebit(pot.id, new Date())).rejects.toMatchObject({ code: 'bank.space_archived' });
      await expect(bank.spaces.resolveForCredit(pot.id)).rejects.toMatchObject({ code: 'bank.space_archived' });
      expect(formatAmount((await ledger.balance(subAccountAvailable(pot.id, 'USDT'))).amount)).toBe('40');
    });

    it('unarchive posts nothing, returns the space to list, and a transfer out closes the books', async () => {
      const primary = await bank.spaces.ensurePrimary(USER_A, 'USDT');
      const pot = await bank.spaces.create({ userId: USER_A, assetId: 'USDT', name: 'Holiday' });
      await fund(USER_A, 'USDT', '100');
      await bank.transfers.transfer({ transferId: 'seed-holiday-out', fromSpaceId: primary.id, toSpaceId: pot.id, amount: amt('40') });
      await bank.spaces.archive(pot.id);

      const posts = ledger.journal().length;
      await bank.spaces.unarchive(pot.id);
      expect(ledger.journal().length).toBe(posts);
      expect(formatAmount((await ledger.balance(subAccountAvailable(pot.id, 'USDT'))).amount)).toBe('40');
      expect(ledger.totalsByAsset().USDT).toBe('0');

      const listed = await bank.spaces.list(USER_A, 'USDT', 50);
      const back = listed.find((space) => space.id === pot.id);
      expect(back?.archivedAt).toBeNull();
      expect(back?.name).toBe('Holiday');

      await bank.transfers.transfer({ transferId: 'unarchive-to-primary', fromSpaceId: pot.id, toSpaceId: primary.id, amount: amt('40') });
      expect(formatAmount((await ledger.balance(subAccountAvailable(pot.id, 'USDT'))).amount)).toBe('0');
      expect(await availableOf(USER_A, 'USDT')).toBe('100');
      expect(ledger.totalsByAsset().USDT).toBe('0');
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('unarchive of a live named space is a no-op and posts nothing', async () => {
      const pot = await bank.spaces.create({ userId: USER_A, assetId: 'USDT', name: 'Holiday' });
      const before = await sql<Array<{ updated_at: Date; archived_at: Date | null }>>`
        SELECT updated_at, archived_at FROM bank.spaces WHERE id = ${pot.id}
      `;
      const posts = ledger.journal().length;

      await bank.spaces.unarchive(pot.id);

      const after = await sql<Array<{ updated_at: Date; archived_at: Date | null }>>`
        SELECT updated_at, archived_at FROM bank.spaces WHERE id = ${pot.id}
      `;
      expect(ledger.journal().length).toBe(posts);
      expect(after[0]?.archived_at).toBeNull();
      expect(after[0]?.updated_at?.getTime()).toBe(before[0]?.updated_at?.getTime());
    });

    it('refuses to unarchive a missing space or the primary space', async () => {
      const primary = await bank.spaces.ensurePrimary(USER_A, 'USDT');
      await expect(bank.spaces.unarchive('44444444-4444-4444-8444-444444444444')).rejects.toMatchObject({
        code: 'bank.space_not_found',
      });
      await expect(bank.spaces.unarchive(primary.id)).rejects.toMatchObject({ code: 'bank.space_archived' });
    });
  });

  // ══ Transfers ═════════════════════════════════════════════════════════════

  describe('one-off transfers', () => {
    it('moves value between two spaces and the books still close', async () => {
      const primary = await bank.spaces.ensurePrimary(USER_A, 'USDT');
      const rent = await bank.spaces.create({ userId: USER_A, assetId: 'USDT', name: 'Rent' });
      await fund(USER_A, 'USDT', '1000');

      await bank.transfers.transfer({ transferId: 'transfer-rent-1', fromSpaceId: primary.id, toSpaceId: rent.id, amount: amt('250') });

      expect(await availableOf(USER_A, 'USDT')).toBe('750');
      expect(formatAmount(await bank.spaces.balanceOf(rent))).toBe('250');
      expect(ledger.totalsByAsset().USDT).toBe('0');
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('is idempotent on the transfer id — a retried request moves value once', async () => {
      const primary = await bank.spaces.ensurePrimary(USER_A, 'USDT');
      const rent = await bank.spaces.create({ userId: USER_A, assetId: 'USDT', name: 'Rent' });
      await fund(USER_A, 'USDT', '1000');

      const first = await bank.transfers.transfer({
        transferId: 'transfer-retry-1',
        fromSpaceId: primary.id,
        toSpaceId: rent.id,
        amount: amt('250'),
      });
      const second = await bank.transfers.transfer({
        transferId: 'transfer-retry-1',
        fromSpaceId: primary.id,
        toSpaceId: rent.id,
        amount: amt('250'),
      });

      expect(second.ledgerTxId).toBe(first.ledgerTxId);
      expect(await availableOf(USER_A, 'USDT')).toBe('750');
    });

    it('rejects a transfer with insufficient funds and moves NOTHING', async () => {
      const primary = await bank.spaces.ensurePrimary(USER_A, 'USDT');
      const rent = await bank.spaces.create({ userId: USER_A, assetId: 'USDT', name: 'Rent' });
      await fund(USER_A, 'USDT', '100');

      await expect(
        bank.transfers.transfer({ transferId: 'transfer-broke-1', fromSpaceId: primary.id, toSpaceId: rent.id, amount: amt('101') }),
      ).rejects.toMatchObject({ code: 'ledger.insufficient_funds' });

      expect(await availableOf(USER_A, 'USDT')).toBe('100');
      expect(formatAmount(await bank.spaces.balanceOf(rent))).toBe('0');
      expect(ledger.totalsByAsset().USDT).toBe('0');
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('refuses to change asset mid-transfer', async () => {
      const usdt = await bank.spaces.ensurePrimary(USER_A, 'USDT');
      const eur = await bank.spaces.ensurePrimary(USER_A, 'EUR');
      await fund(USER_A, 'USDT', '100');

      await expect(
        bank.transfers.transfer({ transferId: 'transfer-fx-1', fromSpaceId: usdt.id, toSpaceId: eur.id, amount: amt('10') }),
      ).rejects.toMatchObject({ code: 'bank.asset_mismatch' });

      expect(await availableOf(USER_A, 'USDT')).toBe('100');
    });

    it('refuses to debit a space the user has locked, and moves nothing', async () => {
      const primary = await bank.spaces.ensurePrimary(USER_A, 'USDT');
      const locked = await bank.spaces.create({
        userId: USER_A,
        assetId: 'USDT',
        name: 'Locked away',
        lockedUntil: new Date(Date.now() + 30 * DAY_MS),
      });
      await fund(USER_A, 'USDT', '500');
      await bank.transfers.transfer({ transferId: 'seed-locked-1', fromSpaceId: primary.id, toSpaceId: locked.id, amount: amt('200') });

      await expect(
        bank.transfers.transfer({ transferId: 'break-lock-1', fromSpaceId: locked.id, toSpaceId: primary.id, amount: amt('50') }),
      ).rejects.toMatchObject({ code: 'bank.space_locked' });

      expect(formatAmount(await bank.spaces.balanceOf(locked))).toBe('200');
      expect(await availableOf(USER_A, 'USDT')).toBe('300');
    });

    it('moves value between two different users spaces', async () => {
      const a = await bank.spaces.ensurePrimary(USER_A, 'USDT');
      const b = await bank.spaces.ensurePrimary(USER_B, 'USDT');
      await fund(USER_A, 'USDT', '80');

      await bank.transfers.transfer({ transferId: 'peer-transfer-1', fromSpaceId: a.id, toSpaceId: b.id, amount: amt('80') });

      expect(await availableOf(USER_A, 'USDT')).toBe('0');
      expect(await availableOf(USER_B, 'USDT')).toBe('80');
      expect(ledger.totalsByAsset().USDT).toBe('0');
    });

    it('refuses user-to-user transfer when dest user is missing — nothing posted', async () => {
      const a = await bank.spaces.ensurePrimary(USER_A, 'USDT');
      await fund(USER_A, 'USDT', '50');
      const journalBefore = ledger.journal().map((tx) => tx.idempotencyKey);
      await expect(
        bank.transfers.transferToUser({
          transferId: 'user-transfer-missing',
          fromSpaceId: a.id,
          toUserId: NO_SUCH_USER,
          amount: amt('10'),
        }),
      ).rejects.toMatchObject({ code: 'bank.recipient_cannot_receive' });
      expect(ledger.journal().map((tx) => tx.idempotencyKey)).toEqual(journalBefore);
      expect(await availableOf(USER_A, 'USDT')).toBe('50');
      expect(await bank.spaces.findPrimary(NO_SUCH_USER, 'USDT')).toBeNull();
    });

    it('pays a member who has never held the asset: their main account opens on the first credit, once', async () => {
      const a = await bank.spaces.ensurePrimary(USER_A, 'USDT');
      await fund(USER_A, 'USDT', '50');
      expect(await bank.spaces.findPrimary(USER_B, 'USDT')).toBeNull();
      const send = { transferId: 'user-transfer-first-credit', fromSpaceId: a.id, toUserId: USER_B, amount: amt('20') };
      const first = await bank.transfers.transferToUser(send);
      const again = await bank.transfers.transferToUser(send);
      expect(again.ledgerTxId).toBe(first.ledgerTxId);
      expect(await availableOf(USER_A, 'USDT')).toBe('30');
      expect(await availableOf(USER_B, 'USDT')).toBe('20');
      expect(await sql`SELECT id FROM bank.spaces WHERE user_id = ${USER_B} AND kind = 'primary'`).toHaveLength(1);
      expect(ledger.totalsByAsset().USDT).toBe('0');
    });

    it('transfers to the dest user through ledger-client', async () => {
      const a = await bank.spaces.ensurePrimary(USER_A, 'USDT');
      await bank.spaces.ensurePrimary(USER_B, 'USDT');
      await fund(USER_A, 'USDT', '25');
      const moved = await bank.transfers.transferToUser({
        transferId: 'user-transfer-stored',
        fromSpaceId: a.id,
        toUserId: USER_B,
        amount: amt('25'),
      });
      expect(moved.amount).toBe('25');
      expect(moved.ledgerTxId).toBeTruthy();
      expect(ledger.journal().some((tx) => tx.idempotencyKey.includes('user-transfer-stored'))).toBe(true);
      expect(await availableOf(USER_A, 'USDT')).toBe('0');
      expect(await availableOf(USER_B, 'USDT')).toBe('25');
      expect(ledger.reconcile()).toEqual({ ok: true });
    });
  });

  // ══ Scheduled transfers ═══════════════════════════════════════════════════

  describe('scheduled transfers', () => {
    async function standingOrder(
      value = '100',
      cadence: 'daily' | 'weekly' | 'monthly' = 'monthly',
      startsAt = new Date('2026-01-01T09:00:00Z'),
    ) {
      const primary = await bank.spaces.ensurePrimary(USER_A, 'USDT');
      const rent = await bank.spaces.create({ userId: USER_A, assetId: 'USDT', name: 'Rent' });
      const schedule = await bank.transfers.schedule({
        scheduleId: randomUUID(),
        userId: USER_A,
        fromSpaceId: primary.id,
        toSpaceId: rent.id,
        amount: amt(value),
        cadence,
        startsAt,
      });
      return { primary, rent, schedule };
    }

    it('refuses standing order to a dest user with no primary — no row, nothing posted', async () => {
      const a = await bank.spaces.ensurePrimary(USER_A, 'USDT');
      await fund(USER_A, 'USDT', '50');
      const journalBefore = ledger.journal().map((tx) => tx.idempotencyKey);
      await expect(
        bank.transfers.scheduleToUser({
          scheduleId: randomUUID(),
          userId: USER_A,
          fromSpaceId: a.id,
          toUserId: NO_SUCH_USER,
          amount: amt('10'),
          cadence: 'monthly',
          startsAt: new Date('2026-01-01T09:00:00Z'),
        }),
      ).rejects.toMatchObject({ code: 'bank.recipient_cannot_receive' });
      const rows = await sql`SELECT id FROM bank.scheduled_transfers`;
      expect(rows).toHaveLength(0);
      expect(ledger.journal().map((tx) => tx.idempotencyKey)).toEqual(journalBefore);
      expect(await availableOf(USER_A, 'USDT')).toBe('50');
    });

    it('schedules to a member who has never held the asset: the run pays the account the schedule opened', async () => {
      const a = await bank.spaces.ensurePrimary(USER_A, 'USDT');
      await fund(USER_A, 'USDT', '100');
      expect(await bank.spaces.findPrimary(USER_B, 'USDT')).toBeNull();
      const schedule = await bank.transfers.scheduleToUser({
        scheduleId: randomUUID(),
        userId: USER_A,
        fromSpaceId: a.id,
        toUserId: USER_B,
        amount: amt('25'),
        cadence: 'monthly',
        startsAt: new Date('2026-01-01T09:00:00Z'),
      });
      const opened = await bank.spaces.findPrimary(USER_B, 'USDT');
      expect(schedule.toSpaceId).toBe(opened?.id);
      const now = new Date('2026-01-01T10:00:00Z');
      expect((await bank.transfers.runDueTransfers({ now, limit: 200 })).settled).toBe(1);
      expect((await bank.transfers.runDueTransfers({ now, limit: 200 })).settled).toBe(0);
      expect(await availableOf(USER_A, 'USDT')).toBe('75');
      expect(await availableOf(USER_B, 'USDT')).toBe('25');
      expect(ledger.totalsByAsset().USDT).toBe('0');
    });

    it('schedules to the dest user and fires through ledger-client', async () => {
      const a = await bank.spaces.ensurePrimary(USER_A, 'USDT');
      await bank.spaces.ensurePrimary(USER_B, 'USDT');
      await fund(USER_A, 'USDT', '100');
      const schedule = await bank.transfers.scheduleToUser({
        scheduleId: randomUUID(),
        userId: USER_A,
        fromSpaceId: a.id,
        toUserId: USER_B,
        amount: amt('25'),
        cadence: 'monthly',
        startsAt: new Date('2026-01-01T09:00:00Z'),
      });
      const now = new Date('2026-01-01T10:00:00Z');
      const report = await bank.transfers.runDueTransfers({ now, limit: 200 });
      expect(report.settled).toBe(1);
      expect(ledger.journal().some((tx) => tx.idempotencyKey.includes(schedule.id))).toBe(true);
      expect(await availableOf(USER_A, 'USDT')).toBe('75');
      expect(await availableOf(USER_B, 'USDT')).toBe('25');
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('fires ONCE even when the job runs twice', async () => {
      const { rent, schedule } = await standingOrder('100');
      await fund(USER_A, 'USDT', '1000');

      const now = new Date('2026-01-01T10:00:00Z');
      const first = await bank.transfers.runDueTransfers({ now, limit: 200 });
      const second = await bank.transfers.runDueTransfers({ now, limit: 200 });

      expect(first.settled).toBe(1);
      expect(second.settled).toBe(0);

      expect(formatAmount(await bank.spaces.balanceOf(rent))).toBe('100');
      expect(await availableOf(USER_A, 'USDT')).toBe('900');

      const executions = await bank.transfers.executions(schedule.id, 50);
      expect(executions).toHaveLength(1);
      expect(executions[0]).toMatchObject({ occurrence: 0, status: 'settled' });
    });

    // Eight racers on a pool of eight (`createTestDatabase` opens `max: 8`): the
    // exact ratio that froze the pool before #4621. Keep racers == pool size;
    // `pool-starvation.test.ts` is the deterministic version of this race.
    it('fires once even when eight runs race each other', async () => {
      const { rent } = await standingOrder('100');
      await fund(USER_A, 'USDT', '1000');

      const now = new Date('2026-01-01T10:00:00Z');
      await Promise.all(Array.from({ length: 8 }, () => bank.transfers.runDueTransfers({ now, limit: 200 }).catch(() => undefined)));

      expect(formatAmount(await bank.spaces.balanceOf(rent))).toBe('100');
      expect(ledger.reconcile()).toEqual({ ok: true });
    }, 20_000);

    /**
     * Isolation residual (audit B-3 class): a mid-drive throw (frozen ledger,
     * network fault) used to escape `runDueTransfers` and stop every later
     * schedule on the pass — and the thrower stayed first forever because its
     * `next_run_at` never advanced. One user's incident is not a platform stop.
     */
    it('one schedule that throws mid-drive does not stop every other standing order on the pass', async () => {
      const primaryA = await bank.spaces.ensurePrimary(USER_A, 'USDT');
      const rentA = await bank.spaces.create({ userId: USER_A, assetId: 'USDT', name: 'Rent A' });
      const primaryB = await bank.spaces.ensurePrimary(USER_B, 'USDT');
      const rentB = await bank.spaces.create({ userId: USER_B, assetId: 'USDT', name: 'Rent B' });
      await fund(USER_A, 'USDT', '500');
      await fund(USER_B, 'USDT', '500');

      const scheduleA = await bank.transfers.schedule({
        scheduleId: randomUUID(),
        userId: USER_A,
        fromSpaceId: primaryA.id,
        toSpaceId: rentA.id,
        amount: amt('100'),
        cadence: 'monthly',
        startsAt: new Date('2026-01-01T09:00:00Z'),
      });
      const scheduleB = await bank.transfers.schedule({
        scheduleId: randomUUID(),
        userId: USER_B,
        fromSpaceId: primaryB.id,
        toSpaceId: rentB.id,
        amount: amt('100'),
        cadence: 'monthly',
        startsAt: new Date('2026-01-01T09:00:00Z'),
      });

      // ORDER BY next_run_at ASC, then id implicitly by insert — poison A so
      // if isolation is missing B never settles when A throws first.
      const poisonPrefix = `bank.transfer.sched:${scheduleA.id}:`;
      const real = ledger;
      const isolating: LedgerClient = {
        post: async (request) => {
          if (request.idempotencyKey.startsWith(poisonPrefix)) {
            throw new LedgerError('Ledger posting is frozen: isolation residual test', 'ledger.frozen');
          }
          return real.post(request);
        },
        balance: (ref) => real.balance(ref),
        balances: (ownerType, ownerId) => real.balances(ownerType, ownerId),
        getTx: (txId) => real.getTx(txId),
        getTxByKey: (key) => real.getTxByKey(key),
      };
      bank = createBankServices(sql, isolating, memoryLedgerHistory(real), { nativeAssetId: 'IFC' });

      const report = await bank.transfers.runDueTransfers({ now: new Date('2026-01-01T10:00:00Z'), limit: 200 });

      expect(report.failures).toEqual(
        expect.arrayContaining([expect.objectContaining({ scheduleId: scheduleA.id, code: 'ledger.frozen' })]),
      );
      expect(report.settled).toBe(1);
      expect(formatAmount(await bank.spaces.balanceOf(rentB))).toBe('100');
      // A: occurrence not consumed — claim rolled back on rethrow.
      expect(await bank.transfers.executions(scheduleA.id, 50)).toHaveLength(0);
      expect(await availableOf(USER_A, 'USDT')).toBe('500');
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    /**
     * Batch-fairness residual after #1491: isolation continues peers *on the
     * same pass*, but a permanently-failing schedule never advanced
     * `next_run_at`, so N poison rows with the oldest watermark permanently
     * filled `LIMIT` and healthy schedules never got selected.
     */
    it('permanently failing schedules cannot starve healthy ones under the batch limit', async () => {
      const primaryA = await bank.spaces.ensurePrimary(USER_A, 'USDT');
      const rentA = await bank.spaces.create({ userId: USER_A, assetId: 'USDT', name: 'Poison rent' });
      const primaryB = await bank.spaces.ensurePrimary(USER_B, 'USDT');
      const rentB = await bank.spaces.create({ userId: USER_B, assetId: 'USDT', name: 'Healthy rent' });
      await fund(USER_A, 'USDT', '500');
      await fund(USER_B, 'USDT', '500');

      // Poison starts earlier so ORDER BY next_run_at picks it first.
      const poison = await bank.transfers.schedule({
        scheduleId: randomUUID(),
        userId: USER_A,
        fromSpaceId: primaryA.id,
        toSpaceId: rentA.id,
        amount: amt('100'),
        cadence: 'monthly',
        startsAt: new Date('2026-01-01T08:00:00Z'),
      });
      const healthy = await bank.transfers.schedule({
        scheduleId: randomUUID(),
        userId: USER_B,
        fromSpaceId: primaryB.id,
        toSpaceId: rentB.id,
        amount: amt('100'),
        cadence: 'monthly',
        startsAt: new Date('2026-01-01T09:00:00Z'),
      });

      const poisonPrefix = `bank.transfer.sched:${poison.id}:`;
      const real = ledger;
      const isolating: LedgerClient = {
        post: async (request) => {
          if (request.idempotencyKey.startsWith(poisonPrefix)) {
            throw new LedgerError('Ledger posting is frozen: batch fairness residual', 'ledger.frozen');
          }
          return real.post(request);
        },
        balance: (ref) => real.balance(ref),
        balances: (ownerType, ownerId) => real.balances(ownerType, ownerId),
        getTx: (txId) => real.getTx(txId),
        getTxByKey: (key) => real.getTxByKey(key),
      };
      bank = createBankServices(sql, isolating, memoryLedgerHistory(real), { nativeAssetId: 'IFC' });

      const jobNow = new Date('2026-01-01T10:00:00Z');
      // Pass 1: limit=1 only sees poison (oldest). Isolation records failure;
      // fairness bumps poison next_run_at to jobNow so healthy sorts first next.
      const first = await bank.transfers.runDueTransfers({ now: jobNow, limit: 1 });
      expect(first.failures).toEqual(expect.arrayContaining([expect.objectContaining({ scheduleId: poison.id, code: 'ledger.frozen' })]));
      expect(first.settled).toBe(0);

      // Pass 2: healthy must settle even though poison is still due and failing.
      const second = await bank.transfers.runDueTransfers({ now: jobNow, limit: 1 });
      expect(second.settled).toBe(1);
      expect(formatAmount(await bank.spaces.balanceOf(rentB))).toBe('100');
      expect(await bank.transfers.executions(healthy.id, 50)).toHaveLength(1);
      // Poison still not consumed.
      expect(await bank.transfers.executions(poison.id, 50)).toHaveLength(0);
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    /**
     * Cancel mid-drive residual: due select freezes status=active. Without a
     * re-check before each claim, multi-occurrence catch-up still posts every
     * planned firing after cancel.
     *
     * Cancel runs after the first fire returns (claim tx committed) so it does
     * not deadlock on schedule FOR UPDATE. Private method access is test-only
     * (TS private is erase-only).
     */
    it('cancel during a multi-occurrence catch-up stops unclaimed firings', async () => {
      const primary = await bank.spaces.ensurePrimary(USER_A, 'USDT');
      const rent = await bank.spaces.create({ userId: USER_A, assetId: 'USDT', name: 'Rent mid-cancel' });
      await fund(USER_A, 'USDT', '1000');

      const schedule = await bank.transfers.schedule({
        scheduleId: randomUUID(),
        userId: USER_A,
        fromSpaceId: primary.id,
        toSpaceId: rent.id,
        amount: amt('10'),
        cadence: 'daily',
        startsAt: new Date('2026-01-01T00:00:00Z'),
      });

      const transfers = bank.transfers as unknown as {
        fireOccurrenceInner: (
          schedule: unknown,
          occurrence: number,
          now: Date,
        ) => Promise<'settled' | 'rejected' | 'already-fired' | 'stopped'>;
      };
      const original = transfers.fireOccurrenceInner.bind(bank.transfers);
      let fired = 0;
      transfers.fireOccurrenceInner = async (sched, occurrence, now) => {
        const outcome = await original(sched, occurrence, now);
        fired += 1;
        if (fired === 1) {
          await bank.transfers.cancelSchedule(schedule.id);
        }
        return outcome;
      };

      const report = await bank.transfers.runDueTransfers({
        now: new Date('2026-01-10T00:00:00Z'),
        maxCatchUp: 10,
        limit: 200,
      });

      expect(report.settled).toBe(1);
      const executions = await bank.transfers.executions(schedule.id, 50);
      expect(executions).toHaveLength(1);
      expect(executions[0]).toMatchObject({ occurrence: 0, status: 'settled' });
      expect(formatAmount(await bank.spaces.balanceOf(rent))).toBe('10');
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('records a rejection and moves nothing when the space is empty', async () => {
      const { rent, schedule } = await standingOrder('100');
      // No funding at all.

      const report = await bank.transfers.runDueTransfers({ now: new Date('2026-01-01T10:00:00Z'), limit: 200 });

      expect(report.rejected).toBe(1);
      expect(report.settled).toBe(0);
      expect(formatAmount(await bank.spaces.balanceOf(rent))).toBe('0');
      expect(await availableOf(USER_A, 'USDT')).toBe('0');

      const executions = await bank.transfers.executions(schedule.id, 50);
      expect(executions[0]).toMatchObject({ occurrence: 0, status: 'rejected', rejectionCode: 'ledger.insufficient_funds' });
      expect(ledger.totalsByAsset().USDT ?? '0').toBe('0');
    });

    it('refuses a standing debit from a locked space — same gate as a one-off, no silent drain', async () => {
      const primary = await bank.spaces.ensurePrimary(USER_A, 'USDT');
      const locked = await bank.spaces.create({
        userId: USER_A,
        assetId: 'USDT',
        name: 'Locked rent pot',
        lockedUntil: new Date('2027-01-01T00:00:00Z'),
      });
      const rent = await bank.spaces.create({ userId: USER_A, assetId: 'USDT', name: 'Rent due' });
      await fund(USER_A, 'USDT', '500');
      await bank.transfers.transfer({
        transferId: 'seed-locked-so-1',
        fromSpaceId: primary.id,
        toSpaceId: locked.id,
        amount: amt('200'),
      });

      const schedule = await bank.transfers.schedule({
        scheduleId: randomUUID(),
        userId: USER_A,
        fromSpaceId: locked.id,
        toSpaceId: rent.id,
        amount: amt('50'),
        cadence: 'monthly',
        startsAt: new Date('2026-01-01T09:00:00Z'),
      });

      const report = await bank.transfers.runDueTransfers({ now: new Date('2026-01-01T10:00:00Z'), limit: 200 });

      expect(report.rejected).toBe(1);
      expect(report.settled).toBe(0);
      expect(formatAmount(await bank.spaces.balanceOf(locked))).toBe('200');
      expect(formatAmount(await bank.spaces.balanceOf(rent))).toBe('0');

      const executions = await bank.transfers.executions(schedule.id, 50);
      expect(executions[0]).toMatchObject({ occurrence: 0, status: 'rejected', rejectionCode: 'bank.space_locked' });
      // Occurrence is consumed — a later run with the lock still on does not retry March.
      await bank.transfers.runDueTransfers({ now: new Date('2026-01-15T10:00:00Z'), limit: 200 });
      expect(await bank.transfers.executions(schedule.id, 50)).toHaveLength(1);
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('recovers a post-then-lock crash as settled, never rejected-with-money-moved', async () => {
      // Adversarial: claim rolls back after ledger.post succeeds; user then locks
      // the debit space. Re-drive must mark settled from the existing key — not
      // reject while value already left the pot.
      const primary = await bank.spaces.ensurePrimary(USER_A, 'USDT');
      const rent = await bank.spaces.create({ userId: USER_A, assetId: 'USDT', name: 'Rent due' });
      await fund(USER_A, 'USDT', '500');

      const schedule = await bank.transfers.schedule({
        scheduleId: randomUUID(),
        userId: USER_A,
        fromSpaceId: primary.id,
        toSpaceId: rent.id,
        amount: amt('50'),
        cadence: 'monthly',
        startsAt: new Date('2026-01-01T09:00:00Z'),
      });

      // Simulate external ledger success without a bank execution row (crash after post).
      const from = await bank.spaces.get(primary.id);
      const to = await bank.spaces.get(rent.id);
      await ledger.post(
        recipes.bankTransfer({
          transferId: schedule.id,
          occurrence: 0,
          from: accountForSpace(from),
          to: accountForSpace(to),
          amount: amt('50'),
          kind: 'scheduled',
          keySpace: 'sched',
        }),
      );
      expect(formatAmount(await bank.spaces.balanceOf(rent))).toBe('50');

      // No public setLock — lock lands the way a concurrent user/session would.
      await sql`UPDATE bank.spaces SET locked_until = ${new Date('2027-01-01T00:00:00Z')} WHERE id = ${primary.id}`;

      const report = await bank.transfers.runDueTransfers({ now: new Date('2026-01-01T10:00:00Z'), limit: 200 });
      expect(report.settled).toBe(1);
      expect(report.rejected).toBe(0);
      expect(formatAmount(await bank.spaces.balanceOf(rent))).toBe('50');
      expect(formatAmount(await bank.spaces.balanceOf(primary))).toBe('450');
      const executions = await bank.transfers.executions(schedule.id, 50);
      expect(executions[0]).toMatchObject({ occurrence: 0, status: 'settled' });
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('refuses a standing credit into an archived space and moves nothing', async () => {
      const primary = await bank.spaces.ensurePrimary(USER_A, 'USDT');
      const archiveMe = await bank.spaces.create({ userId: USER_A, assetId: 'USDT', name: 'Old jar' });
      await fund(USER_A, 'USDT', '300');

      const schedule = await bank.transfers.schedule({
        scheduleId: randomUUID(),
        userId: USER_A,
        fromSpaceId: primary.id,
        toSpaceId: archiveMe.id,
        amount: amt('40'),
        cadence: 'monthly',
        startsAt: new Date('2026-01-01T09:00:00Z'),
      });
      await bank.spaces.archive(archiveMe.id);

      const report = await bank.transfers.runDueTransfers({ now: new Date('2026-01-01T10:00:00Z'), limit: 200 });

      expect(report.rejected).toBe(1);
      expect(report.settled).toBe(0);
      expect(await availableOf(USER_A, 'USDT')).toBe('300');
      const executions = await bank.transfers.executions(schedule.id, 50);
      expect(executions[0]).toMatchObject({ occurrence: 0, status: 'rejected', rejectionCode: 'bank.space_archived' });
    });

    it('does not retry an occurrence that was rejected — a missed March is not made up in April', async () => {
      // Midnight anchor: occurrence 1 is due at 2026-02-01T00:00:00Z, not 09:00.
      const { rent, schedule } = await standingOrder('100', 'monthly', new Date('2026-01-01T00:00:00Z'));

      await bank.transfers.runDueTransfers({ now: new Date('2026-01-01T10:00:00Z'), limit: 200 });
      // Money arrives afterwards; the January occurrence must stay rejected.
      await fund(USER_A, 'USDT', '1000');
      await bank.transfers.runDueTransfers({ now: new Date('2026-01-15T10:00:00Z'), limit: 200 });

      expect(formatAmount(await bank.spaces.balanceOf(rent))).toBe('0');
      const january = await bank.transfers.executions(schedule.id, 50);
      expect(january).toHaveLength(1);
      expect(january[0]).toMatchObject({ occurrence: 0, status: 'rejected', amount: '100' });

      const february = await bank.transfers.runDueTransfers({ now: new Date('2026-02-01T00:00:00Z'), limit: 200 });

      // February pays its own occurrence once. Rejected January is not repaid.
      expect(february.settled).toBe(1);
      expect(february.rejected).toBe(0);
      expect(formatAmount(await bank.spaces.balanceOf(rent))).toBe('100');
      const executions = await bank.transfers.executions(schedule.id, 50);
      expect(executions).toHaveLength(2);
      expect(executions[0]).toMatchObject({ occurrence: 0, status: 'rejected', amount: '100' });
      expect(executions[1]).toMatchObject({ occurrence: 1, status: 'settled', amount: '100' });
    });

    it('fires every occurrence exactly once across a catch-up run', async () => {
      const { rent, schedule } = await standingOrder('10', 'daily', new Date('2026-01-01T00:00:00Z'));
      await fund(USER_A, 'USDT', '1000');

      // Five days later: occurrences 0..5 are all due.
      await bank.transfers.runDueTransfers({ now: new Date('2026-01-06T00:00:00Z'), limit: 200 });
      await bank.transfers.runDueTransfers({ now: new Date('2026-01-06T00:00:00Z'), limit: 200 });

      const executions = await bank.transfers.executions(schedule.id, 50);
      expect(executions.map((e) => e.occurrence)).toEqual([0, 1, 2, 3, 4, 5]);
      expect(formatAmount(await bank.spaces.balanceOf(rent))).toBe('60');
    });

    it('bounds a catch-up pass so an old schedule does not fire a wall of transfers', async () => {
      const { schedule } = await standingOrder('1', 'daily', new Date('2026-01-01T00:00:00Z'));
      await fund(USER_A, 'USDT', '1000');

      await bank.transfers.runDueTransfers({ now: new Date('2026-06-01T00:00:00Z'), maxCatchUp: 3, limit: 200 });

      const executions = await bank.transfers.executions(schedule.id, 50);
      expect(executions).toHaveLength(3);
    });

    it('re-drives a claim that was left pending by a crashed run, without paying twice', async () => {
      const { rent, schedule } = await standingOrder('100');
      await fund(USER_A, 'USDT', '1000');

      // Manufacture the state a process would leave if it died after committing
      // the claim but before posting. It cannot happen in the current ordering —
      // the claim and the post share a transaction — which is exactly why it is
      // worth proving the recovery path works if it ever could.
      await sql`
        INSERT INTO bank.transfer_executions (schedule_id, occurrence, amount, status)
        VALUES (${schedule.id}, 0, 100, 'pending')
      `;

      await bank.transfers.runDueTransfers({ now: new Date('2026-01-01T10:00:00Z'), limit: 200 });
      await bank.transfers.runDueTransfers({ now: new Date('2026-01-01T10:00:00Z'), limit: 200 });

      expect(formatAmount(await bank.spaces.balanceOf(rent))).toBe('100');
      const executions = await bank.transfers.executions(schedule.id, 50);
      expect(executions).toHaveLength(1);
      expect(executions[0]?.status).toBe('settled');
    });

    it('stops at the end of the schedule window', async () => {
      const primary = await bank.spaces.ensurePrimary(USER_A, 'USDT');
      const rent = await bank.spaces.create({ userId: USER_A, assetId: 'USDT', name: 'Rent' });
      await fund(USER_A, 'USDT', '1000');

      const schedule = await bank.transfers.schedule({
        scheduleId: randomUUID(),
        userId: USER_A,
        fromSpaceId: primary.id,
        toSpaceId: rent.id,
        amount: amt('10'),
        cadence: 'daily',
        startsAt: new Date('2026-01-01T00:00:00Z'),
        endsAt: new Date('2026-01-04T00:00:00Z'),
      });

      await bank.transfers.runDueTransfers({ now: new Date('2026-02-01T00:00:00Z'), limit: 200 });

      // Occurrences 0,1,2 fall inside [starts, ends); occurrence 3 is at the
      // boundary and must not fire.
      const executions = await bank.transfers.executions(schedule.id, 50);
      expect(executions.map((e) => e.occurrence)).toEqual([0, 1, 2]);

      const rows = await sql<Array<{ status: string }>>`SELECT status FROM bank.scheduled_transfers WHERE id = ${schedule.id}`;
      expect(rows[0]?.status).toBe('completed');
    });

    it('does not fire before the schedule starts', async () => {
      const { schedule } = await standingOrder('100', 'monthly', new Date('2026-06-01T00:00:00Z'));
      await fund(USER_A, 'USDT', '1000');

      const report = await bank.transfers.runDueTransfers({ now: new Date('2026-01-01T00:00:00Z'), limit: 200 });
      expect(report.schedulesConsidered).toBe(0);
      expect(await bank.transfers.executions(schedule.id, 50)).toHaveLength(0);
    });

    it('stops firing once cancelled', async () => {
      const { rent, schedule } = await standingOrder('10', 'daily', new Date('2026-01-01T00:00:00Z'));
      await fund(USER_A, 'USDT', '1000');

      await bank.transfers.runDueTransfers({ now: new Date('2026-01-01T01:00:00Z'), limit: 200 });
      await bank.transfers.cancelSchedule(schedule.id);
      await bank.transfers.runDueTransfers({ now: new Date('2026-01-10T01:00:00Z'), limit: 200 });

      expect(formatAmount(await bank.spaces.balanceOf(rent))).toBe('10');
    });
  });

  // ══ Pause / resume ════════════════════════════════════════════════════════

  /**
   * The one thing resume must never do is settle up.
   *
   * `planDue` fires everything between `lastFired` and `now`, which is right
   * after an outage and catastrophic after a pause: the user stopped the order
   * so those transfers would NOT happen. Every test below is an angle on that
   * single sentence, and the first one fails loudly — by a factor of ten — if
   * the skip window is ever removed.
   */
  describe('a paused standing order does not fire, and resuming does not settle up', () => {
    /** 10/day from 1 Jan, occurrence 0 already fired, then paused. */
    async function pausedAfterFirstFiring() {
      const primary = await bank.spaces.ensurePrimary(USER_A, 'USDT');
      const rent = await bank.spaces.create({ userId: USER_A, assetId: 'USDT', name: 'Rent' });
      await fund(USER_A, 'USDT', '10000');

      const schedule = await bank.transfers.schedule({
        scheduleId: randomUUID(),
        userId: USER_A,
        fromSpaceId: primary.id,
        toSpaceId: rent.id,
        amount: amt('10'),
        cadence: 'daily',
        startsAt: new Date('2026-01-01T00:00:00Z'),
      });

      await bank.transfers.runDueTransfers({ now: new Date('2026-01-01T01:00:00Z'), limit: 200 });
      await bank.transfers.pauseSchedule(schedule.id);
      return { primary, rent, schedule };
    }

    it('fires nothing at all while paused, however long the runner keeps looking', async () => {
      const { rent, schedule } = await pausedAfterFirstFiring();

      await bank.transfers.runDueTransfers({ now: new Date('2026-01-10T01:00:00Z'), limit: 200 });
      await bank.transfers.runDueTransfers({ now: new Date('2026-03-01T01:00:00Z'), limit: 200 });

      expect(formatAmount(await bank.spaces.balanceOf(rent))).toBe('10');
      expect(await bank.transfers.executions(schedule.id, 50)).toHaveLength(1);
    });

    /**
     * THE TEST THIS SLICE EXISTS FOR.
     *
     * Nine days paused, ten a day. Without the skip window the runner's first
     * pass after resume would move 90 — nine payments, on one afternoon, that the
     * user paused the order specifically to stop. `toBe('10')` is a factor of ten
     * away from that failure, so it cannot pass by accident.
     */
    it('does not fire the occurrences that came due while it was paused', async () => {
      const { rent, schedule } = await pausedAfterFirstFiring();

      await bank.transfers.resumeSchedule(schedule.id, { now: new Date('2026-01-10T00:00:00Z') });
      await bank.transfers.runDueTransfers({ now: new Date('2026-01-10T00:00:00Z'), limit: 200 });
      await bank.transfers.runDueTransfers({ now: new Date('2026-01-10T23:00:00Z'), limit: 200 });

      expect(formatAmount(await bank.spaces.balanceOf(rent))).toBe('10');

      // And it is genuinely resumed, not quietly dead: the NEXT occurrence fires.
      await bank.transfers.runDueTransfers({ now: new Date('2026-01-11T00:00:00Z'), limit: 200 });
      expect(formatAmount(await bank.spaces.balanceOf(rent))).toBe('20');
    });

    it('moves no value itself — pausing and resuming post nothing to the ledger', async () => {
      const { schedule } = await pausedAfterFirstFiring();
      const before = ledger.journal().length;

      await bank.transfers.resumeSchedule(schedule.id, { now: new Date('2026-02-01T00:00:00Z') });
      await bank.transfers.pauseSchedule(schedule.id);
      await bank.transfers.resumeSchedule(schedule.id, { now: new Date('2026-03-01T00:00:00Z') });

      expect(ledger.journal().length).toBe(before);
    });

    it('records every skipped occurrence with a reason, not as an absence', async () => {
      const { schedule } = await pausedAfterFirstFiring();

      const report = await bank.transfers.resumeSchedule(schedule.id, { now: new Date('2026-01-10T00:00:00Z') });
      expect(report.skipped).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);

      const executions = await bank.transfers.executions(schedule.id, 50);
      expect(executions).toHaveLength(10);
      expect(executions[0]).toMatchObject({ occurrence: 0, status: 'settled' });

      // A record, because `MAX(occurrence)` is what stops the backlog — and a
      // REASON, because "nothing happened in March" otherwise has no answer.
      for (const e of executions.slice(1)) {
        expect(e.status).toBe('skipped');
        expect(e.rejectionCode).toBe(PAUSED_SKIP_REASON);
        expect(e.ledgerTxId).toBeNull();
      }
    });

    /**
     * THE DATABASE, NOT THIS SERVICE, IS WHAT MAKES "RESUME MOVES NO VALUE" TRUE.
     *
     * `resumeSchedule` posts nothing — that is asserted directly above by
     * counting the journal. But "the code does not do it" is the weakest
     * guarantee available for a money table, and a skipped row carrying a
     * `ledger_tx_id` would be indistinguishable from a firing that really
     * happened, in the record a support engineer reads.
     *
     * Written as raw SQL on purpose: no method in this service can produce this
     * row, which is exactly why the constraint has to be tested from outside the
     * service. If `0006` is ever dropped, this fails.
     */
    it('cannot record a skipped occurrence that claims value moved', async () => {
      const { schedule } = await pausedAfterFirstFiring();

      const withTx = await sql`
        INSERT INTO bank.transfer_executions (schedule_id, occurrence, amount, status, rejection_code, ledger_tx_id)
        VALUES (${schedule.id}, 41, 10, 'skipped', ${PAUSED_SKIP_REASON}, 'some-ledger-tx')
      `.catch((e: unknown) => e);
      expect(withTx).toBeInstanceOf(Error);

      const withSettledAt = await sql`
        INSERT INTO bank.transfer_executions (schedule_id, occurrence, amount, status, rejection_code, settled_at)
        VALUES (${schedule.id}, 42, 10, 'skipped', ${PAUSED_SKIP_REASON}, now())
      `.catch((e: unknown) => e);
      expect(withSettledAt).toBeInstanceOf(Error);

      // And a skip with no reason at all: "nothing happened in March" with no
      // "because" is the same unanswerable row `rejected` is protected from.
      const withoutReason = await sql`
        INSERT INTO bank.transfer_executions (schedule_id, occurrence, amount, status)
        VALUES (${schedule.id}, 43, 10, 'skipped')
      `.catch((e: unknown) => e);
      expect(withoutReason).toBeInstanceOf(Error);

      // The honest shape is accepted, so the constraint is not simply banning
      // the value outright.
      await sql`
        INSERT INTO bank.transfer_executions (schedule_id, occurrence, amount, status, rejection_code)
        VALUES (${schedule.id}, 44, 10, 'skipped', ${PAUSED_SKIP_REASON})
      `;
    });

    it('never overwrites an occurrence that already settled', async () => {
      const { schedule } = await pausedAfterFirstFiring();
      const settled = (await bank.transfers.executions(schedule.id, 50))[0];

      await bank.transfers.resumeSchedule(schedule.id, { now: new Date('2026-01-10T00:00:00Z') });

      const after = (await bank.transfers.executions(schedule.id, 50))[0];
      expect(after).toEqual(settled);
      expect(after?.ledgerTxId).not.toBeNull();
    });

    /**
     * A claim is a commitment already made. A pause cannot retract it.
     *
     * A `pending` row is an occurrence whose process died between claiming and
     * posting. `ON CONFLICT DO NOTHING` leaves it pending rather than writing it
     * off as skipped, so the runner's stranded sweep still completes it after the
     * resume — money the user authorised, that the system already claimed.
     */
    it('leaves an occurrence claimed before the pause alive for the stranded sweep', async () => {
      const { rent, schedule } = await pausedAfterFirstFiring();

      await sql`
        INSERT INTO bank.transfer_executions (schedule_id, occurrence, amount, status)
        VALUES (${schedule.id}, 1, 10, 'pending')
      `;

      const report = await bank.transfers.resumeSchedule(schedule.id, { now: new Date('2026-01-10T00:00:00Z') });
      expect(report.skipped).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);

      const stillPending = await bank.transfers.executions(schedule.id, 50);
      expect(stillPending.find((e) => e.occurrence === 1)?.status).toBe('pending');

      await bank.transfers.runDueTransfers({ now: new Date('2026-01-10T00:00:00Z'), limit: 200 });
      expect((await bank.transfers.executions(schedule.id, 50)).find((e) => e.occurrence === 1)?.status).toBe('settled');
      expect(formatAmount(await bank.spaces.balanceOf(rent))).toBe('20');
    });

    /**
     * THE HOLE PAUSE OPENS, AND THE ONLY THING THAT CLOSES IT.
     *
     * The runner's due query is `status = 'active' AND next_run_at <= now`, so a
     * paused schedule is never selected. Before the sweep was made independent
     * of that query, a claim stranded before the pause sat `pending` for exactly
     * as long as the user left the order paused — forever, if they never resumed
     * — with nothing raised anywhere. Resuming did not rescue it either:
     * `resumeSchedule` moves `next_run_at` PAST the stranded occurrence.
     *
     * The user authorised this transfer and the service claimed it. Never
     * posting it is not a safe failure, it is a transfer that silently did not
     * happen.
     */
    it('finishes a claim stranded before the pause even if the order is never resumed', async () => {
      const { rent, schedule } = await pausedAfterFirstFiring();

      await sql`
        INSERT INTO bank.transfer_executions (schedule_id, occurrence, amount, status)
        VALUES (${schedule.id}, 1, 10, 'pending')
      `;

      // Still paused. Months pass. Nothing else about this schedule is due, and
      // by the due query alone this pass would consider nothing at all.
      const report = await bank.transfers.runDueTransfers({ now: new Date('2026-06-01T00:00:00Z'), limit: 200 });

      expect(report.strandedSwept).toBe(1);
      expect(report.settled).toBe(1);
      expect((await bank.transfers.getSchedule(schedule.id)).status).toBe('paused');

      const executions = await bank.transfers.executions(schedule.id, 50);
      expect(executions.find((e) => e.occurrence === 1)?.status).toBe('settled');
      expect(executions.find((e) => e.occurrence === 1)?.ledgerTxId).not.toBeNull();

      // Exactly one occurrence's worth, on top of the one that fired before the
      // pause. The sweep finishes what was claimed; it plans nothing new.
      expect(formatAmount(await bank.spaces.balanceOf(rent))).toBe('20');
      expect(executions).toHaveLength(2);
    });

    /**
     * The sweep is a money path, so running it twice must move value once.
     *
     * Both guards are exercised here at the same time: the second pass finds no
     * `pending` row at all (the claim is `settled`), and even a pass that DID
     * re-drive the occurrence would hit the ledger key
     * `bank.transfer:<scheduleId>:<occurrence>` and be handed the first
     * transaction back. `toBe('20')` is one whole transfer away from a failure.
     */
    it('sweeps idempotently — three passes over one stranded claim move value once', async () => {
      const { rent, schedule } = await pausedAfterFirstFiring();

      await sql`
        INSERT INTO bank.transfer_executions (schedule_id, occurrence, amount, status)
        VALUES (${schedule.id}, 1, 10, 'pending')
      `;

      const first = await bank.transfers.runDueTransfers({ now: new Date('2026-06-01T00:00:00Z'), limit: 200 });
      const second = await bank.transfers.runDueTransfers({ now: new Date('2026-06-01T00:00:00Z'), limit: 200 });
      const third = await bank.transfers.runDueTransfers({ now: new Date('2026-06-02T00:00:00Z'), limit: 200 });

      expect(first.settled).toBe(1);
      expect(second.strandedSwept).toBe(0);
      expect(second.settled).toBe(0);
      expect(third.settled).toBe(0);

      expect(formatAmount(await bank.spaces.balanceOf(rent))).toBe('20');
      expect(await bank.transfers.executions(schedule.id, 50)).toHaveLength(2);
    });

    /**
     * Cancelling does not retract a claim either — for the reason `cancelSchedule`
     * already states: cancel stops FUTURE firings and is explicitly not a
     * reversal. An occurrence already claimed is a movement this service
     * committed to.
     */
    it('finishes a claim stranded on a cancelled order', async () => {
      const { rent, schedule } = await pausedAfterFirstFiring();

      await sql`
        INSERT INTO bank.transfer_executions (schedule_id, occurrence, amount, status)
        VALUES (${schedule.id}, 1, 10, 'pending')
      `;
      await bank.transfers.cancelSchedule(schedule.id);

      const report = await bank.transfers.runDueTransfers({ now: new Date('2026-06-01T00:00:00Z'), limit: 200 });

      expect(report.settled).toBe(1);
      expect(formatAmount(await bank.spaces.balanceOf(rent))).toBe('20');
      // Cancelled it stays. Finishing a claim is not reactivation.
      expect((await bank.transfers.getSchedule(schedule.id)).status).toBe('cancelled');
      expect(await bank.transfers.executions(schedule.id, 50)).toHaveLength(2);
    });

    /**
     * A schedule that is both due AND stranded is driven ONCE.
     *
     * The two queries would otherwise overlap, and the overlap is not merely a
     * double-counted report: the sweep and the drive would each fire the same
     * pending occurrence in the same pass.
     */
    it('does not consider a schedule twice when it is both due and stranded', async () => {
      const primary = await bank.spaces.ensurePrimary(USER_A, 'USDT');
      const rent = await bank.spaces.create({ userId: USER_A, assetId: 'USDT', name: 'Rent' });
      await fund(USER_A, 'USDT', '10000');

      const schedule = await bank.transfers.schedule({
        scheduleId: randomUUID(),
        userId: USER_A,
        fromSpaceId: primary.id,
        toSpaceId: rent.id,
        amount: amt('10'),
        cadence: 'daily',
        startsAt: new Date('2026-01-01T00:00:00Z'),
      });

      await sql`
        INSERT INTO bank.transfer_executions (schedule_id, occurrence, amount, status)
        VALUES (${schedule.id}, 0, 10, 'pending')
      `;

      const report = await bank.transfers.runDueTransfers({ now: new Date('2026-01-02T00:00:00Z'), limit: 200 });

      expect(report.schedulesConsidered).toBe(1);
      expect(report.strandedSwept).toBe(0);
      // Occurrence 0 swept, occurrence 1 planned. Two movements, not three.
      expect(report.settled).toBe(2);
      expect(formatAmount(await bank.spaces.balanceOf(rent))).toBe('20');
    });

    /**
     * Concurrency, the same way the firing path is tested: six callers, one
     * outcome. Two resumes reading the same `lastFired` would each plan the same
     * skip window; the unique index on (schedule, occurrence) is what makes the
     * loser's insert a no-op rather than a second set of rows.
     */
    it('is safe to call twice at once — one resume wins and the record is written once', async () => {
      const { schedule } = await pausedAfterFirstFiring();

      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          bank.transfers.resumeSchedule(schedule.id, { now: new Date('2026-01-10T00:00:00Z') }).catch((e: unknown) => e),
        ),
      );

      expect(results.filter((r) => !(r instanceof Error))).toHaveLength(1);
      expect(await bank.transfers.executions(schedule.id, 50)).toHaveLength(10);
      expect((await bank.transfers.getSchedule(schedule.id)).status).toBe('active');
    });

    it('refuses a second resume, because the first one already ran', async () => {
      const { schedule } = await pausedAfterFirstFiring();
      await bank.transfers.resumeSchedule(schedule.id, { now: new Date('2026-01-10T00:00:00Z') });

      const err = await bank.transfers.resumeSchedule(schedule.id, { now: new Date('2026-01-10T00:00:00Z') }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BankError);
      expect((err as BankError).code).toBe('bank.schedule_inactive');
    });

    it('refuses to pause an order that is not running', async () => {
      const { schedule } = await pausedAfterFirstFiring();

      const twice = await bank.transfers.pauseSchedule(schedule.id).catch((e: unknown) => e);
      expect((twice as BankError).code).toBe('bank.schedule_inactive');

      await bank.transfers.cancelSchedule(schedule.id);
      const cancelled = await bank.transfers.pauseSchedule(schedule.id).catch((e: unknown) => e);
      expect((cancelled as BankError).code).toBe('bank.schedule_inactive');
    });

    it('distinguishes a schedule that is not paused from one that does not exist', async () => {
      const missing = await bank.transfers
        .resumeSchedule('00000000-0000-4000-8000-000000000000', { now: new Date('2026-01-10T00:00:00Z') })
        .catch((e: unknown) => e);
      expect((missing as BankError).code).toBe('bank.schedule_not_found');
    });

    /** The `IN ('active','paused')` branch of `cancelSchedule` — unreachable until now. */
    it('can be given up on while paused', async () => {
      const { rent, schedule } = await pausedAfterFirstFiring();

      await bank.transfers.cancelSchedule(schedule.id);
      expect((await bank.transfers.getSchedule(schedule.id)).status).toBe('cancelled');

      await bank.transfers.runDueTransfers({ now: new Date('2026-03-01T00:00:00Z'), limit: 200 });
      expect(formatAmount(await bank.spaces.balanceOf(rent))).toBe('10');
    });

    /**
     * Resuming after the window closed does not reanimate the order.
     *
     * The alternative — status `active` with a `next_run_at` in the past — is the
     * shape that produces a fire the moment anything reconsiders the row.
     */
    it('completes rather than reactivates when the schedule window has already closed', async () => {
      const primary = await bank.spaces.ensurePrimary(USER_A, 'USDT');
      const rent = await bank.spaces.create({ userId: USER_A, assetId: 'USDT', name: 'Rent' });
      await fund(USER_A, 'USDT', '10000');

      const schedule = await bank.transfers.schedule({
        scheduleId: randomUUID(),
        userId: USER_A,
        fromSpaceId: primary.id,
        toSpaceId: rent.id,
        amount: amt('10'),
        cadence: 'daily',
        startsAt: new Date('2026-01-01T00:00:00Z'),
        endsAt: new Date('2026-01-04T00:00:00Z'),
      });

      await bank.transfers.runDueTransfers({ now: new Date('2026-01-01T01:00:00Z'), limit: 200 });
      await bank.transfers.pauseSchedule(schedule.id);

      const report = await bank.transfers.resumeSchedule(schedule.id, { now: new Date('2026-06-01T00:00:00Z') });

      // `endsAt` is EXCLUSIVE, which `lastOccurrenceBefore` implements by asking
      // what was due one millisecond before it. So the window holds occurrences
      // 0, 1 and 2 — 1 and 2 were missed — and occurrence 3, due at exactly
      // 2026-01-04T00:00:00Z, never existed. Reporting it as missed would tell
      // the user a payment they never owed had been skipped.
      expect(report.skipped).toEqual([1, 2]);
      expect(report.schedule.status).toBe('completed');

      await bank.transfers.runDueTransfers({ now: new Date('2026-06-01T00:00:00Z'), limit: 200 });
      expect(formatAmount(await bank.spaces.balanceOf(rent))).toBe('10');
    });

    it('reports nothing skipped when the pause was shorter than one period', async () => {
      const { schedule } = await pausedAfterFirstFiring();

      const report = await bank.transfers.resumeSchedule(schedule.id, { now: new Date('2026-01-01T12:00:00Z') });
      expect(report.skipped).toEqual([]);
      expect(report.schedule.status).toBe('active');
      expect(await bank.transfers.executions(schedule.id, 50)).toHaveLength(1);
    });

    it('can be paused before it has ever fired, and starts cleanly from the next occurrence', async () => {
      const primary = await bank.spaces.ensurePrimary(USER_A, 'USDT');
      const rent = await bank.spaces.create({ userId: USER_A, assetId: 'USDT', name: 'Rent' });
      await fund(USER_A, 'USDT', '10000');

      const schedule = await bank.transfers.schedule({
        scheduleId: randomUUID(),
        userId: USER_A,
        fromSpaceId: primary.id,
        toSpaceId: rent.id,
        amount: amt('10'),
        cadence: 'daily',
        startsAt: new Date('2026-06-01T00:00:00Z'),
      });

      await bank.transfers.pauseSchedule(schedule.id);
      const report = await bank.transfers.resumeSchedule(schedule.id, { now: new Date('2026-01-01T00:00:00Z') });

      // Paused before it started: nothing was ever due, so nothing was missed.
      expect(report.skipped).toEqual([]);
      expect(report.schedule.nextRunAt.toISOString()).toBe('2026-06-01T00:00:00.000Z');
      expect(formatAmount(await bank.spaces.balanceOf(rent))).toBe('0');
    });
  });

  // ══ Earn ══════════════════════════════════════════════════════════════════

  describe('earn pools', () => {
    async function openPool(input: { apr?: number; kind?: 'flexible' | 'fixed'; termDays?: number; assetId?: string } = {}) {
      return bank.earn.createPool({
        assetId: input.assetId ?? 'USDT',
        kind: input.kind ?? 'flexible',
        name: 'Flexible USDT',
        aprBps: input.apr ?? 1000,
        termDays: input.termDays ?? null,
      });
    }

    it('moves the deposit into the ledger stake account, not into a table', async () => {
      const pool = await openPool();
      await fund(USER_A, 'USDT', '1000');

      await bank.earn.deposit({ positionId: randomUUID(), poolId: pool.id, userId: USER_A, amount: amt('400') });

      expect(await availableOf(USER_A, 'USDT')).toBe('600');
      expect(await stakedOf(USER_A, 'USDT')).toBe('400');
      expect(ledger.totalsByAsset().USDT).toBe('0');
    });

    it('refuses a deposit larger than the user holds, and records no position', async () => {
      const pool = await openPool();
      await fund(USER_A, 'USDT', '50');

      await expect(
        bank.earn.deposit({ positionId: randomUUID(), poolId: pool.id, userId: USER_A, amount: amt('500') }),
      ).rejects.toMatchObject({
        code: 'ledger.insufficient_funds',
      });

      expect(formatAmount(await bank.earn.principalOf(USER_A, 'USDT'))).toBe('0');
      expect(await stakedOf(USER_A, 'USDT')).toBe('0');
    });

    it('refuses the native asset — svc-token owns staking IFC (§8.1)', async () => {
      await expect(bank.earn.createPool({ assetId: 'IFC', kind: 'flexible', name: 'IFC pool', aprBps: 500 })).rejects.toMatchObject({
        code: 'bank.native_asset_not_earnable',
      });
    });

    it('returns the principal on withdrawal from a flexible pool', async () => {
      const pool = await openPool();
      await fund(USER_A, 'USDT', '1000');
      const position = await bank.earn.deposit({ positionId: randomUUID(), poolId: pool.id, userId: USER_A, amount: amt('400') });

      await bank.earn.withdraw(position.id);

      expect(await availableOf(USER_A, 'USDT')).toBe('1000');
      expect(await stakedOf(USER_A, 'USDT')).toBe('0');
    });

    it('refuses to withdraw a fixed position before maturity, and moves nothing', async () => {
      const pool = await openPool({ kind: 'fixed', termDays: 90 });
      await fund(USER_A, 'USDT', '1000');
      const position = await bank.earn.deposit({ positionId: randomUUID(), poolId: pool.id, userId: USER_A, amount: amt('400') });

      await expect(bank.earn.withdraw(position.id)).rejects.toMatchObject({ code: 'bank.position_locked' });

      expect(await stakedOf(USER_A, 'USDT')).toBe('400');
      expect(await availableOf(USER_A, 'USDT')).toBe('600');
    });

    it('allows the withdrawal once the term has elapsed', async () => {
      const pool = await openPool({ kind: 'fixed', termDays: 90 });
      await fund(USER_A, 'USDT', '1000');
      const position = await bank.earn.deposit({ positionId: randomUUID(), poolId: pool.id, userId: USER_A, amount: amt('400') });

      await bank.earn.withdraw(position.id, new Date(Date.now() + 100 * DAY_MS));

      // A credit back to available is not a close. The stake pot, the row, and the books have to agree.
      expect(await availableOf(USER_A, 'USDT')).toBe('1000');
      expect(await stakedOf(USER_A, 'USDT')).toBe('0');
      const row = await sql<Array<{ status: string }>>`
        SELECT status FROM bank.earn_positions WHERE id = ${position.id}
      `;
      expect(row[0]!.status).toBe('closed');
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('refuses to withdraw twice — the principal is returned exactly once', async () => {
      const pool = await openPool();
      await fund(USER_A, 'USDT', '1000');
      const position = await bank.earn.deposit({ positionId: randomUUID(), poolId: pool.id, userId: USER_A, amount: amt('400') });

      await bank.earn.withdraw(position.id);
      await expect(bank.earn.withdraw(position.id)).rejects.toMatchObject({ code: 'bank.position_closed' });

      expect(await availableOf(USER_A, 'USDT')).toBe('1000');
    });

    it('survives concurrent withdrawals without double-paying', async () => {
      const pool = await openPool();
      await fund(USER_A, 'USDT', '1000');
      const position = await bank.earn.deposit({ positionId: randomUUID(), poolId: pool.id, userId: USER_A, amount: amt('400') });

      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          bank.earn
            .withdraw(position.id)
            .then(() => 'ok' as const)
            .catch(() => 'rejected' as const),
        ),
      );

      expect(results.filter((r) => r === 'ok')).toHaveLength(1);
      // A credit back to available is not a close. One winner releases the stake; the row and the books have to agree.
      expect(await availableOf(USER_A, 'USDT')).toBe('1000');
      expect(await stakedOf(USER_A, 'USDT')).toBe('0');
      const row = await sql<Array<{ status: string }>>`
        SELECT status FROM bank.earn_positions WHERE id = ${position.id}
      `;
      expect(row[0]!.status).toBe('closed');
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('enforces the minimum deposit', async () => {
      const pool = await bank.earn.createPool({
        assetId: 'USDT',
        kind: 'flexible',
        name: 'Big only',
        aprBps: 1000,
        minDeposit: amt('100'),
      });
      await fund(USER_A, 'USDT', '1000');

      await expect(
        bank.earn.deposit({ positionId: randomUUID(), poolId: pool.id, userId: USER_A, amount: amt('99') }),
      ).rejects.toMatchObject({
        code: 'bank.below_minimum',
      });
      expect(await stakedOf(USER_A, 'USDT')).toBe('0');
    });

    /**
     * THE REUSED REQUEST ID.
     *
     * `positionId` is caller-supplied so a retried HTTP request is the same
     * deposit. Nothing checked that a taken id belonged to the SAME deposit,
     * and `ON CONFLICT (id) DO NOTHING` cannot tell the two apart: the second
     * caller's value went into a stake pot keyed by their own id, the
     * `status = 'active'` update landed on the FIRST caller's row, and the
     * service's two answers to "how much is staked" — its table and the ledger —
     * stopped agreeing. The second caller was told their deposit was earning.
     */
    it('refuses a deposit that reuses another user position id, and moves none of their money', async () => {
      const pool = await openPool();
      await fund(USER_A, 'USDT', '1000');
      await fund(USER_B, 'USDT', '1000');

      const shared = '7f000000-0000-4000-8000-00000000aaaa';
      await bank.earn.deposit({ poolId: pool.id, userId: USER_A, amount: amt('400'), positionId: shared });

      await expect(bank.earn.deposit({ poolId: pool.id, userId: USER_B, amount: amt('300'), positionId: shared })).rejects.toMatchObject({
        code: 'bank.position_conflict',
      });

      // B kept every unit, and holds nothing in a pot no withdrawal of theirs
      // could ever reach.
      expect(await availableOf(USER_B, 'USDT')).toBe('1000');
      expect(await stakedOf(USER_B, 'USDT')).toBe('0');

      // A's position is untouched, and the two halves of the reconciliation
      // still agree — which is the invariant this whole service rests on.
      expect(formatAmount(await bank.earn.principalOf(USER_A, 'USDT'))).toBe('400');
      expect(formatAmount(await bank.earn.stakedOf(USER_A, 'USDT'))).toBe('400');
      expect(ledger.totalsByAsset().USDT).toBe('0');
    });

    it('refuses a deposit that reuses one of the caller own position ids for a different amount', async () => {
      const pool = await openPool();
      await fund(USER_A, 'USDT', '1000');

      const shared = '7f000000-0000-4000-8000-00000000bbbb';
      await bank.earn.deposit({ poolId: pool.id, userId: USER_A, amount: amt('100'), positionId: shared });

      await expect(bank.earn.deposit({ poolId: pool.id, userId: USER_A, amount: amt('500'), positionId: shared })).rejects.toMatchObject({
        code: 'bank.position_conflict',
      });

      // The refusal is the point: without it this answered "your 500 is
      // earning" while 100 was staked and 900 sat in available.
      expect(await stakedOf(USER_A, 'USDT')).toBe('100');
      expect(await availableOf(USER_A, 'USDT')).toBe('900');
    });

    it('refuses a deposit id reused by the same caller for a different pool', async () => {
      const firstPool = await openPool();
      const otherPool = await openPool({ apr: 1200 });
      await fund(USER_A, 'USDT', '1000');

      const positionId = '7f000000-0000-4000-8000-00000000bbbd';
      await bank.earn.deposit({ poolId: firstPool.id, userId: USER_A, amount: amt('100'), positionId });

      await expect(bank.earn.deposit({ poolId: otherPool.id, userId: USER_A, amount: amt('100'), positionId })).rejects.toMatchObject({
        code: 'bank.position_conflict',
      });

      expect(await stakedOf(USER_A, 'USDT')).toBe('100');
      expect(await availableOf(USER_A, 'USDT')).toBe('900');
      expect(formatAmount(await bank.earn.poolSize(firstPool.id))).toBe('100');
      expect(formatAmount(await bank.earn.poolSize(otherPool.id))).toBe('0');
    });

    it('still treats a genuine retry of the same deposit as one deposit', async () => {
      const pool = await openPool();
      await fund(USER_A, 'USDT', '1000');

      const positionId = '7f000000-0000-4000-8000-00000000cccc';
      const first = await bank.earn.deposit({ poolId: pool.id, userId: USER_A, amount: amt('400'), positionId });
      const retry = await bank.earn.deposit({ poolId: pool.id, userId: USER_A, amount: amt('400'), positionId });

      expect(retry.id).toBe(first.id);
      expect(await stakedOf(USER_A, 'USDT')).toBe('400');
      expect(await availableOf(USER_A, 'USDT')).toBe('600');
      expect(formatAmount(await bank.earn.poolSize(pool.id))).toBe('400');
    });

    it('computes pool size from positions, with no stored total', async () => {
      const pool = await openPool();
      for (const user of [USER_A, USER_B, USER_C]) {
        await fund(user, 'USDT', '1000');
        await bank.earn.deposit({ positionId: randomUUID(), poolId: pool.id, userId: user, amount: amt('300') });
      }

      expect(formatAmount(await bank.earn.poolSize(pool.id))).toBe('900');

      const fromLedger = amt(await stakedOf(USER_A, 'USDT')) + amt(await stakedOf(USER_B, 'USDT')) + amt(await stakedOf(USER_C, 'USDT'));
      expect(formatAmount(fromLedger)).toBe('900');
    });

    it('refuses principalOf and poolSize when the table principal disagrees with the ledger stake', async () => {
      const pool = await openPool();
      await fund(USER_A, 'USDT', '1000');
      const position = await bank.earn.deposit({
        positionId: randomUUID(),
        poolId: pool.id,
        userId: USER_A,
        amount: amt('1000'),
      });

      await sql`UPDATE bank.earn_positions SET principal = '1000000' WHERE id = ${position.id}`;

      await expect(bank.earn.principalOf(USER_A, 'USDT')).rejects.toMatchObject({
        code: 'bank.earn_principal_mismatch',
      });
      await expect(bank.earn.poolSize(pool.id)).rejects.toMatchObject({
        code: 'bank.earn_principal_mismatch',
      });

      expect(formatAmount(await bank.earn.stakedOf(USER_A, 'USDT'))).toBe('1000');
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('refuses a withdraw when the column is below the stake pot, so the remainder is not stranded', async () => {
      const pool = await openPool();
      await fund(USER_A, 'USDT', '1000');
      const position = await bank.earn.deposit({
        positionId: randomUUID(),
        poolId: pool.id,
        userId: USER_A,
        amount: amt('1000'),
      });

      // Column 400, pot 1000. Paying the column and closing the row leaves 600
      // in the pot with no position left to withdraw it.
      await sql`UPDATE bank.earn_positions SET principal = '400' WHERE id = ${position.id}`;

      const withdraw = await bank.earn.withdraw(position.id).then(
        () => 'paid',
        (err: unknown) => (err instanceof BankError ? err.code : 'other'),
      );
      const row = await sql<Array<{ status: string }>>`
        SELECT status FROM bank.earn_positions WHERE id = ${position.id}
      `;
      const pot = formatAmount((await ledger.balance(earnStakeAccount(USER_A, 'USDT', position.id))).amount);

      expect({
        withdraw,
        status: row[0]!.status,
        available: await availableOf(USER_A, 'USDT'),
        pot,
      }).toEqual({
        withdraw: 'bank.earn_principal_mismatch',
        status: 'active',
        available: '0',
        pot: '1000',
      });
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('closes the row on retry when earn withdraw already posted and the close did not commit', async () => {
      const pool = await openPool({ apr: 3650 });
      await accrueBankFees('USDT', '10000');
      await bank.earn.fundPool({ poolId: pool.id, fundingId: 'crash-close-seed', amount: amt('10000') });

      await fund(USER_A, 'USDT', '1000');
      await fund(USER_B, 'USDT', '1000');
      const opened = new Date('2026-03-01T00:00:00Z');
      const crashed = await bank.earn.deposit({
        positionId: randomUUID(),
        poolId: pool.id,
        userId: USER_A,
        amount: amt('1000'),
        now: opened,
      });
      const healthy = await bank.earn.deposit({
        positionId: randomUUID(),
        poolId: pool.id,
        userId: USER_B,
        amount: amt('1000'),
        now: opened,
      });

      // The ledger commit landed; the bank close did not. Pot is 0, available
      // already holds the principal, and the row is still active.
      await ledger.post(
        recipes.earnWithdraw({
          positionId: crashed.id,
          poolId: pool.id,
          userId: USER_A,
          assetId: 'USDT',
          amount: amt('1000'),
        }),
      );

      const potOf = async (userId: string, positionId: string) =>
        formatAmount((await ledger.balance(earnStakeAccount(userId, 'USDT', positionId))).amount);
      const statusOf = async (positionId: string) => {
        const rows = await sql<Array<{ status: string }>>`
          SELECT status FROM bank.earn_positions WHERE id = ${positionId}
        `;
        return rows[0]!.status;
      };
      const withdrawPosts = () => ledger.journal().filter((tx) => tx.idempotencyKey === `bank.earn.withdraw:${crashed.id}`);

      expect(await statusOf(crashed.id)).toBe('active');
      expect(await potOf(USER_A, crashed.id)).toBe('0');
      expect(await availableOf(USER_A, 'USDT')).toBe('1000');
      expect(withdrawPosts()).toHaveLength(1);
      await expect(bank.earn.principalOf(USER_A, 'USDT')).rejects.toMatchObject({
        code: 'bank.earn_principal_mismatch',
      });
      await expect(bank.earn.poolSize(pool.id)).rejects.toMatchObject({
        code: 'bank.earn_principal_mismatch',
      });
      await expect(bank.earn.accrue({ poolId: pool.id, at: new Date('2026-03-02T00:00:00Z') })).rejects.toMatchObject({
        code: 'bank.earn_principal_mismatch',
      });

      const closed = await bank.earn.withdraw(crashed.id);

      expect(closed.status).toBe('closed');
      expect(await statusOf(crashed.id)).toBe('closed');
      expect(await availableOf(USER_A, 'USDT')).toBe('1000');
      expect(await potOf(USER_A, crashed.id)).toBe('0');
      expect(await potOf(USER_B, healthy.id)).toBe('1000');
      expect(await statusOf(healthy.id)).toBe('active');
      expect(withdrawPosts()).toHaveLength(1);
      expect(formatAmount(await bank.earn.principalOf(USER_A, 'USDT'))).toBe('0');
      expect(formatAmount(await bank.earn.principalOf(USER_B, 'USDT'))).toBe('1000');
      expect(formatAmount(await bank.earn.poolSize(pool.id))).toBe('1000');

      const day = await bank.earn.accrue({ poolId: pool.id, at: new Date('2026-03-02T00:00:00Z') });
      expect(formatAmount(day.paid)).toBe('1');
      expect(day.recipients).toBe(1);
      expect(await availableOf(USER_B, 'USDT')).toBe('1');
      expect(await availableOf(USER_A, 'USDT')).toBe('1000');
      expect(ledger.reconcile()).toEqual({ ok: true });
    });
  });

  // ══ Interest accrual ══════════════════════════════════════════════════════

  describe('interest accrual', () => {
    async function fundedPool(apr = 3650) {
      // 3650 bps = 36.5% APR = 0.1% per day on a 365-day year: exact daily maths.
      const pool = await bank.earn.createPool({ assetId: 'USDT', kind: 'flexible', name: 'Flexible', aprBps: apr });
      await accrueBankFees('USDT', '10000');
      await bank.earn.fundPool({ poolId: pool.id, fundingId: 'seed-1', amount: amt('10000') });
      return pool;
    }

    it('pays a day of interest out of the pool reserve', async () => {
      const pool = await fundedPool();
      await fund(USER_A, 'USDT', '1000');
      await bank.earn.deposit({
        positionId: randomUUID(),
        poolId: pool.id,
        userId: USER_A,
        amount: amt('1000'),
        now: new Date('2026-03-01T00:00:00Z'),
      });

      const result = await bank.earn.accrue({ poolId: pool.id, at: new Date('2026-03-02T00:00:00Z') });

      // 1000 × 3650bps ÷ 365 = 1.
      expect(formatAmount(result.paid)).toBe('1');
      expect(result.recipients).toBe(1);
      expect(await availableOf(USER_A, 'USDT')).toBe('1');
      expect(formatAmount(await bank.earn.reserveBalance(pool.id))).toBe('9999');
      expect(ledger.totalsByAsset().USDT).toBe('0');
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('is IDEMPOTENT per day — running the job twice pays once', async () => {
      const pool = await fundedPool();
      await fund(USER_A, 'USDT', '1000');
      await bank.earn.deposit({
        positionId: randomUUID(),
        poolId: pool.id,
        userId: USER_A,
        amount: amt('1000'),
        now: new Date('2026-03-01T00:00:00Z'),
      });

      const at = new Date('2026-03-02T06:00:00Z');
      const first = await bank.earn.accrue({ poolId: pool.id, at });
      const second = await bank.earn.accrue({ poolId: pool.id, at: new Date('2026-03-02T23:59:00Z') });

      expect(first.alreadyAccrued).toBe(false);
      expect(second.alreadyAccrued).toBe(true);
      expect(await availableOf(USER_A, 'USDT')).toBe('1');

      const rows = await sql`SELECT id FROM bank.interest_accruals WHERE pool_id = ${pool.id}`;
      expect(rows).toHaveLength(1);
    });

    it('is idempotent per day under a concurrent double-fire', async () => {
      const pool = await fundedPool();
      await fund(USER_A, 'USDT', '1000');
      await bank.earn.deposit({
        positionId: randomUUID(),
        poolId: pool.id,
        userId: USER_A,
        amount: amt('1000'),
        now: new Date('2026-03-01T00:00:00Z'),
      });

      const at = new Date('2026-03-02T00:00:00Z');
      await Promise.all(Array.from({ length: 6 }, () => bank.earn.accrue({ poolId: pool.id, at }).catch(() => undefined)));

      expect(await availableOf(USER_A, 'USDT')).toBe('1');
      const rows = await sql`SELECT id FROM bank.interest_accruals WHERE pool_id = ${pool.id}`;
      expect(rows).toHaveLength(1);
    });

    it('pays a different day separately', async () => {
      const pool = await fundedPool();
      await fund(USER_A, 'USDT', '1000');
      await bank.earn.deposit({
        positionId: randomUUID(),
        poolId: pool.id,
        userId: USER_A,
        amount: amt('1000'),
        now: new Date('2026-03-01T00:00:00Z'),
      });

      await bank.earn.accrue({ poolId: pool.id, at: new Date('2026-03-02T00:00:00Z') });
      await bank.earn.accrue({ poolId: pool.id, at: new Date('2026-03-03T00:00:00Z') });

      expect(await availableOf(USER_A, 'USDT')).toBe('2');
      expect(formatAmount(await bank.earn.interestPaid(pool.id))).toBe('2');
    });

    it('refuses to accrue from an unfunded pool, and moves nothing', async () => {
      const pool = await bank.earn.createPool({ assetId: 'USDT', kind: 'flexible', name: 'Empty', aprBps: 3650 });
      await fund(USER_A, 'USDT', '1000');
      await bank.earn.deposit({
        positionId: randomUUID(),
        poolId: pool.id,
        userId: USER_A,
        amount: amt('1000'),
        now: new Date('2026-03-01T00:00:00Z'),
      });

      await expect(bank.earn.accrue({ poolId: pool.id, at: new Date('2026-03-02T00:00:00Z') })).rejects.toMatchObject({
        code: 'bank.pool_underfunded',
      });

      expect(await availableOf(USER_A, 'USDT')).toBe('0');
      // And the day is NOT consumed — funding the pool must let it be re-run.
      const rows = await sql`SELECT id FROM bank.interest_accruals WHERE pool_id = ${pool.id}`;
      expect(rows).toHaveLength(0);

      await accrueBankFees('USDT', '100');
      await bank.earn.fundPool({ poolId: pool.id, fundingId: 'rescue-1', amount: amt('100') });
      const rescued = await bank.earn.accrue({ poolId: pool.id, at: new Date('2026-03-02T00:00:00Z') });
      expect(formatAmount(rescued.paid)).toBe('1');
      expect(await availableOf(USER_A, 'USDT')).toBe('1');
      expect(formatAmount(await bank.earn.reserveBalance(pool.id))).toBe('99');
      const rescuedRows = await sql`SELECT id FROM bank.interest_accruals WHERE pool_id = ${pool.id}`;
      expect(rescuedRows).toHaveLength(1);
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    /**
     * The crash window the stored plan closes: the ledger post lands, the
     * process dies before the claim records it. The next run must pay what the
     * first run planned, not what the positions look like by then.
     */
    describe('a run that dies after the ledger post', () => {
      const at = new Date('2026-03-02T00:00:00Z');

      /** A ledger whose first interest post lands and then "kills the process". */
      function dieAfterFirstInterestPost(real: MemoryLedger): LedgerClient {
        let armed = true;
        return new Proxy(real, {
          get(target, prop) {
            const value = Reflect.get(target, prop, target);
            if (typeof value !== 'function') return value;
            if (prop !== 'post') return value.bind(target);
            return async (request: Parameters<MemoryLedger['post']>[0]) => {
              const posted = await target.post(request);
              if (armed && request.idempotencyKey.startsWith('bank.interest:')) {
                armed = false;
                throw new Error('process died after the ledger post');
              }
              return posted;
            };
          },
        }) as LedgerClient;
      }

      const interestTxs = (poolId: string) =>
        ledger.journal().filter((tx) => tx.reason === 'bank.earn.interest' && tx.meta.poolId === poolId);

      async function twoPositions() {
        const pool = await bank.earn.createPool({ assetId: 'USDT', kind: 'flexible', name: 'Flexible', aprBps: 3650 });
        await accrueBankFees('USDT', '10000');
        await bank.earn.fundPool({ poolId: pool.id, fundingId: 'seed-1', amount: amt('10000') });
        const positions: Record<string, string> = {};
        for (const userId of [USER_A, USER_B]) {
          await fund(userId, 'USDT', '1000');
          const position = await bank.earn.deposit({
            positionId: randomUUID(),
            poolId: pool.id,
            userId,
            amount: amt('1000'),
            now: new Date('2026-03-01T00:00:00Z'),
          });
          positions[userId] = position.id;
        }
        return { pool, positions };
      }

      it('posts the stored plan again, not a plan rebuilt from today’s positions', async () => {
        const { pool, positions } = await twoPositions();
        const crashing = createBankServices(sql, dieAfterFirstInterestPost(ledger), memoryLedgerHistory(ledger), { nativeAssetId: 'IFC' });

        await expect(crashing.earn.accrue({ poolId: pool.id, at })).rejects.toThrow('process died after the ledger post');

        // The payment stands and the claim survived with its plan, unrecorded.
        expect(interestTxs(pool.id)).toHaveLength(1);
        const [claim] = await sql<Array<{ planned_payouts: unknown; ledger_tx_id: string | null; paid_amount: string }>>`
          SELECT planned_payouts, ledger_tx_id, paid_amount FROM bank.interest_accruals WHERE pool_id = ${pool.id}
        `;
        expect(claim!.ledger_tx_id).toBeNull();
        expect(claim!.paid_amount).toBe('0.000000000000000000');
        expect(claim!.planned_payouts).toEqual(
          [
            { userId: USER_A, amount: '1' },
            { userId: USER_B, amount: '1' },
          ].sort((a, b) => (a.userId < b.userId ? -1 : 1)),
        );

        // B leaves before the job runs again: a rebuilt plan would pay A alone.
        await bank.earn.withdraw(positions[USER_B]!);
        const beforeA = await availableOf(USER_A, 'USDT');
        const beforeB = await availableOf(USER_B, 'USDT');

        const second = await bank.earn.accrue({ poolId: pool.id, at });

        expect(second.alreadyAccrued).toBe(false);
        expect(formatAmount(second.paid)).toBe('2');
        expect(second.recipients).toBe(2);
        expect(await availableOf(USER_A, 'USDT')).toBe(beforeA);
        expect(await availableOf(USER_B, 'USDT')).toBe(beforeB);
        expect(await availableOf(USER_A, 'USDT')).toBe('1');
        expect(await availableOf(USER_B, 'USDT')).toBe('1001');

        const txs = interestTxs(pool.id);
        expect(txs).toHaveLength(1);
        expect(second.ledgerTxId).toBe(txs[0]!.id);
        const rows = await sql<Array<{ paid_amount: string; recipients: number; ledger_tx_id: string | null }>>`
          SELECT paid_amount, recipients, ledger_tx_id FROM bank.interest_accruals WHERE pool_id = ${pool.id}
        `;
        expect(rows).toHaveLength(1);
        expect(rows[0]!.recipients).toBe(2);
        expect(formatAmount(amt(rows[0]!.paid_amount))).toBe('2');
        expect(rows[0]!.ledger_tx_id).toBe(txs[0]!.id);
        expect(formatAmount(await bank.earn.interestPaid(pool.id))).toBe('2');

        // The recorded day is final: a third run posts nothing.
        const third = await bank.earn.accrue({ poolId: pool.id, at });
        expect(third.alreadyAccrued).toBe(true);
        expect(interestTxs(pool.id)).toHaveLength(1);
        expect(ledger.reconcile()).toEqual({ ok: true });
      });

      it('records the payment even if a concurrent run released the claim after the post landed', async () => {
        const { pool } = await twoPositions();
        // After the first interest post lands, another run's underfunded refusal
        // deletes the claim, as it would between our post and our UPDATE.
        let armed = true;
        const racing = new Proxy(ledger, {
          get(target, prop) {
            const value = Reflect.get(target, prop, target);
            if (typeof value !== 'function') return value;
            if (prop !== 'post') return value.bind(target);
            return async (request: Parameters<MemoryLedger['post']>[0]) => {
              const posted = await target.post(request);
              if (armed && request.idempotencyKey.startsWith('bank.interest:')) {
                armed = false;
                await sql`DELETE FROM bank.interest_accruals WHERE pool_id = ${pool.id}`;
              }
              return posted;
            };
          },
        }) as LedgerClient;
        const racer = createBankServices(sql, racing, memoryLedgerHistory(ledger), { nativeAssetId: 'IFC' });

        const result = await racer.earn.accrue({ poolId: pool.id, at });

        const txs = interestTxs(pool.id);
        expect(txs).toHaveLength(1);
        expect(result.ledgerTxId).toBe(txs[0]!.id);
        const rows = await sql<Array<{ paid_amount: string; recipients: number; ledger_tx_id: string | null; planned_payouts: unknown }>>`
          SELECT paid_amount, recipients, ledger_tx_id, planned_payouts FROM bank.interest_accruals WHERE pool_id = ${pool.id}
        `;
        expect(rows).toHaveLength(1);
        expect(rows[0]!.ledger_tx_id).toBe(txs[0]!.id);
        expect(rows[0]!.recipients).toBe(2);
        expect(formatAmount(amt(rows[0]!.paid_amount))).toBe('2');
        expect(formatAmount(await bank.earn.interestPaid(pool.id))).toBe('2');
      });

      it('accrueAll finishes an earlier day from its stored plan, then accrues today', async () => {
        const { pool, positions } = await twoPositions();
        const crashing = createBankServices(sql, dieAfterFirstInterestPost(ledger), memoryLedgerHistory(ledger), { nativeAssetId: 'IFC' });
        await expect(crashing.earn.accrue({ poolId: pool.id, at })).rejects.toThrow('process died after the ledger post');
        await bank.earn.withdraw(positions[USER_B]!);

        const report = await bank.earn.accrueAll(new Date('2026-03-03T00:00:00Z'));

        expect(report.failures).toEqual([]);
        const earlier = report.results.find((r) => r.date === '2026-03-02');
        expect(earlier).toBeDefined();
        expect(earlier!.alreadyAccrued).toBe(false);
        expect(formatAmount(earlier!.paid)).toBe('2');
        expect(earlier!.recipients).toBe(2);
        // Today is planned from today's positions: B has left.
        const today = report.results.find((r) => r.date === '2026-03-03');
        expect(today).toBeDefined();
        expect(today!.recipients).toBe(1);
        expect(formatAmount(today!.paid)).toBe('1');

        expect(interestTxs(pool.id)).toHaveLength(2);
        expect(await availableOf(USER_A, 'USDT')).toBe('2');
        expect(await availableOf(USER_B, 'USDT')).toBe('1001');
        const pending = await sql`SELECT id FROM bank.interest_accruals WHERE ledger_tx_id IS NULL AND planned_payouts IS NOT NULL`;
        expect(pending).toHaveLength(0);

        // Nothing is left to resume: a second pass pays nothing more.
        await bank.earn.accrueAll(new Date('2026-03-03T00:00:00Z'));
        expect(interestTxs(pool.id)).toHaveLength(2);
        expect(ledger.reconcile()).toEqual({ ok: true });
      });

      it('accrueAll reports an earlier day it cannot fund and keeps its plan for the next pass', async () => {
        const pool = await bank.earn.createPool({ assetId: 'USDT', kind: 'flexible', name: 'Dry', aprBps: 3650 });
        await sql`
          INSERT INTO bank.interest_accruals (pool_id, accrual_date, rate_bps, paid_amount, recipients, planned_payouts)
          VALUES (${pool.id}, '2026-03-02', 3650, 0, 0, ${sql.json([{ userId: USER_A, amount: '1' }])})
        `;

        const dry = await bank.earn.accrueAll(new Date('2026-03-03T00:00:00Z'));
        expect(dry.failures).toEqual(expect.arrayContaining([expect.objectContaining({ poolId: pool.id, code: 'bank.pool_underfunded' })]));
        expect(interestTxs(pool.id)).toHaveLength(0);
        const kept = await sql`SELECT id FROM bank.interest_accruals WHERE pool_id = ${pool.id} AND accrual_date = '2026-03-02'`;
        expect(kept).toHaveLength(1);

        await accrueBankFees('USDT', '100');
        await bank.earn.fundPool({ poolId: pool.id, fundingId: 'dry-1', amount: amt('100') });
        const funded = await bank.earn.accrueAll(new Date('2026-03-03T00:00:00Z'));
        expect(funded.results.find((r) => r.date === '2026-03-02')?.recipients).toBe(1);
        expect(await availableOf(USER_A, 'USDT')).toBe('1');
        expect(interestTxs(pool.id)).toHaveLength(1);
      });

      it('resumes once when two runs pick up the crashed day together', async () => {
        const { pool, positions } = await twoPositions();
        const crashing = createBankServices(sql, dieAfterFirstInterestPost(ledger), memoryLedgerHistory(ledger), { nativeAssetId: 'IFC' });
        await expect(crashing.earn.accrue({ poolId: pool.id, at })).rejects.toThrow('process died after the ledger post');
        await bank.earn.withdraw(positions[USER_B]!);

        const runs = await Promise.all([bank.earn.accrue({ poolId: pool.id, at }), bank.earn.accrue({ poolId: pool.id, at })]);

        for (const run of runs) {
          expect(formatAmount(run.paid)).toBe('2');
          expect(run.recipients).toBe(2);
        }
        expect(interestTxs(pool.id)).toHaveLength(1);
        expect(await availableOf(USER_A, 'USDT')).toBe('1');
        expect(await availableOf(USER_B, 'USDT')).toBe('1001');
        const rows = await sql`SELECT id FROM bank.interest_accruals WHERE pool_id = ${pool.id}`;
        expect(rows).toHaveLength(1);
      });
    });

    it('pays once when two runs claim the same day together, and neither is refused', async () => {
      const pool = await fundedPool();
      await fund(USER_A, 'USDT', '1000');
      await bank.earn.deposit({
        positionId: randomUUID(),
        poolId: pool.id,
        userId: USER_A,
        amount: amt('1000'),
        now: new Date('2026-03-01T00:00:00Z'),
      });

      const at = new Date('2026-03-02T00:00:00Z');
      const runs = await Promise.all([bank.earn.accrue({ poolId: pool.id, at }), bank.earn.accrue({ poolId: pool.id, at })]);

      for (const run of runs) expect(formatAmount(run.paid)).toBe('1');
      expect(await availableOf(USER_A, 'USDT')).toBe('1');
      expect(ledger.journal().filter((tx) => tx.reason === 'bank.earn.interest' && tx.meta.poolId === pool.id)).toHaveLength(1);
      const rows = await sql`SELECT id FROM bank.interest_accruals WHERE pool_id = ${pool.id}`;
      expect(rows).toHaveLength(1);
    });

    it('treats a row with no stored plan, or with a ledger transaction, as a finished day', async () => {
      const pool = await fundedPool();
      await fund(USER_A, 'USDT', '1000');
      await bank.earn.deposit({
        positionId: randomUUID(),
        poolId: pool.id,
        userId: USER_A,
        amount: amt('1000'),
        now: new Date('2026-03-01T00:00:00Z'),
      });

      // Written before 0032: paid, recorded, no plan.
      await sql`
        INSERT INTO bank.interest_accruals (pool_id, accrual_date, rate_bps, paid_amount, recipients, ledger_tx_id)
        VALUES (${pool.id}, '2026-03-02', 3650, 5, 1, 'legacy-tx')
      `;
      // Planned and recorded: the post is done, so nothing resumes.
      await sql`
        INSERT INTO bank.interest_accruals (pool_id, accrual_date, rate_bps, paid_amount, recipients, ledger_tx_id, planned_payouts)
        VALUES (${pool.id}, '2026-03-03', 3650, 1, 1, 'recorded-tx', ${sql.json([{ userId: USER_A, amount: '1' }])})
      `;

      const legacy = await bank.earn.accrue({ poolId: pool.id, at: new Date('2026-03-02T00:00:00Z') });
      expect(legacy.alreadyAccrued).toBe(true);
      expect(formatAmount(legacy.paid)).toBe('5');
      expect(legacy.ledgerTxId).toBe('legacy-tx');

      const recorded = await bank.earn.accrue({ poolId: pool.id, at: new Date('2026-03-03T00:00:00Z') });
      expect(recorded.alreadyAccrued).toBe(true);
      expect(recorded.ledgerTxId).toBe('recorded-tx');

      // An empty day is recorded without a plan and stays finished.
      const emptyPool = await bank.earn.createPool({ assetId: 'USDT', kind: 'flexible', name: 'Empty day', aprBps: 3650 });
      const first = await bank.earn.accrue({ poolId: emptyPool.id, at: new Date('2026-03-02T00:00:00Z') });
      const again = await bank.earn.accrue({ poolId: emptyPool.id, at: new Date('2026-03-02T12:00:00Z') });
      expect(first.alreadyAccrued).toBe(false);
      expect(again.alreadyAccrued).toBe(true);
      expect(again.recipients).toBe(0);

      expect(ledger.journal().some((tx) => tx.reason === 'bank.earn.interest')).toBe(false);
      expect(await availableOf(USER_A, 'USDT')).toBe('0');
    });

    it('plans the day again after an underfunded refusal, from the positions that exist then', async () => {
      const pool = await bank.earn.createPool({ assetId: 'USDT', kind: 'flexible', name: 'Late funding', aprBps: 3650 });
      const positions: string[] = [];
      for (const userId of [USER_A, USER_B]) {
        await fund(userId, 'USDT', '1000');
        const position = await bank.earn.deposit({
          positionId: randomUUID(),
          poolId: pool.id,
          userId,
          amount: amt('1000'),
          now: new Date('2026-03-01T00:00:00Z'),
        });
        positions.push(position.id);
      }
      const at = new Date('2026-03-02T00:00:00Z');

      await expect(bank.earn.accrue({ poolId: pool.id, at })).rejects.toMatchObject({ code: 'bank.pool_underfunded' });
      // The stored plan went with the claim: nothing is left to resume.
      expect(await sql`SELECT id FROM bank.interest_accruals WHERE pool_id = ${pool.id}`).toHaveLength(0);

      await bank.earn.withdraw(positions[1]!);
      await accrueBankFees('USDT', '100');
      await bank.earn.fundPool({ poolId: pool.id, fundingId: 'late-1', amount: amt('100') });

      const rescued = await bank.earn.accrue({ poolId: pool.id, at });
      expect(rescued.alreadyAccrued).toBe(false);
      expect(rescued.recipients).toBe(1);
      expect(formatAmount(rescued.paid)).toBe('1');
      expect(await availableOf(USER_A, 'USDT')).toBe('1');
      expect(await availableOf(USER_B, 'USDT')).toBe('1000');
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    /**
     * Isolation residual (audit B-4 class): one underfunded pool used to throw
     * out of `accrueAll` and leave every later pool unpaid for the day.
     * Single-pool `accrue` stays loud; the job entry point must continue.
     */
    it('one underfunded pool does not withhold every other pool’s yield for the day', async () => {
      // Empty pool first by name/asset sort: asset_id ASC then apr DESC —
      // both USDT; give empty a higher APR so it is first in listPools.
      const empty = await bank.earn.createPool({ assetId: 'USDT', kind: 'flexible', name: 'Empty first', aprBps: 5000 });
      const healthy = await bank.earn.createPool({ assetId: 'USDT', kind: 'flexible', name: 'Healthy', aprBps: 3650 });
      await fund(USER_A, 'USDT', '1000');
      await fund(USER_B, 'USDT', '1000');
      await bank.earn.deposit({
        positionId: randomUUID(),
        poolId: empty.id,
        userId: USER_A,
        amount: amt('1000'),
        now: new Date('2026-03-01T00:00:00Z'),
      });
      await bank.earn.deposit({
        positionId: randomUUID(),
        poolId: healthy.id,
        userId: USER_B,
        amount: amt('1000'),
        now: new Date('2026-03-01T00:00:00Z'),
      });
      await accrueBankFees('USDT', '10000');
      await bank.earn.fundPool({ poolId: healthy.id, fundingId: 'healthy-seed', amount: amt('10000') });
      // empty stays unfunded

      const report = await bank.earn.accrueAll(new Date('2026-03-02T00:00:00Z'));

      expect(report.failures).toEqual(
        expect.arrayContaining([expect.objectContaining({ poolId: empty.id, code: 'bank.pool_underfunded' })]),
      );
      expect(report.results.some((r) => r.poolId === healthy.id && formatAmount(r.paid) === '1')).toBe(true);
      expect(await availableOf(USER_B, 'USDT')).toBe('1');
      // A deposited their whole balance into the unfunded pool. pool_underfunded
      // is not proof they were unpaid, and this accrue must not invent a credit.
      expect(await availableOf(USER_A, 'USDT')).toBe('0');
      expect(ledger.journal().some((tx) => tx.reason === 'bank.earn.interest' && tx.meta.poolId === empty.id)).toBe(false);
      // Empty day not consumed.
      const emptyRows = await sql`SELECT id FROM bank.interest_accruals WHERE pool_id = ${empty.id}`;
      expect(emptyRows).toHaveLength(0);
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('does not pay interest on a position opened after the accrual moment', async () => {
      const pool = await fundedPool();
      await fund(USER_A, 'USDT', '1000');
      await bank.earn.deposit({
        positionId: randomUUID(),
        poolId: pool.id,
        userId: USER_A,
        amount: amt('1000'),
        now: new Date('2026-03-05T00:00:00Z'),
      });

      const result = await bank.earn.accrue({ poolId: pool.id, at: new Date('2026-03-02T00:00:00Z') });
      expect(result.recipients).toBe(0);
      expect(formatAmount(result.paid)).toBe('0');
      expect(await availableOf(USER_A, 'USDT')).toBe('0');
    });

    it('pays one credit per user regardless of how many positions they hold', async () => {
      const pool = await fundedPool();
      await fund(USER_A, 'USDT', '3000');
      const opened = new Date('2026-03-01T00:00:00Z');
      await bank.earn.deposit({
        poolId: pool.id,
        userId: USER_A,
        amount: amt('1000'),
        now: opened,
        positionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
      });
      await bank.earn.deposit({
        poolId: pool.id,
        userId: USER_A,
        amount: amt('1000'),
        now: opened,
        positionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
      });

      const result = await bank.earn.accrue({ poolId: pool.id, at: new Date('2026-03-02T00:00:00Z') });
      expect(result.recipients).toBe(1);
      // Two positions of 1000 at 0.1%/day = 2 interest, on top of the 1000 the
      // user did not deposit.
      expect(formatAmount(result.paid)).toBe('2');
      expect(await availableOf(USER_A, 'USDT')).toBe('1002');
    });

    it('records a zero-interest day rather than reconsidering it forever', async () => {
      const pool = await fundedPool();
      const result = await bank.earn.accrue({ poolId: pool.id, at: new Date('2026-03-02T00:00:00Z') });

      expect(result.recipients).toBe(0);
      expect(result.ledgerTxId).toBeNull();
      const rows = await sql`SELECT id FROM bank.interest_accruals WHERE pool_id = ${pool.id}`;
      expect(rows).toHaveLength(1);
    });

    it('refuses to accrue when the table principal disagrees with the ledger stake', async () => {
      const pool = await fundedPool();
      await fund(USER_A, 'USDT', '1000');
      const position = await bank.earn.deposit({
        positionId: randomUUID(),
        poolId: pool.id,
        userId: USER_A,
        amount: amt('1000'),
        now: new Date('2026-03-01T00:00:00Z'),
      });

      // Stale column: 1000× larger. Table-sourced accrue would pay 1000, not 1.
      await sql`UPDATE bank.earn_positions SET principal = '1000000' WHERE id = ${position.id}`;

      await expect(bank.earn.accrue({ poolId: pool.id, at: new Date('2026-03-02T00:00:00Z') })).rejects.toMatchObject({
        code: 'bank.earn_principal_mismatch',
      });

      expect(await availableOf(USER_A, 'USDT')).toBe('0');
      expect(await stakedOf(USER_A, 'USDT')).toBe('1000');
      expect(formatAmount(await bank.earn.reserveBalance(pool.id))).toBe('10000');
      const rows = await sql`SELECT id FROM bank.interest_accruals WHERE pool_id = ${pool.id}`;
      expect(rows).toHaveLength(0);
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('refuses a deflated table principal rather than recording a silent zero day', async () => {
      const pool = await fundedPool();
      await fund(USER_A, 'USDT', '1000');
      const position = await bank.earn.deposit({
        positionId: randomUUID(),
        poolId: pool.id,
        userId: USER_A,
        amount: amt('1000'),
        now: new Date('2026-03-01T00:00:00Z'),
      });

      await sql`UPDATE bank.earn_positions SET principal = '1' WHERE id = ${position.id}`;

      await expect(bank.earn.accrue({ poolId: pool.id, at: new Date('2026-03-02T00:00:00Z') })).rejects.toMatchObject({
        code: 'bank.earn_principal_mismatch',
      });

      expect(await availableOf(USER_A, 'USDT')).toBe('0');
      expect(await stakedOf(USER_A, 'USDT')).toBe('1000');
      const rows = await sql`SELECT id FROM bank.interest_accruals WHERE pool_id = ${pool.id}`;
      expect(rows).toHaveLength(0);
    });

    it('leaves the interest in available, never in the principal', async () => {
      const pool = await fundedPool();
      await fund(USER_A, 'USDT', '1000');
      const position = await bank.earn.deposit({
        positionId: randomUUID(),
        poolId: pool.id,
        userId: USER_A,
        amount: amt('1000'),
        now: new Date('2026-03-01T00:00:00Z'),
      });

      const before = await sql<Array<{ principal: string }>>`SELECT principal FROM bank.earn_positions WHERE id = ${position.id}`;
      await bank.earn.accrue({ poolId: pool.id, at: new Date('2026-03-02T00:00:00Z') });
      const after = await sql<Array<{ principal: string }>>`SELECT principal FROM bank.earn_positions WHERE id = ${position.id}`;

      expect(after[0]!.principal).toBe(before[0]!.principal);
      expect(await stakedOf(USER_A, 'USDT')).toBe('1000');
      expect(await availableOf(USER_A, 'USDT')).toBe('1');
    });

    /**
     * ═══════════════════════════════════════════════════════════════════════════
     * IF THE PROCESS DIES AFTER THE LEDGER POST AND BEFORE ACTIVATE, WHOSE FUNDS?
     * ═══════════════════════════════════════════════════════════════════════════
     *
     * The deposit order is claim `pending` → ledger post → UPDATE `active`.
     * A crash in that window leaves principal staked on the ledger while the
     * row stays `pending` — invisible to positionsOf / principalOf / stakedOf
     * (all filter active) and with no job to finish the claim. Loans already
     * have resumePending; earn must too.
     *
     * Recovery re-posts (idempotent on bank.earn.deposit:<positionId>) and
     * activates. Double-resume is a no-op. Withdraw refuses pending so a user
     * cannot close a half-open claim under their feet — resume first.
     */
    describe('the crash window between earn deposit ledger post and activate', () => {
      const POSITION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

      async function openFlexiblePool() {
        return bank.earn.createPool({
          assetId: 'USDT',
          kind: 'flexible',
          name: 'Crash-window USDT',
          aprBps: 1000,
        });
      }

      /**
       * Simulate the crash: row is pending, funds already moved into the
       * position's stake pot. Mirrors "process died after post, before UPDATE".
       */
      async function strandAfterPost(poolId: string, amount: string = '400') {
        await fund(USER_A, 'USDT', '1000');
        const now = new Date('2026-03-01T00:00:00Z');
        await sql`
          INSERT INTO bank.earn_positions (id, pool_id, user_id, asset_id, principal, opened_at, matures_at, status)
          VALUES (${POSITION_ID}, ${poolId}, ${USER_A}, 'USDT', ${amount}::numeric, ${now}, ${null}, 'pending')
        `;
        await ledger.post(
          recipes.earnDeposit({
            positionId: POSITION_ID,
            poolId,
            userId: USER_A,
            assetId: 'USDT',
            amount: amt(amount),
          }),
        );
      }

      it('leaves funds staked but invisible to principalOf / positions while pending', async () => {
        const pool = await openFlexiblePool();
        await strandAfterPost(pool.id);

        // Ledger has the stake; product views that only count active do not.
        expect(await stakedOf(USER_A, 'USDT')).toBe('400');
        expect(await availableOf(USER_A, 'USDT')).toBe('600');
        expect(formatAmount(await bank.earn.principalOf(USER_A, 'USDT'))).toBe('0');
        expect(formatAmount(await bank.earn.stakedOf(USER_A, 'USDT'))).toBe('0');
        expect(await bank.earn.positionsOf(USER_A, 50)).toHaveLength(0);

        const row = await sql<Array<{ status: string }>>`
          SELECT status FROM bank.earn_positions WHERE id = ${POSITION_ID}
        `;
        expect(row[0]!.status).toBe('pending');
      });

      it('resumePending activates once, reconciles principalOf/stakedOf, and is double-safe', async () => {
        const pool = await openFlexiblePool();
        await strandAfterPost(pool.id);

        const first = await bank.earn.resumePending(100);
        expect(first).toHaveLength(1);
        expect(first[0]).toMatchObject({ positionId: POSITION_ID, outcome: 'completed' });

        const pos = await bank.earn.position(POSITION_ID);
        expect(pos.status).toBe('active');
        expect(formatAmount(await bank.earn.principalOf(USER_A, 'USDT'))).toBe('400');
        expect(formatAmount(await bank.earn.stakedOf(USER_A, 'USDT'))).toBe('400');
        expect(await stakedOf(USER_A, 'USDT')).toBe('400');
        expect(await availableOf(USER_A, 'USDT')).toBe('600');
        expect(await bank.earn.positionsOf(USER_A, 50)).toHaveLength(1);

        // Second pass: nothing left pending, ledger did not double-stake.
        const second = await bank.earn.resumePending(100);
        expect(second).toHaveLength(0);
        expect(await stakedOf(USER_A, 'USDT')).toBe('400');
        expect(formatAmount(await bank.earn.principalOf(USER_A, 'USDT'))).toBe('400');
      });

      it('refuses withdraw while the position is still pending', async () => {
        const pool = await openFlexiblePool();
        await strandAfterPost(pool.id);

        await expect(bank.earn.withdraw(POSITION_ID)).rejects.toMatchObject({
          code: 'bank.position_pending',
        });
        // Funds still staked; claim still pending.
        expect(await stakedOf(USER_A, 'USDT')).toBe('400');
        const row = await sql<Array<{ status: string }>>`
          SELECT status FROM bank.earn_positions WHERE id = ${POSITION_ID}
        `;
        expect(row[0]!.status).toBe('pending');
      });

      it('after resume, withdraw returns the principal exactly once', async () => {
        const pool = await openFlexiblePool();
        await strandAfterPost(pool.id);
        await bank.earn.resumePending(100);

        await bank.earn.withdraw(POSITION_ID);
        expect(await availableOf(USER_A, 'USDT')).toBe('1000');
        expect(await stakedOf(USER_A, 'USDT')).toBe('0');
        await expect(bank.earn.withdraw(POSITION_ID)).rejects.toMatchObject({ code: 'bank.position_closed' });
      });
    });
  });

  // ══ Spend analytics ═══════════════════════════════════════════════════════

  describe('spend analytics are computed, not accumulated', () => {
    it('buckets outflows by ledger reason code', async () => {
      const primary = await bank.spaces.ensurePrimary(USER_A, 'USDT');
      const rent = await bank.spaces.create({ userId: USER_A, assetId: 'USDT', name: 'Rent' });
      await fund(USER_A, 'USDT', '1000');

      await bank.transfers.transfer({ transferId: 'analytics-1', fromSpaceId: primary.id, toSpaceId: rent.id, amount: amt('200') });
      await ledger.post(
        recipes.feeCharge({
          chargeId: 'analytics-fee-1',
          userId: USER_A,
          module: 'bank',
          mode: 'asset',
          assetId: 'USDT',
          amount: amt('5'),
        }),
      );

      const summary = await bank.analytics.spendSummary({
        userId: USER_A,
        assetId: 'USDT',
        range: { from: new Date(Date.now() - DAY_MS), to: new Date(Date.now() + DAY_MS) },
      });

      expect(summary.outflowByCategory.fees).toBe('5');
      // The transfer left the primary space AND arrived in the named one, so it
      // shows as an outflow of 200 with a matching inflow — moving your own
      // money between your own pots is not spending it.
      expect(summary.outflowByCategory.transfers).toBe('200');
      // fund() posts deposit.credited for 1000. That arrival is a deposit, not a reward.
      expect(summary.outflowByCategory.deposits).toBe('1000');
      expect(summary.outflowByCategory.rewards).toBe('0');
      expect(summary.totalOutflow).toBe('205');
      expect(summary.totalInflow).toBe('1200');
    });

    it('reports nothing outside the window', async () => {
      const primary = await bank.spaces.ensurePrimary(USER_A, 'USDT');
      const rent = await bank.spaces.create({ userId: USER_A, assetId: 'USDT', name: 'Rent' });
      await fund(USER_A, 'USDT', '1000');
      await bank.transfers.transfer({ transferId: 'analytics-2', fromSpaceId: primary.id, toSpaceId: rent.id, amount: amt('200') });

      const summary = await bank.analytics.spendSummary({
        userId: USER_A,
        assetId: 'USDT',
        range: { from: new Date('2020-01-01T00:00:00Z'), to: new Date('2020-02-01T00:00:00Z') },
      });

      expect(summary.movements).toBe(0);
      expect(summary.totalOutflow).toBe('0');
      expect(summary.outflowByCategory.deposits).toBe('0');
    });

    it('gives the same answer twice — nothing is consumed by asking', async () => {
      const primary = await bank.spaces.ensurePrimary(USER_A, 'USDT');
      const rent = await bank.spaces.create({ userId: USER_A, assetId: 'USDT', name: 'Rent' });
      await fund(USER_A, 'USDT', '1000');
      await bank.transfers.transfer({ transferId: 'analytics-3', fromSpaceId: primary.id, toSpaceId: rent.id, amount: amt('123.456') });

      const range = { from: new Date(Date.now() - DAY_MS), to: new Date(Date.now() + DAY_MS) };
      const first = await bank.analytics.spendSummary({ userId: USER_A, assetId: 'USDT', range });
      const second = await bank.analytics.spendSummary({ userId: USER_A, assetId: 'USDT', range });

      expect(second).toEqual(first);
    });
  });

  // ══ The whole book, after a mixed run ═════════════════════════════════════

  describe('the books close after a mixed run', () => {
    it('totalsByAsset is zero and reconcile is clean', async () => {
      const primaryA = await bank.spaces.ensurePrimary(USER_A, 'USDT');
      const rent = await bank.spaces.create({ userId: USER_A, assetId: 'USDT', name: 'Rent' });
      const primaryB = await bank.spaces.ensurePrimary(USER_B, 'USDT');
      await bank.spaces.ensurePrimary(USER_C, 'EUR');

      await fund(USER_A, 'USDT', '5000');
      await fund(USER_B, 'USDT', '2000');
      await fund(USER_C, 'EUR', '900');

      // A one-off transfer, a peer transfer, a standing order that fires and one
      // that cannot, an earn deposit, a withdrawal, and two days of interest.
      await bank.transfers.transfer({ transferId: 'mixed-1', fromSpaceId: primaryA.id, toSpaceId: rent.id, amount: amt('750') });
      await bank.transfers.transfer({ transferId: 'mixed-2', fromSpaceId: primaryA.id, toSpaceId: primaryB.id, amount: amt('250') });

      const good = await bank.transfers.schedule({
        scheduleId: randomUUID(),
        userId: USER_A,
        fromSpaceId: primaryA.id,
        toSpaceId: rent.id,
        amount: amt('100'),
        cadence: 'daily',
        startsAt: new Date('2026-01-01T00:00:00Z'),
      });
      const doomed = await bank.transfers.schedule({
        scheduleId: randomUUID(),
        userId: USER_C,
        fromSpaceId: (await bank.spaces.ensurePrimary(USER_C, 'EUR')).id,
        toSpaceId: (await bank.spaces.create({ userId: USER_C, assetId: 'EUR', name: 'Nope' })).id,
        amount: amt('100000'),
        cadence: 'daily',
        startsAt: new Date('2026-01-01T00:00:00Z'),
      });

      await bank.transfers.runDueTransfers({ now: new Date('2026-01-03T00:00:00Z'), limit: 200 });

      const pool = await bank.earn.createPool({ assetId: 'USDT', kind: 'flexible', name: 'Flexible', aprBps: 3650 });
      await accrueBankFees('USDT', '500');
      await bank.earn.fundPool({ poolId: pool.id, fundingId: 'mixed-seed', amount: amt('500') });

      await bank.earn.deposit({
        positionId: randomUUID(),
        poolId: pool.id,
        userId: USER_B,
        amount: amt('2000'),
        now: new Date('2026-01-01T00:00:00Z'),
      });
      await bank.earn.accrue({ poolId: pool.id, at: new Date('2026-01-02T00:00:00Z') });
      await bank.earn.accrue({ poolId: pool.id, at: new Date('2026-01-03T00:00:00Z') });

      const positions = await bank.earn.positionsOf(USER_B, 50);
      await bank.earn.withdraw(positions[0]!.id);

      // Every asset in the book nets to zero: nothing was created or destroyed.
      const totals = ledger.totalsByAsset();
      for (const [asset, total] of Object.entries(totals)) {
        expect(`${asset}=${total}`).toBe(`${asset}=0`);
      }
      expect(ledger.reconcile()).toEqual({ ok: true });
      expect(ledger.verifyChain()).toEqual({ ok: true });

      // And the doomed schedule moved nothing.
      const doomedExecutions = await bank.transfers.executions(doomed.id, 50);
      expect(doomedExecutions.every((e) => e.status === 'rejected')).toBe(true);
      expect(await availableOf(USER_C, 'EUR')).toBe('900');

      const goodExecutions = await bank.transfers.executions(good.id, 50);
      expect(goodExecutions.filter((e) => e.status === 'settled').length).toBeGreaterThan(0);
    });
  });

  // ══ DOCTRINE §0.6 — enforced from inside ══════════════════════════════════

  describe('doctrine §0.6 — no balance outside the ledger', () => {
    it("a space's reported balance ALWAYS equals the ledger's, across every space and asset", async () => {
      const primaryUsdt = await bank.spaces.ensurePrimary(USER_A, 'USDT');
      const rent = await bank.spaces.create({ userId: USER_A, assetId: 'USDT', name: 'Rent' });
      const holiday = await bank.spaces.create({ userId: USER_A, assetId: 'USDT', name: 'Holiday' });
      const primaryEur = await bank.spaces.ensurePrimary(USER_A, 'EUR');

      await fund(USER_A, 'USDT', '1234.567891');
      await fund(USER_A, 'EUR', '99.5');
      await bank.transfers.transfer({ transferId: 'doctrine-1', fromSpaceId: primaryUsdt.id, toSpaceId: rent.id, amount: amt('400.1') });
      await bank.transfers.transfer({
        transferId: 'doctrine-2',
        fromSpaceId: primaryUsdt.id,
        toSpaceId: holiday.id,
        amount: amt('0.000001'),
      });

      // THE assertion. Two independent answers to "how much is in this space" —
      // the one svc-bank reports, and the one the book holds — for every space.
      for (const space of [primaryUsdt, rent, holiday, primaryEur]) {
        const fromService = formatAmount(await bank.spaces.balanceOf(space));
        const fromLedger = formatAmount((await ledger.balance(accountForSpace(space))).amount);
        expect(`${space.name}:${fromService}`).toBe(`${space.name}:${fromLedger}`);
      }

      // And the user's USDT spaces sum to exactly what was deposited: no space
      // invented or lost a unit of the user's money.
      const usdtTotal =
        (await bank.spaces.balanceOf(primaryUsdt)) + (await bank.spaces.balanceOf(rent)) + (await bank.spaces.balanceOf(holiday));
      expect(formatAmount(usdtTotal)).toBe('1234.567891');
    });

    it('earn principal in this table always equals the ledger stake account', async () => {
      const pool = await bank.earn.createPool({ assetId: 'USDT', kind: 'flexible', name: 'Flexible', aprBps: 1000 });
      const fixed = await bank.earn.createPool({ assetId: 'USDT', kind: 'fixed', name: 'Fixed 90', aprBps: 2000, termDays: 90 });

      await fund(USER_A, 'USDT', '10000');
      await fund(USER_B, 'USDT', '5000');
      await bank.earn.deposit({ positionId: randomUUID(), poolId: pool.id, userId: USER_A, amount: amt('4000') });
      await bank.earn.deposit({ positionId: randomUUID(), poolId: fixed.id, userId: USER_A, amount: amt('1000') });
      await bank.earn.deposit({ positionId: randomUUID(), poolId: pool.id, userId: USER_B, amount: amt('5000') });

      // The two independent answers to "how much is earning" must agree. That
      // they CAN be compared is the point of keeping value in the ledger and
      // only terms here.
      for (const user of [USER_A, USER_B]) {
        const fromTable = formatAmount(await bank.earn.principalOf(user, 'USDT'));
        const fromLedger = formatAmount(await bank.earn.stakedOf(user, 'USDT'));
        expect(`${user}:${fromTable}`).toBe(`${user}:${fromLedger}`);
      }

      expect(formatAmount(await bank.earn.principalOf(USER_A, 'USDT'))).toBe('5000');
    });

    it('interest recorded per day always equals what left the pool reserve', async () => {
      const pool = await bank.earn.createPool({ assetId: 'USDT', kind: 'flexible', name: 'Flexible', aprBps: 3650 });
      await accrueBankFees('USDT', '1000');
      await bank.earn.fundPool({ poolId: pool.id, fundingId: 'audit-1', amount: amt('1000') });

      await fund(USER_A, 'USDT', '5000');
      await bank.earn.deposit({
        positionId: randomUUID(),
        poolId: pool.id,
        userId: USER_A,
        amount: amt('5000'),
        now: new Date('2026-04-01T00:00:00Z'),
      });

      for (const day of ['2026-04-02', '2026-04-03', '2026-04-04']) {
        await bank.earn.accrue({ poolId: pool.id, at: new Date(`${day}T00:00:00Z`) });
      }

      const fromTable = await bank.earn.interestPaid(pool.id);
      const reserveNow = (await ledger.balance(earnPoolReserve(pool.id, 'USDT'))).amount;
      const paidOut = amt('1000') - reserveNow;

      expect(formatAmount(fromTable)).toBe(formatAmount(paidOut));
      expect(formatAmount(fromTable)).toBe('15');
    });

    /**
     * THE SCHEMA GUARD.
     *
     * Every check above proves the service currently agrees with the ledger.
     * This one proves it CANNOT quietly stop: it reads the live schema and
     * fails on any column whose name suggests an accumulating figure, and on
     * any money-typed column that is not on an explicit, reasoned allowlist.
     *
     * The point is that adding `spaces.balance` — the single most tempting
     * change anyone will ever propose to this service — turns a green build
     * red, with the doctrine quoted in the failure.
     */
    it('has NO balance-like column anywhere in the bank schema', async () => {
      expect(moneyScaleFixtureReport()).toEqual({
        'numeric(38,18)': { ok: true, illegalType: [], wrongScale: [] },
        'double precision': { ok: false, illegalType: ['fixture.slipped'], wrongScale: [] },
        real: { ok: false, illegalType: ['fixture.slipped'], wrongScale: [] },
        money: { ok: false, illegalType: ['fixture.slipped'], wrongScale: [] },
        'numeric(38) scale not 18': { ok: false, illegalType: [], wrongScale: ['fixture.kept'] },
      });

      const columns = await sql<BankSchemaColumn[]>`
        SELECT table_name, column_name, data_type, numeric_precision, numeric_scale
          FROM information_schema.columns
         WHERE table_schema = 'bank' AND table_name <> '__migrations'
         ORDER BY table_name, column_name
      `;

      expect(columns.length).toBeGreaterThan(0);
      expect(columns.every((column) => Object.hasOwn(column, 'numeric_scale'))).toBe(true);

      // Names that describe an accumulating figure — a second source of truth
      // for money by any other name.
      const FORBIDDEN = [
        /balance/i,
        /(^|_)total($|_)/i,
        /running/i,
        /cached/i,
        /(^|_)available($|_)/i,
        /(^|_)held($|_)/i,
        /holdings/i,
        /accrued/i,
        /accumulat/i,
        /(^|_)sum($|_)/i,
        /funds/i,
        /equity/i,
        /net_worth/i,
        /outstanding/i,
      ];

      const offenders = columns.filter((c) => FORBIDDEN.some((p) => p.test(c.column_name))).map((c) => `${c.table_name}.${c.column_name}`);

      expect(
        offenders,
        `Doctrine §0.6: "No module holds its own balance." §8.1: "no new balance system — views + rails". ` +
          `These columns read as running totals: ${offenders.join(', ')}`,
      ).toEqual([]);

      /**
       * Every money-typed column, with the reason it is not a balance. A new
       * numeric(38,18) column fails here until someone writes down which of the
       * three legitimate kinds it is: a policy limit, a goal, an instruction, or
       * a record of one completed event. double precision, real, money, and an
       * allowlisted numeric(38) whose scale is not 18 fail as well.
       */
      const MONEY_COLUMNS: Record<string, string> = {
        'spaces.goal_target': 'a savings TARGET the user set — never written by a money path',
        'scheduled_transfers.amount':
          'the INSTRUCTION; a customer edit replaces it under a new revision, and the run posts the amount it locked',
        'schedule_revisions.amount': 'a RECORD of one replaced instruction; written once when an edit lands',
        'transfer_executions.amount': 'a RECORD of one completed firing; written once',
        'personal_transfers.amount': 'a RECORD of one completed personal send; written once',
        'personal_transfer_terms.per_transfer_limit': 'a POLICY ceiling on one send; no money path writes it',
        'personal_transfer_terms.daily_limit': 'a POLICY ceiling on one UTC day; no money path writes it',
        'personal_transfer_terms.fee': 'a published POLICY fee, not a collected balance',
        'limit_increase_requests.requested': 'the limit a customer ASKED for; a request, never a balance',
        'limit_increase_requests.granted': 'a POLICY ceiling compliance granted one customer; no money path writes it',
        'personal_requests.amount': 'the amount asked for, an instruction until paid',
        'earn_pools.min_deposit': 'a POLICY floor on a single deposit',
        'earn_positions.principal': 'the deposit RECORD; interest is paid to available, never added here',
        'interest_accruals.paid_amount': 'a RECORD of one day; summing the table is the lifetime figure',

        // ── Loans (§8.1) ─────────────────────────────────────────────────────
        //
        // Note what is NOT in this list, because it is the whole design: there is
        // no `loans.outstanding_principal`. A loan's debt is the number that
        // decides whether someone's collateral is sold, and a mutable money
        // column that a nightly job adds to is a figure nothing can contradict.
        // It is derived instead, in bigint, from the write-once rows below —
        // `LoanService.outstanding()`. The FORBIDDEN list above already fails the
        // build on /outstanding/ by name; this is the positive half of the same
        // rule.
        'loan_products.min_principal': 'a POLICY floor on a single draw; no money path writes it',
        'loans.principal': 'the amount DRAWN at open; recorded once, never revised — interest lives in its own table',
        'loans.opening_collateral':
          'the opening PLEDGE amount at open — a TERM for id-reuse compares, write-once; live holdings are ledger + collateral events',
        'loans.last_mark_price': 'a PRICE, not a holding — what one unit of collateral was worth at the last accepted mark',
        'loan_collateral_events.amount': 'a RECORD of one completed lock or release; written once with its ledger tx id',
        'loan_reserve_fundings.amount': 'a RECORD of one successful reserve fund post; the independent half of reconcileReserve (B-02)',
        'loan_interest_accruals.principal_basis': 'the debt one day was computed against; a SNAPSHOT so that day is re-derivable',
        'loan_interest_accruals.interest_amount': "a RECORD of one day's charge; summing the table is the lifetime figure",
        'loan_repayments.interest_amount': 'a RECORD of one completed repayment; written once',
        'loan_repayments.principal_amount': 'a RECORD of one completed repayment; written once',
        'loan_margin_calls.cure_collateral_amount':
          'a FIGURE quoted at one instant; the next mark writes a new row rather than revising this one',
        'loan_liquidations.mark_price': 'the PRICE one rung executed at, for the dispute nobody wants to have',
        'loan_liquidations.collateral_sold': 'a RECORD of one completed rung; written once',
        'loan_liquidations.proceeds': 'a RECORD of one completed rung; the four allocations below must sum to it',
        'loan_liquidations.principal_repaid': 'a RECORD of one completed rung; written once',
        'loan_liquidations.interest_repaid': 'a RECORD of one completed rung; written once',
        'loan_liquidations.penalty': 'a RECORD of one completed rung; written once',
        'loan_liquidations.surplus_returned': 'a RECORD of what went back to the borrower; written once',
        'loan_liquidations.shortfall': 'a RECORD of bad debt crystallised on a closing rung; written once',

        // ── Cards (§8.1, ledger half) ────────────────────────────────────────
        //
        // Note what is NOT in this list, because it is the same design as the
        // loans block: there is no `cards.spendable` and no
        // `cards.remaining_daily_limit`. What a card may spend is the user's
        // ledger balance less whatever is held against open authorisations, and
        // BOTH halves are ledger reads — each authorisation holds into its own
        // `withdraw:<authId>` account, so "what is currently held on this card"
        // is a sum svc-ledger already knows. A mirror of it here would be a
        // second source of truth for the number that decides whether somebody's
        // payment goes through at a till.
        'cards.per_authorization_limit':
          'a POLICY ceiling on ONE authorisation; it does not fall as the card is used and no money path writes it',
        'cards.daily_limit': 'a POLICY ceiling for a UTC day; NULL means no ceiling; spend is summed from authorisation records',
        'cards.monthly_limit': 'a POLICY ceiling for a UTC month; NULL means no ceiling; not a running total',
        'cards.cash_limit': 'a POLICY ceiling for ATM cash in a UTC day; NULL means no ceiling; not a remaining balance',
        'card_authorizations.amount': 'a RECORD of one authorisation request, in the funding asset; written once',
        'card_settlements.amount': 'a RECORD of one completed capture or reversal; written once with its ledger tx id',
        'card_cashback.amount': 'a RECORD of one reward; summing the table is the lifetime figure',

        // ── JIT conversion (§18) ─────────────────────────────────────────────
        //
        // A frozen QUOTE, not a rate table and not a second book. Note what is
        // NOT here: no `cards.rate`, no `bank.rates`, nothing a future spend
        // could be priced off. Every figure below is a record of what one feed
        // said at one named instant, written once beside the decision it
        // produced — and a deployment with no rate adapter cannot write one at
        // all, because there is no FX source in this platform to invent one from.
        'card_conversions.settlement_amount': 'a RECORD of what the merchant charged, in their currency; written once',
        'card_conversions.funding_amount': 'a RECORD of what that converted to, and what the hold moved; written once',
        'card_conversions.rate':
          'the RATE one authorisation was quoted at, frozen so a capture cannot re-quote; written once and never revised',

        // ── Ramps (§8.1 / D-S-09, crypto ledger half) ────────────────────────
        //
        // No `ramp_*.balance` and no running capacity. Amount columns are
        // records of one completed (or claimed) movement; the ledger is the
        // only place "how much is available" is answered.
        'ramp_onramps.amount': 'a RECORD of one on-ramp credit; written once with its ledger tx id',
        'ramp_offramps.amount': 'a RECORD of one off-ramp instruction; written once with hold+settle tx ids',
        'ramp_onramp_quotes.amount': 'the crypto AMOUNT the customer asked to buy on one quote; not a balance',
        'ramp_onramp_quotes.pay_amount': 'the pay amount the rate source published for that quote; written once',
        'ramp_onramp_quotes.fee': 'the fee the rate source published for that quote; not a tariff this service computed',
        'ramp_onramp_quotes.rate': 'the rate the source published for that quote; frozen on the row',
        'customer_onramps.amount': 'a copy of the quote amount on one partner instruction; this row does not credit the ledger',
        'customer_onramps.pay_amount': 'the pay amount copied onto that instruction; written once',
        'customer_onramps.fee': 'the fee copied onto that instruction; written once',
        'customer_onramps.rate': 'the rate copied onto that instruction; written once',
        'add_money_requests.amount':
          'the amount the customer asked to add on one request; kept refused or opened, never credited from here',
        'cash_out_requests.amount':
          'the amount the customer asked to cash out on one request; refused, or held, settled or given back under its own key',
        'cash_out_requests.fee': "the partner's fee for that one payout, copied once from its price; never charged from here",
        'cash_out_requests.receive_amount': 'what the partner said arrives for that one payout, copied once; not a balance',
        'cash_out_requests.returned_amount': 'a RECORD of what came back on one returned payout; credited once with its ledger tx id',
        'rail_send_intents.amount':
          'the amount the customer asked to send over a bank rail on one intent; kept refused, never held or posted from here',

        // ── Auto-invest (§31:805 F-plane) ────────────────────────────────────
        // Rules are instructions; runs are write-once records. No running balance.
        'auto_invest_rules.threshold': 'a POLICY keep-amount for a threshold sweep; instruction, not a holding',
        'auto_invest_rules.amount': 'a POLICY spend for a DCA schedule, or round-up granularity; instruction, not a holding',
        'auto_invest_runs.amount': 'a RECORD of one run (settled or rejected); written once',
        'business_accounts.spend_threshold': 'a POLICY dual-control floor; instruction, not a holding',
        'business_control_requests.spend_threshold':
          'the PROPOSED floor on one dual-control request; written once, applied by copying it onto the account',
        'business_approvals.amount': 'a RECORD of one proposed/approved transfer; written once',
        'business_payroll_lines.amount': 'a RECORD of one payroll line; written once with the run',
      };

      const guard = moneyColumnGuard(columns, MONEY_COLUMNS);
      expect(
        guard.illegalType,
        `A money column must be numeric(38,18). double precision, real, and money are not: ${guard.illegalType.join(', ')}`,
      ).toEqual([]);
      expect(
        guard.wrongScale,
        `A money column must be numeric(38,18). numeric(38) at another scale is not: ${guard.wrongScale.join(', ')}`,
      ).toEqual([]);
      expect(
        guard.undeclared,
        `Every money column in svc-bank must be a policy limit, a goal, an instruction, or a record of a ` +
          `completed event — never a running figure. Undeclared: ${guard.undeclared.join(', ')}`,
      ).toEqual([]);

      // And the allowlist must not rot: a declared column that no longer exists
      // means the reasoning above is stale. A declared numeric(38) whose scale
      // is not 18 is absent from the exact set, so it fails here too.
      expect(guard.missing).toEqual([]);
    });

    it('never writes to a money column after the row is created', async () => {
      // Behavioural proof of the same rule: run every money path this service
      // has, then confirm not one of the recorded figures changed.
      const primary = await bank.spaces.ensurePrimary(USER_A, 'USDT');
      const rent = await bank.spaces.create({ userId: USER_A, assetId: 'USDT', name: 'Rent', goalTarget: amt('5000') });
      await fund(USER_A, 'USDT', '10000');

      const schedule = await bank.transfers.schedule({
        scheduleId: randomUUID(),
        userId: USER_A,
        fromSpaceId: primary.id,
        toSpaceId: rent.id,
        amount: amt('100'),
        cadence: 'daily',
        startsAt: new Date('2026-01-01T00:00:00Z'),
      });

      const pool = await bank.earn.createPool({ assetId: 'USDT', kind: 'flexible', name: 'Flexible', aprBps: 3650 });
      await accrueBankFees('USDT', '1000');
      await bank.earn.fundPool({ poolId: pool.id, fundingId: 'immutable-1', amount: amt('1000') });
      const position = await bank.earn.deposit({
        positionId: randomUUID(),
        poolId: pool.id,
        userId: USER_A,
        amount: amt('1000'),
        now: new Date('2026-01-01T00:00:00Z'),
      });

      const snapshot = async () => ({
        goal: (await sql<Array<{ goal_target: string }>>`SELECT goal_target FROM bank.spaces WHERE id = ${rent.id}`)[0]!.goal_target,
        instruction: (await sql<Array<{ amount: string }>>`SELECT amount FROM bank.scheduled_transfers WHERE id = ${schedule.id}`)[0]!
          .amount,
        minDeposit: (await sql<Array<{ min_deposit: string }>>`SELECT min_deposit FROM bank.earn_pools WHERE id = ${pool.id}`)[0]!
          .min_deposit,
        principal: (await sql<Array<{ principal: string }>>`SELECT principal FROM bank.earn_positions WHERE id = ${position.id}`)[0]!
          .principal,
      });

      const before = await snapshot();

      await bank.transfers.runDueTransfers({ now: new Date('2026-01-04T00:00:00Z'), limit: 200 });
      await bank.earn.accrue({ poolId: pool.id, at: new Date('2026-01-02T00:00:00Z') });
      await bank.earn.accrue({ poolId: pool.id, at: new Date('2026-01-03T00:00:00Z') });
      await bank.transfers.transfer({ transferId: 'immutable-move-1', fromSpaceId: primary.id, toSpaceId: rent.id, amount: amt('50') });

      expect(await snapshot()).toEqual(before);
    });
  });

  // ══ Pure functions ════════════════════════════════════════════════════════

  describe('schedule arithmetic', () => {
    const anchor = new Date('2026-01-31T09:00:00Z');

    it('clamps monthly occurrences into short months and returns to the anchor day', () => {
      expect(occurrenceStart(anchor, 'monthly', 0).toISOString()).toBe('2026-01-31T09:00:00.000Z');
      // February has 28 days in 2026 — clamped, not rolled into March.
      expect(occurrenceStart(anchor, 'monthly', 1).toISOString()).toBe('2026-02-28T09:00:00.000Z');
      // And back to the 31st, because every occurrence is computed from the anchor.
      expect(occurrenceStart(anchor, 'monthly', 2).toISOString()).toBe('2026-03-31T09:00:00.000Z');
      expect(occurrenceStart(anchor, 'monthly', 3).toISOString()).toBe('2026-04-30T09:00:00.000Z');
    });

    it('crosses a year boundary', () => {
      expect(occurrenceStart(new Date('2026-11-15T00:00:00Z'), 'monthly', 3).toISOString()).toBe('2027-02-15T00:00:00.000Z');
    });

    it('computes daily and weekly occurrences arithmetically', () => {
      const start = new Date('2026-01-01T00:00:00Z');
      expect(occurrenceStart(start, 'daily', 10).toISOString()).toBe('2026-01-11T00:00:00.000Z');
      expect(occurrenceStart(start, 'weekly', 2).toISOString()).toBe('2026-01-15T00:00:00.000Z');
    });

    it('inverts cleanly: the due occurrence is the one that has started', () => {
      const start = new Date('2026-01-31T09:00:00Z');
      expect(dueOccurrence(start, 'monthly', new Date('2026-01-31T08:59:59Z'))).toBeNull();
      expect(dueOccurrence(start, 'monthly', new Date('2026-01-31T09:00:00Z'))).toBe(0);
      expect(dueOccurrence(start, 'monthly', new Date('2026-02-27T09:00:00Z'))).toBe(0);
      expect(dueOccurrence(start, 'monthly', new Date('2026-02-28T09:00:00Z'))).toBe(1);
      expect(dueOccurrence(start, 'monthly', new Date('2026-03-31T09:00:00Z'))).toBe(2);
    });

    it('never re-plans an occurrence that already fired', () => {
      const start = new Date('2026-01-01T00:00:00Z');
      const plan = planDue({ startsAt: start, cadence: 'daily', endsAt: null, lastFired: 3, now: new Date('2026-01-06T00:00:00Z') });
      expect(plan.occurrences).toEqual([4, 5]);
    });

    it('plans nothing when everything due has fired', () => {
      const start = new Date('2026-01-01T00:00:00Z');
      const plan = planDue({ startsAt: start, cadence: 'daily', endsAt: null, lastFired: 5, now: new Date('2026-01-06T00:00:00Z') });
      expect(plan.occurrences).toEqual([]);
      expect(plan.completed).toBe(false);
    });

    it('marks a schedule completed once its window closes', () => {
      const start = new Date('2026-01-01T00:00:00Z');
      const plan = planDue({
        startsAt: start,
        cadence: 'daily',
        endsAt: new Date('2026-01-04T00:00:00Z'),
        lastFired: null,
        now: new Date('2026-03-01T00:00:00Z'),
      });
      expect(plan.occurrences).toEqual([0, 1, 2]);
      expect(plan.completed).toBe(true);
    });
  });

  describe('interest arithmetic', () => {
    it('rounds a day of interest DOWN, never up', () => {
      // One unit of precision at 1 bps a year is far below a day's resolution:
      // it floors to nothing rather than inventing a unit the reserve must find.
      expect(dailyInterest(amt('0.000000000000000001'), 1)).toBe(0n);
      // 365 units at 10000 bps (100%) = exactly 1 a day.
      expect(formatAmount(dailyInterest(amt('365'), 10_000))).toBe('1');
      // A rate that does not divide evenly floors rather than rounds up:
      // 100 × 10% ÷ 365 = 0.027397260273972602739…, truncated at 18dp.
      expect(formatAmount(dailyInterest(amt('100'), 1000))).toBe('0.027397260273972602');
    });

    it('pays nothing on a zero rate or a closed position', () => {
      expect(dailyInterest(amt('1000'), 0)).toBe(0n);
      expect(dailyInterest(0n, 5000)).toBe(0n);
    });

    it('rejects a negative rate rather than paying a fee dressed as yield', () => {
      expect(() => dailyInterest(amt('1000'), -100)).toThrow(RangeError);
    });

    it('aggregates per user and counts dust rather than dropping it silently', () => {
      const plan = planAccrual(
        [
          { positionId: 'p1', userId: USER_A, principal: amt('365') },
          { positionId: 'p2', userId: USER_A, principal: amt('365') },
          { positionId: 'p3', userId: USER_B, principal: amt('0.000000000000000001') },
        ],
        10_000,
      );

      expect(plan.payouts).toHaveLength(1);
      expect(plan.payouts[0]?.userId).toBe(USER_A);
      expect(formatAmount(plan.payouts[0]!.amount)).toBe('2');
      expect(plan.dust).toBe(1);
      expect(formatAmount(plan.total)).toBe('2');
    });

    it('produces a deterministic entry order', () => {
      const positions = [
        { positionId: 'p1', userId: USER_C, principal: amt('365') },
        { positionId: 'p2', userId: USER_A, principal: amt('365') },
        { positionId: 'p3', userId: USER_B, principal: amt('365') },
      ];
      const first = planAccrual(positions, 10_000).payouts.map((p) => p.userId);
      const second = planAccrual([...positions].reverse(), 10_000).payouts.map((p) => p.userId);
      expect(first).toEqual(second);
      expect(first).toEqual([USER_A, USER_B, USER_C]);
    });
  });

  describe('spend categorisation', () => {
    it('maps ledger reason codes to product categories', () => {
      expect(categorise('bank.transfer.scheduled')).toBe('transfers');
      expect(categorise('bank.earn.deposited')).toBe('earn');
      expect(categorise('trade.fill')).toBe('trading');
      expect(categorise('p2p.escrow.lock')).toBe('p2p');
      expect(categorise('fee.charged')).toBe('fees');
      expect(categorise('withdraw.settled')).toBe('withdrawals');
      expect(categorise('deposit.credited')).toBe('deposits');
    });

    it('never drops an unknown reason', () => {
      expect(categorise('something.nobody.has.written.yet')).toBe('other');
    });
  });

  describe('recipe guards', () => {
    it('refuses a transfer that would change asset', () => {
      expect(() =>
        recipes.bankTransfer({
          transferId: 'guard-1',
          occurrence: 0,
          from: userAvailable(USER_A, 'USDT'),
          to: userAvailable(USER_B, 'EUR'),
          amount: amt('1'),
          kind: 'manual',
        }),
      ).toThrow(/cannot change asset/i);
    });

    it('refuses a transfer into a locked account kind', () => {
      expect(() =>
        recipes.bankTransfer({
          transferId: 'guard-2',
          occurrence: 0,
          from: userAvailable(USER_A, 'USDT'),
          to: userStake(USER_A, 'USDT', 'bank:earn:guard'),
          amount: amt('1'),
          kind: 'manual',
        }),
      ).toThrow(/available accounts only/i);
    });

    it('refuses a transfer to the same account', () => {
      expect(() =>
        recipes.bankTransfer({
          transferId: 'guard-3',
          occurrence: 0,
          from: userAvailable(USER_A, 'USDT'),
          to: userAvailable(USER_A, 'USDT'),
          amount: amt('1'),
          kind: 'manual',
        }),
      ).toThrow(/two different accounts/i);
    });

    it('derives the same idempotency key from the same (schedule, occurrence)', () => {
      const build = () =>
        recipes.bankTransfer({
          transferId: 'sched-x',
          occurrence: 7,
          from: userAvailable(USER_A, 'USDT'),
          to: userAvailable(USER_B, 'USDT'),
          amount: amt('1'),
          kind: 'scheduled',
        }).idempotencyKey;
      expect(build()).toBe('bank.transfer:sched-x:7');
      expect(build()).toBe(build());
    });

    it('derives the interest key from (pool, date)', () => {
      const request = recipes.earnInterest({
        poolId: 'pool-x',
        date: '2026-04-01',
        assetId: 'USDT',
        payouts: [{ userId: USER_A, amount: amt('1') }],
      });
      expect(request.idempotencyKey).toBe('bank.interest:pool-x:2026-04-01');
    });

    it('refuses an accrual date that is not a day', () => {
      expect(() =>
        recipes.earnInterest({
          poolId: 'pool-x',
          date: '2026-04-01T00:00:00Z',
          assetId: 'USDT',
          payouts: [{ userId: USER_A, amount: amt('1') }],
        }),
      ).toThrow(/YYYY-MM-DD/);
    });

    it('funds a pool reserve out of bank fee revenue, and the books close', async () => {
      await accrueBankFees('USDT', '250');
      expect(formatAmount((await ledger.balance(houseFees('bank', 'USDT'))).amount)).toBe('250');

      const pool = await bank.earn.createPool({ assetId: 'USDT', kind: 'flexible', name: 'Flexible', aprBps: 500 });
      await bank.earn.fundPool({ poolId: pool.id, fundingId: 'guard-fund-1', amount: amt('250') });

      expect(formatAmount((await ledger.balance(houseFees('bank', 'USDT'))).amount)).toBe('0');
      expect(formatAmount(await bank.earn.reserveBalance(pool.id))).toBe('250');
      expect(ledger.totalsByAsset().USDT).toBe('0');
    });

    it('refuses to fund a pool reserve out of revenue that does not exist', async () => {
      const pool = await bank.earn.createPool({ assetId: 'USDT', kind: 'flexible', name: 'Flexible', aprBps: 500 });
      await expect(bank.earn.fundPool({ poolId: pool.id, fundingId: 'guard-fund-2', amount: amt('1') })).rejects.toMatchObject({
        code: 'ledger.insufficient_funds',
      });
      expect(formatAmount(await bank.earn.reserveBalance(pool.id))).toBe('0');
    });
  });

  describe('lookup failures', () => {
    it('reports an unknown space rather than guessing', async () => {
      await expect(bank.spaces.get('44444444-4444-4444-8444-444444444444')).rejects.toBeInstanceOf(BankError);
    });

    it('reports an unknown pool and an unknown position', async () => {
      await expect(bank.earn.pool('44444444-4444-4444-8444-444444444444')).rejects.toMatchObject({ code: 'bank.pool_not_found' });
      await expect(bank.earn.position('44444444-4444-4444-8444-444444444444')).rejects.toMatchObject({
        code: 'bank.position_not_found',
      });
    });

    it('refuses to cancel a schedule that is not active', async () => {
      await expect(bank.transfers.cancelSchedule('44444444-4444-4444-8444-444444444444')).rejects.toMatchObject({
        code: 'bank.schedule_inactive',
      });
    });
  });

  // ══ The tRPC boundary: whose row, not just what kind ══════════════════════

  /**
   * A scope answers "may this principal do this KIND of thing". It has never
   * answered "may they do it to THIS row", and `bank:read` / `bank:write` are
   * held by every user on the platform.
   *
   * Both callers below clear every guard svc-bank declares — scope, `full`
   * verification, a region the matrix allows. That is the point: clearing all
   * of them was still enough to reach another user's standing order.
   */
  const authConfig = {
    secret: 'a-test-signing-secret-that-is-long-enough',
    issuer: 'intafaced',
    audience: 'intafaced.api',
    accessTtlSeconds: 900,
  };

  async function ctx(userId: string, scopes: string[]): Promise<Context> {
    const { token } = await issueAccessToken(
      { userId, sessionId: '77777777-7777-4777-8777-777777777777', scopes, tier: 'full', mfa: true },
      authConfig,
    );
    return { principal: await verifyAccessToken(token, authConfig), service: null, region: 'DE', requestId: 'req-1' };
  }

  const caller = async (userId: string, scopes: string[]) => router.createCaller(await ctx(userId, scopes));
  const codeOf = (err: unknown) => (err as { code?: string }).code;

  /** A standing order owned by `userId`, with one occurrence already fired. */
  async function firedStandingOrder(userId: string) {
    const primary = await bank.spaces.ensurePrimary(userId, 'USDT');
    const rent = await bank.spaces.create({ userId, assetId: 'USDT', name: 'Rent' });
    await fund(userId, 'USDT', '1000');

    const schedule = await bank.transfers.schedule({
      scheduleId: randomUUID(),
      userId,
      fromSpaceId: primary.id,
      toSpaceId: rent.id,
      amount: amt('100'),
      cadence: 'monthly',
      startsAt: new Date('2026-01-01T09:00:00Z'),
    });

    // Fire it, so `executions` has something worth stealing: an amount, a
    // status and a ledger transaction id.
    await bank.transfers.runDueTransfers({ now: new Date('2026-01-01T10:00:00Z'), limit: 200 });
    return schedule;
  }

  describe('transfers.executions is not readable by another user', () => {
    it('refuses user B the firing history of user A’s standing order', async () => {
      const schedule = await firedStandingOrder(USER_A);
      const api = await caller(USER_B, ['bank:read']);

      const err = await api.transfers.executions({ scheduleId: schedule.id, limit: 50 }).catch((e: unknown) => e);
      expect(codeOf(err)).toBe('FORBIDDEN');
    });

    it('still serves the history to the user who owns the schedule', async () => {
      const schedule = await firedStandingOrder(USER_A);
      const api = await caller(USER_A, ['bank:read']);

      // The half that matters more: a check tight enough to lock the owner out
      // is a worse bug than the leak it was written for, because it breaks
      // everybody at once instead of one row at a time.
      const executions = await api.transfers.executions({ scheduleId: schedule.id, limit: 50 });
      expect(executions).toHaveLength(1);
      expect(executions[0]).toMatchObject({ occurrence: 0, status: 'settled', amount: '100' });
    });
  });

  describe('transfers.cancel is not callable by another user', () => {
    it('refuses user B, and leaves user A’s standing order active', async () => {
      const schedule = await firedStandingOrder(USER_A);
      const api = await caller(USER_B, ['bank:write']);

      const err = await api.transfers.cancel({ scheduleId: schedule.id }).catch((e: unknown) => e);
      expect(codeOf(err)).toBe('FORBIDDEN');

      // The refusal has to come BEFORE the UPDATE. A check applied to the
      // result would refuse a caller whose write had already landed.
      expect((await bank.transfers.getSchedule(schedule.id)).status).toBe('active');
    });

    it('still lets the user who owns the schedule cancel it', async () => {
      const schedule = await firedStandingOrder(USER_A);
      const api = await caller(USER_A, ['bank:write']);

      await expect(api.transfers.cancel({ scheduleId: schedule.id })).resolves.toEqual({ cancelled: true });
      expect((await bank.transfers.getSchedule(schedule.id)).status).toBe('cancelled');
    });
  });

  /**
   * Pause and resume are `cancel`'s neighbours and carry the same risk: both are
   * writes that name somebody's standing order by id, and `bank:write` answers
   * "may this principal write bank data", never "whose". Without `assertSelf` a
   * stranger holding the scope and a schedule id could stop another user's rent
   * transfer — or restart one they had deliberately stopped, which moves value
   * on every subsequent pass.
   */
  describe('transfers.pause and transfers.resume are not callable by another user', () => {
    it('refuses user B, and leaves user A’s standing order running', async () => {
      const schedule = await firedStandingOrder(USER_A);
      const api = await caller(USER_B, ['bank:write']);

      const err = await api.transfers.pause({ scheduleId: schedule.id }).catch((e: unknown) => e);
      expect(codeOf(err)).toBe('FORBIDDEN');

      // Before the UPDATE, not after it — same ordering as `cancel`.
      expect((await bank.transfers.getSchedule(schedule.id)).status).toBe('active');
    });

    it('refuses user B a resume, and writes no skip rows on the way to refusing', async () => {
      const schedule = await firedStandingOrder(USER_A);
      await bank.transfers.pauseSchedule(schedule.id);
      const before = await bank.transfers.executions(schedule.id, 50);

      const err = await (await caller(USER_B, ['bank:write'])).transfers.resume({ scheduleId: schedule.id }).catch((e: unknown) => e);
      expect(codeOf(err)).toBe('FORBIDDEN');

      expect((await bank.transfers.getSchedule(schedule.id)).status).toBe('paused');
      expect(await bank.transfers.executions(schedule.id, 50)).toEqual(before);
    });

    it('lets the owner pause and resume, and tells them what will never be made up', async () => {
      const schedule = await firedStandingOrder(USER_A);
      const api = await caller(USER_A, ['bank:write']);

      await expect(api.transfers.pause({ scheduleId: schedule.id })).resolves.toMatchObject({ status: 'paused' });

      const resumed = await api.transfers.resume({ scheduleId: schedule.id });
      expect(resumed.status).toBe('active');
      // The wire says which occurrences were written off. A client rendering
      // only `status: 'active'` lets a user believe the missed ones are still
      // coming; they are not.
      expect(Array.isArray(resumed.skipped)).toBe(true);
    });
  });

  describe('an ownership refusal reaches the caller as FORBIDDEN', () => {
    it('survives `guard`, which used to re-wrap it as INTERNAL_SERVER_ERROR', async () => {
      // `guard` maps service errors onto tRPC codes and its fallback is a 500.
      // A TRPCError thrown inside it is already an answer; re-wrapping told the
      // caller to retry something that can never succeed, and hid every 403 in
      // this service from anything grouping on status.
      const schedule = await firedStandingOrder(USER_A);

      const read = await (
        await caller(USER_B, ['bank:read'])
      ).transfers
        .executions({ scheduleId: schedule.id, limit: 50 })
        .catch((e: unknown) => e);
      const write = await (await caller(USER_B, ['bank:write'])).transfers.cancel({ scheduleId: schedule.id }).catch((e: unknown) => e);

      expect([codeOf(read), codeOf(write)]).toEqual(['FORBIDDEN', 'FORBIDDEN']);
    });

    it('applies to the ownership checks that were already here, not only the new ones', async () => {
      // `spaces.archive` has called `assertSelf` since svc-bank shipped, and
      // has been answering 500 to every refusal the whole time.
      const space = await bank.spaces.create({ userId: USER_A, assetId: 'USDT', name: 'Rent' });
      const api = await caller(USER_B, ['bank:write']);

      const err = await api.spaces.archive({ spaceId: space.id }).catch((e: unknown) => e);
      expect(codeOf(err)).toBe('FORBIDDEN');
    });

    it('spaces.unarchive uses the same ownership refusal as spaces.archive', async () => {
      const space = await bank.spaces.create({ userId: USER_A, assetId: 'USDT', name: 'Rent' });
      const owner = await caller(USER_A, ['bank:write']);
      const stranger = await caller(USER_B, ['bank:write']);
      await owner.spaces.archive({ spaceId: space.id });

      const archived = await stranger.spaces.archive({ spaceId: space.id }).catch((e: unknown) => e);
      const unarchived = await stranger.spaces.unarchive({ spaceId: space.id }).catch((e: unknown) => e);

      expect(codeOf(unarchived)).toBe('FORBIDDEN');
      expect((unarchived as Error).message).toBe((archived as Error).message);
      expect((await bank.spaces.get(space.id)).archivedAt).toBeInstanceOf(Date);

      await expect(owner.spaces.unarchive({ spaceId: space.id })).resolves.toEqual({ archived: false });
      expect((await bank.spaces.get(space.id)).archivedAt).toBeNull();
    });
  });

  // ══ A refusal may only describe what the caller could already read ════════

  /**
   * THE EXISTENCE-AND-NAME ORACLE OVER OTHER USERS' ACCOUNTS.
   *
   * `transfers.create` takes two space ids and owner-checks one. That is right
   * for safety — the debit side is the side that can lose value — and cross-user
   * transfer is the product, pinned above by "moves value between two different
   * users spaces". Neither of those changes here.
   *
   * What was wrong is what a FAILURE said. `space-service.ts` writes its refusals
   * for the person who owns the space (`Space "Holiday fund" is archived`,
   * `Cannot transfer USDT into a EUR space`) and the router's error mapper
   * returned `err.message` verbatim for both codes. So transferring one atomic
   * unit into a guessed uuid told the caller whether that space existed, what its
   * owner had NAMED it, and which asset it held — for a space belonging to
   * somebody else, with no need for the transfer to succeed.
   *
   * Every part of that is correct in the context it was written in. The bug is
   * that nothing between them decided whether THIS caller may hear it.
   */
  describe('a failed transfer into a stranger’s space describes nothing', () => {
    /**
     * Everything a client can observe about a refusal.
     *
     * Not `.message` alone: the ADR's done bar says absent and not-yours must be
     * BYTE-IDENTICAL, and a difference in the error class, the tRPC code, or the
     * presence of a `cause` is just as good an oracle as a difference in the
     * sentence. Serialised, so the comparison is on bytes rather than on a
     * matcher's idea of equality.
     */
    const wireShape = (err: unknown) => {
      const e = err as { name?: string; code?: string; message?: string; cause?: unknown; data?: unknown };
      return JSON.stringify({
        name: e.name ?? null,
        code: e.code ?? null,
        message: e.message ?? null,
        cause: e.cause === undefined ? null : 'present',
        data: e.data ?? null,
      });
    };

    /** USER_A's own space, in the state the argument names, plus a funded USER_B. */
    async function stage(state: 'archived' | 'other-asset') {
      const mine = await bank.spaces.ensurePrimary(USER_B, 'USDT');
      await fund(USER_B, 'USDT', '10');

      if (state === 'archived') {
        const theirs = await bank.spaces.create({ userId: USER_A, assetId: 'USDT', name: 'Holiday fund' });
        await bank.spaces.archive(theirs.id);
        return { mine, theirs };
      }
      const theirs = await bank.spaces.create({ userId: USER_A, assetId: 'EUR', name: 'Holiday fund' });
      return { mine, theirs };
    }

    it('answers an archived space of another user exactly as it answers a uuid that does not exist', async () => {
      const { mine, theirs } = await stage('archived');
      const api = await caller(USER_B, ['bank:write']);

      const notYours = await api.transfers
        .create({ transferId: 'probe-0001', fromSpaceId: mine.id, toSpaceId: theirs.id, amount: '0.000000000000000001' })
        .catch((e: unknown) => e);

      const absent = await api.transfers
        .create({
          transferId: 'probe-0002',
          fromSpaceId: mine.id,
          toSpaceId: '5f2b7c1e-0000-4000-8000-000000000000',
          amount: '0.000000000000000001',
        })
        .catch((e: unknown) => e);

      // The whole ADR, as one assertion.
      expect(wireShape(notYours)).toBe(wireShape(absent));

      // And it is the RIGHT answer, not merely a consistent one: NOT_FOUND,
      // naming nothing. A FORBIDDEN here would itself confirm the id.
      expect(codeOf(notYours)).toBe('NOT_FOUND');
      expect((notYours as Error).message).toBe('No such space');

      // The specific facts that used to leak.
      expect((notYours as Error).message).not.toContain('Holiday fund');
      expect((notYours as Error).message).not.toContain('archived');
      expect((notYours as Error).message).not.toContain(theirs.id);
    });

    it('answers a foreign-asset space of another user the same way — the asset does not leak either', async () => {
      const { mine, theirs } = await stage('other-asset');
      const api = await caller(USER_B, ['bank:write']);

      const notYours = await api.transfers
        .create({ transferId: 'probe-0003', fromSpaceId: mine.id, toSpaceId: theirs.id, amount: '1' })
        .catch((e: unknown) => e);

      const absent = await api.transfers
        .create({ transferId: 'probe-0004', fromSpaceId: mine.id, toSpaceId: '5f2b7c1e-0000-4000-8000-000000000001', amount: '1' })
        .catch((e: unknown) => e);

      expect(wireShape(notYours)).toBe(wireShape(absent));
      expect((notYours as Error).message).not.toContain('EUR');
      expect((notYours as Error).message).not.toContain('Holiday fund');
    });

    it('does the same work on both paths, so the timing does not reintroduce the oracle', async () => {
      const { mine, theirs } = await stage('archived');

      /**
       * The deterministic half of "watch the timing".
       *
       * Wall-clock on a shared machine is noise; the fact underneath it is not.
       * Both refusals must issue the SAME NUMBER OF QUERIES — one for the source
       * space, one for the destination — because a short-circuit on the absent
       * path is exactly what a timing attack measures. This counts them.
       */
      let queries = 0;
      const counting = new Proxy(sql, {
        apply(target, thisArg, args: unknown[]) {
          queries++;
          return Reflect.apply(target as never, thisArg, args as never);
        },
      }) as typeof sql;

      const countingBank = createBankServices(counting, ledger, memoryLedgerHistory(ledger), { nativeAssetId: 'IFC' });
      const api = createBankRouter(countingBank).createCaller(await ctx(USER_B, ['bank:write']));

      queries = 0;
      await api.transfers
        .create({ transferId: 'timing-0001', fromSpaceId: mine.id, toSpaceId: theirs.id, amount: '1' })
        .catch((e: unknown) => e);
      const notYoursQueries = queries;

      queries = 0;
      await api.transfers
        .create({ transferId: 'timing-0002', fromSpaceId: mine.id, toSpaceId: '5f2b7c1e-0000-4000-8000-000000000002', amount: '1' })
        .catch((e: unknown) => e);
      const absentQueries = queries;

      expect(notYoursQueries).toBe(absentQueries);
      // Two, and the number is asserted so a future refactor that resolves the
      // destination twice — or not at all — is visible here rather than in a
      // latency graph.
      expect(notYoursQueries).toBe(2);
    });

    it('still gives the OWNER the full, actionable message including the name', async () => {
      // The half that matters more. A service so cautious it returns NOT_FOUND
      // to the person who set the lock is a worse bug than the leak it was
      // written for, because it breaks everybody at once.
      const primary = await bank.spaces.ensurePrimary(USER_A, 'USDT');
      await fund(USER_A, 'USDT', '100');
      const mine = await bank.spaces.create({ userId: USER_A, assetId: 'USDT', name: 'Holiday fund' });
      await bank.spaces.archive(mine.id);

      const api = await caller(USER_A, ['bank:write']);
      const err = await api.transfers
        .create({ transferId: 'owner-0001', fromSpaceId: primary.id, toSpaceId: mine.id, amount: '1' })
        .catch((e: unknown) => e);

      expect((err as Error).message).toBe('Space "Holiday fund" is archived');
      expect(codeOf(err)).toBe('CONFLICT');

      // And the cross-asset message, which is the one that tells an owner what
      // to do next rather than merely that they cannot.
      const eur = await bank.spaces.create({ userId: USER_A, assetId: 'EUR', name: 'Trip' });
      const mismatch = await api.transfers
        .create({ transferId: 'owner-0002', fromSpaceId: primary.id, toSpaceId: eur.id, amount: '1' })
        .catch((e: unknown) => e);
      expect((mismatch as Error).message).toBe('Cannot transfer USDT into a EUR space — convert first');
    });

    it('still lets a transfer to another user succeed — this is product, not a leak', async () => {
      // The behaviour the ADR explicitly protects. Paying somebody else works;
      // only the FAILURES stopped describing their account.
      const mine = await bank.spaces.ensurePrimary(USER_B, 'USDT');
      const theirs = await bank.spaces.ensurePrimary(USER_A, 'USDT');
      await fund(USER_B, 'USDT', '80');

      const api = await caller(USER_B, ['bank:write']);
      await expect(
        api.transfers.create({ transferId: 'peer-0001', fromSpaceId: mine.id, toSpaceId: theirs.id, amount: '80' }),
      ).resolves.toMatchObject({ amount: '80' });

      expect(await availableOf(USER_A, 'USDT')).toBe('80');
      expect(await availableOf(USER_B, 'USDT')).toBe('0');
    });

    it('reports the caller’s OWN empty balance honestly, even paying a stranger', async () => {
      // The gate must not flatten refusals that are about the caller's own side.
      // "You do not have the money" is theirs to read, whoever they were paying.
      const mine = await bank.spaces.ensurePrimary(USER_B, 'USDT');
      const theirs = await bank.spaces.ensurePrimary(USER_A, 'USDT');
      await fund(USER_B, 'USDT', '1');

      const api = await caller(USER_B, ['bank:write']);
      const err = await api.transfers
        .create({ transferId: 'broke-0001', fromSpaceId: mine.id, toSpaceId: theirs.id, amount: '500' })
        .catch((e: unknown) => e);

      expect(codeOf(err)).toBe('BAD_REQUEST');
      expect((err as Error).message).toContain('Insufficient USDT');
    });

    it('closes the same oracle on the standing-order surface', async () => {
      // `transfers.schedule` names two spaces and checks one, exactly as
      // `create` does, and leaked the same two facts through
      // `bank.asset_mismatch`. It matters more there: a caller could leave the
      // probe running.
      const mine = await bank.spaces.ensurePrimary(USER_B, 'USDT');
      const theirs = await bank.spaces.create({ userId: USER_A, assetId: 'EUR', name: 'Holiday fund' });
      const api = await caller(USER_B, ['bank:write']);

      const notYours = await api.transfers
        .schedule({
          scheduleId: randomUUID(),
          fromSpaceId: mine.id,
          toSpaceId: theirs.id,
          amount: '10',
          cadence: 'monthly',
          startsAt: '2026-01-01T09:00:00Z',
        })
        .catch((e: unknown) => e);

      const absent = await api.transfers
        .schedule({
          scheduleId: randomUUID(),
          fromSpaceId: mine.id,
          toSpaceId: '5f2b7c1e-0000-4000-8000-000000000003',
          amount: '10',
          cadence: 'monthly',
          startsAt: '2026-01-01T09:00:00Z',
        })
        .catch((e: unknown) => e);

      expect(wireShape(notYours)).toBe(wireShape(absent));
      expect(codeOf(notYours)).toBe('NOT_FOUND');

      // And no row was written for the probe.
      const rows = await sql`SELECT id FROM bank.scheduled_transfers WHERE from_space_id = ${mine.id}`;
      expect(rows).toHaveLength(0);
    });
  });

  describe('the error mapper returns no raw domain message by default', () => {
    it('answers a generic message with a correlation reference, and logs the detail', async () => {
      /**
       * The mapper's `default:` used to be `err.message`, which is how a
       * sentence written for an owner reached a stranger. It is now generic, and
       * the switch above it is EXHAUSTIVE over `BankErrorCode` — so this branch
       * is reachable only by a code nobody declared, which is precisely the one
       * whose message nobody vetted.
       *
       * Provoked with an undeclared code rather than by adding one, because the
       * point is what happens to a code the mapper has never seen.
       */
      const undeclared = new BankError('Space "Holiday fund" is archived and owned by user 1111', 'bank.not_a_real_code' as never);

      const logged: string[] = [];
      const realError = console.error;
      console.error = (line: unknown) => void logged.push(String(line));
      try {
        const api = await caller(USER_A, ['bank:read']);
        // `earn.pools` is the cheapest procedure to make throw from inside the
        // service, and which one it is does not matter — the mapper is shared.
        const original = bank.earn.listPools.bind(bank.earn);
        bank.earn.listPools = async () => {
          throw undeclared;
        };
        const err = await api.earn.pools({}).catch((e: unknown) => e);
        bank.earn.listPools = original;

        expect(codeOf(err)).toBe('INTERNAL_SERVER_ERROR');
        expect((err as Error).message).not.toContain('Holiday fund');
        expect((err as Error).message).toMatch(/^Bank operation failed \(ref [0-9a-f-]{36}\)$/);

        // The detail is not lost — it is where an operator can join it to the
        // reference the caller was given.
        const record = JSON.parse(logged.at(-1)!) as { correlationId: string; detail: string; event: string };
        expect(record.event).toBe('bank.undisclosed_error');
        expect(record.detail).toContain('Holiday fund');
        expect((err as Error).message).toContain(record.correlationId);
      } finally {
        console.error = realError;
      }
    });
  });
});
