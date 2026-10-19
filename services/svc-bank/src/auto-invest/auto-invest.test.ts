import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import {
  InsufficientFundsError,
  MemoryLedger,
  formatAmount,
  parseAmount,
  recipes,
  userAvailable,
  type Amount,
} from '@intafaced/ledger-client';
import { createBankServices, type BankServices } from '../bank-service.js';
import { memoryLedgerHistory } from '../analytics/ledger-history.js';
import { cardSim } from '../cards/issuer.js';
import { createBankRouter } from '../router.js';
import { spareChange, type ConvertPort } from './auto-invest-service.js';

/**
 * Unit card — bank.auto-invest F-plane (round-up residual)
 *
 * 1. Promise: §31:805 card round-ups sweep spare change into a same-asset
 *    earn pool; cross-asset refuses rates unset; no invent §8 / yield.
 * 2. Break: capture had no hook; AUTO_INVEST_ENABLED did not stop a hook.
 * 3. Done bar: capture of 4.30 @ granularity 1.00 stakes 0.70; exact
 *    multiple skips; buyAsset refuses rate_unset; kill skips; capture stands
 *    when the sweep cannot fund; runner never fires card_roundup.
 * 4. Class M
 * 5. Paths: services/svc-bank/**
 * 6. RED first: this suite
 * 7. Collision: no open bank PRs; mountain already wip
 *
 * H8a PG-hard: this file never `describe.skip` / `postgresAvailable`. CI uses
 * TEST_DATABASE_URL (per-run database via `createTestDatabase` so schema-qualified
 * `bank.*` SQL stays on `bank`). Local without that env starts Testcontainers
 * `postgres:16-alpine`. Docker/PG down is a failed suite, not a green skip.
 * The admin URL is `TEST_DATABASE_URL`, not `TEST_DATABASE_URL_BANK`: creating a
 * database needs CREATEDB, which the per-service roles deliberately lack.
 */

const amt = (v: string): Amount => parseAmount(v);

describe('spareChange — integer remainder, never a rate', () => {
  it('rounds 4.30 to the next 1.00 as 0.70', () => {
    expect(formatAmount(spareChange(amt('4.30'), amt('1')))).toBe('0.7');
  });
  it('an exact multiple produces zero — nothing to sweep', () => {
    expect(spareChange(amt('5'), amt('1'))).toBe(0n);
  });
  it('non-positive granularity produces zero rather than inventing a unit', () => {
    expect(spareChange(amt('4.30'), 0n)).toBe(0n);
  });
});

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '../..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

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
      `H8a: svc-bank auto-invest is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

describe('auto-invest (source)', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

describe('auto-invest PG-hard', () => {
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

  beforeAll(async () => {
    const admin = await openH8aAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'bank', url: admin.url, migrations });
    sql = db.sql;
  }, 120_000);

  beforeEach(async () => {
    await sql`
      TRUNCATE bank.auto_invest_runs, bank.auto_invest_rules,
               bank.interest_accruals, bank.earn_positions, bank.earn_pools,
               bank.card_cashback, bank.card_settlements, bank.card_conversions,
               bank.card_authorizations, bank.cards,
               bank.spaces
      RESTART IDENTITY CASCADE
    `;
    ledger = new MemoryLedger();
    bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      nativeAssetId: 'IFC',
      cards: { issuer: cardSim() },
    });
  }, 30_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  describe('threshold sweep — same-asset excess to earn (no rate invent)', () => {
    it('moves only the excess above threshold into the earn pool via ledger', async () => {
      const pool = await bank.earn.createPool({
        assetId: 'USDT',
        kind: 'flexible',
        name: 'Flex',
        aprBps: 3650,
        minDeposit: amt('1'),
      });
      await accrueBankFees('USDT', '100');
      await bank.earn.fundPool({ poolId: pool.id, fundingId: 'ai-fund-1', amount: amt('100') });
      await fund(USER_A, 'USDT', '1000');

      const rule = await bank.autoInvest.createThresholdSweep({
        userId: USER_A,
        assetId: 'USDT',
        threshold: amt('400'),
        targetPoolId: pool.id,
      });
      expect(rule.kind).toBe('threshold_sweep');
      expect(rule.status).toBe('active');

      const report = await bank.autoInvest.runDue({ now: new Date('2026-08-09T12:00:00Z'), limit: 200 });
      expect(report.settled).toBe(1);
      expect(report.failures).toEqual([]);

      // Keep 400 in primary; 600 staked.
      expect(await availableOf(USER_A, 'USDT')).toBe('400');
      expect(formatAmount(await bank.earn.stakedOf(USER_A, 'USDT'))).toBe('600');
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('skips when balance is at or below threshold — moves nothing', async () => {
      const pool = await bank.earn.createPool({
        assetId: 'USDT',
        kind: 'flexible',
        name: 'Flex2',
        aprBps: 3650,
      });
      await fund(USER_A, 'USDT', '50');
      await bank.autoInvest.createThresholdSweep({
        userId: USER_A,
        assetId: 'USDT',
        threshold: amt('100'),
        targetPoolId: pool.id,
      });

      const report = await bank.autoInvest.runDue({ now: new Date('2026-08-09T12:00:00Z'), limit: 200 });
      expect(report.skipped).toBe(1);
      expect(report.settled).toBe(0);
      expect(await availableOf(USER_A, 'USDT')).toBe('50');
    });

    it('a below-threshold skip occupying the sweep key is not a later settlement', async () => {
      const pool = await bank.earn.createPool({
        assetId: 'USDT',
        kind: 'flexible',
        name: 'Flex-skip-key',
        aprBps: 3650,
        minDeposit: amt('1'),
      });
      await fund(USER_A, 'USDT', '50');
      const rule = await bank.autoInvest.createThresholdSweep({
        userId: USER_A,
        assetId: 'USDT',
        threshold: amt('100'),
        targetPoolId: pool.id,
      });
      const now = new Date('2026-08-09T12:00:00.000Z');

      const first = await bank.autoInvest.runDue({ now, limit: 200 });
      expect(first.skipped).toBe(1);
      expect(first.settled).toBe(0);

      // Same timestamp, now above threshold. The skip already holds sweep:${ruleId}:${now}.
      await fund(USER_A, 'USDT', '950');
      const second = await bank.autoInvest.runDue({ now, limit: 200 });

      expect(second.settled).toBe(0);
      expect(second.skipped).toBe(1);
      expect(second.rejected).toBe(0);
      expect(await availableOf(USER_A, 'USDT')).toBe('1000');
      expect(formatAmount(await bank.earn.stakedOf(USER_A, 'USDT'))).toBe('0');
      const runs = await bank.autoInvest.runsOf(rule.id);
      expect(runs).toHaveLength(1);
      expect(runs[0]?.status).toBe('skipped');
      expect(runs[0]?.clientRunId).toBe(`sweep:${rule.id}:${now.toISOString()}`);
      expect(runs[0]?.positionId).toBeNull();
      expect(runs[0]?.amount).toBeNull();
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('a pending sweep row is not reported as settled and the excess stays available', async () => {
      const pool = await bank.earn.createPool({
        assetId: 'USDT',
        kind: 'flexible',
        name: 'Flex-pending-key',
        aprBps: 100,
        minDeposit: amt('1'),
      });
      await fund(USER_A, 'USDT', '1000');
      const rule = await bank.autoInvest.createThresholdSweep({
        userId: USER_A,
        assetId: 'USDT',
        threshold: amt('400'),
        targetPoolId: pool.id,
      });
      const now = new Date('2026-08-09T17:00:00.000Z');
      const clientRunId = `sweep:${rule.id}:${now.toISOString()}`;
      await sql`
        INSERT INTO bank.auto_invest_runs (rule_id, client_run_id, status, amount)
        VALUES (${rule.id}::uuid, ${clientRunId}, 'pending', '1'::numeric)
      `;

      const report = await bank.autoInvest.runDue({ now, limit: 200 });
      expect(report.considered).toBe(1);
      expect(report.settled).toBe(0);
      expect(report.skipped).toBe(0);
      expect(report.rejected).toBe(0);
      expect(report.failures).toEqual([]);
      expect(await availableOf(USER_A, 'USDT')).toBe('1000');
      expect(formatAmount(await bank.earn.stakedOf(USER_A, 'USDT'))).toBe('0');
      const runs = await bank.autoInvest.runsOf(rule.id);
      expect(runs).toHaveLength(1);
      expect(runs[0]?.status).toBe('pending');
      expect(runs[0]?.clientRunId).toBe(clientRunId);
      expect(formatAmount(runs[0]!.amount!)).toBe('1');
      expect(runs[0]?.positionId).toBeNull();
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('a rejected sweep row is not reported as settled and the excess stays available', async () => {
      const pool = await bank.earn.createPool({
        assetId: 'USDT',
        kind: 'flexible',
        name: 'Flex-reject-key',
        aprBps: 100,
        minDeposit: amt('80'),
      });
      await fund(USER_A, 'USDT', '100');
      const rule = await bank.autoInvest.createThresholdSweep({
        userId: USER_A,
        assetId: 'USDT',
        threshold: amt('50'),
        targetPoolId: pool.id,
      });
      const now = new Date('2026-08-09T15:00:00.000Z');

      const first = await bank.autoInvest.runDue({ now, limit: 200 });
      expect(first.rejected).toBe(1);
      expect(first.settled).toBe(0);
      expect(await availableOf(USER_A, 'USDT')).toBe('100');

      const second = await bank.autoInvest.runDue({ now, limit: 200 });
      expect(second.settled).toBe(0);
      expect(second.rejected).toBe(1);
      expect(await availableOf(USER_A, 'USDT')).toBe('100');
      expect(formatAmount(await bank.earn.stakedOf(USER_A, 'USDT'))).toBe('0');
      const runs = await bank.autoInvest.runsOf(rule.id);
      expect(runs).toHaveLength(1);
      expect(runs[0]?.status).toBe('rejected');
      expect(formatAmount(runs[0]!.amount!)).toBe('50');
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('a settled sweep is not deposited a second time', async () => {
      const pool = await bank.earn.createPool({
        assetId: 'USDT',
        kind: 'flexible',
        name: 'Flex-settled-key',
        aprBps: 3650,
        minDeposit: amt('1'),
      });
      await accrueBankFees('USDT', '100');
      await bank.earn.fundPool({ poolId: pool.id, fundingId: 'ai-fund-settled-replay', amount: amt('100') });
      await fund(USER_A, 'USDT', '1000');
      const rule = await bank.autoInvest.createThresholdSweep({
        userId: USER_A,
        assetId: 'USDT',
        threshold: amt('400'),
        targetPoolId: pool.id,
      });
      const now = new Date('2026-08-09T16:00:00.000Z');

      const first = await bank.autoInvest.runDue({ now, limit: 200 });
      expect(first.settled).toBe(1);
      expect(await availableOf(USER_A, 'USDT')).toBe('400');
      expect(formatAmount(await bank.earn.stakedOf(USER_A, 'USDT'))).toBe('600');

      // Still above threshold at the same timestamp, so the insert conflicts
      // with the settled row. That row already moved 600; the new 200 stays put.
      await fund(USER_A, 'USDT', '200');
      const second = await bank.autoInvest.runDue({ now, limit: 200 });
      expect(second.settled).toBe(1);
      expect(second.skipped).toBe(0);
      expect(second.rejected).toBe(0);
      expect(await availableOf(USER_A, 'USDT')).toBe('600');
      expect(formatAmount(await bank.earn.stakedOf(USER_A, 'USDT'))).toBe('600');
      const runs = await bank.autoInvest.runsOf(rule.id);
      expect(runs).toHaveLength(1);
      expect(runs[0]?.status).toBe('settled');
      expect(formatAmount(runs[0]!.amount!)).toBe('600');
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('refuses a pool in a different asset rather than inventing a convert', async () => {
      const pool = await bank.earn.createPool({
        assetId: 'BTC',
        kind: 'flexible',
        name: 'BTC pool',
        aprBps: 100,
      });
      await expect(
        bank.autoInvest.createThresholdSweep({
          userId: USER_A,
          assetId: 'USDT',
          threshold: amt('10'),
          targetPoolId: pool.id,
        }),
      ).rejects.toMatchObject({ code: 'bank.asset_mismatch' });
    });

    it('refuses a non-positive threshold', async () => {
      const pool = await bank.earn.createPool({
        assetId: 'USDT',
        kind: 'flexible',
        name: 'Flex3',
        aprBps: 100,
      });
      await expect(
        bank.autoInvest.createThresholdSweep({
          userId: USER_A,
          assetId: 'USDT',
          threshold: amt('0'),
          targetPoolId: pool.id,
        }),
      ).rejects.toMatchObject({ code: 'bank.auto_invest_invalid_threshold' });
    });
  });

  describe('DCA — refuse rates unset (no invent §8)', () => {
    it('refuses createDca when no ConvertPort is configured', async () => {
      await expect(
        bank.autoInvest.createDca({
          userId: USER_A,
          spendAssetId: 'USDT',
          buyAssetId: 'BTC',
          amount: amt('100'),
          cadence: 'daily',
          startsAt: new Date('2026-08-09T00:00:00Z'),
        }),
      ).rejects.toMatchObject({ code: 'bank.auto_invest_rate_unset' });
    });

    it('creates and fires DCA when a ConvertPort is injected (no rate invent in bank)', async () => {
      const convert: ConvertPort = {
        async convert(input) {
          // Test double: hold+settle spend, deposit buy 1:1. Production wires
          // trade.convert — rates never invented inside svc-bank.
          await ledger.post(
            recipes.withdrawHold({
              userId: input.userId,
              assetId: input.fromAsset,
              amount: input.fromAmount,
              rail: 'test-convert',
              withdrawalId: input.clientConvertId,
            }),
          );
          await ledger.post(
            recipes.withdrawSettle({
              userId: input.userId,
              assetId: input.fromAsset,
              amount: input.fromAmount,
              rail: 'test-convert',
              withdrawalId: input.clientConvertId,
            }),
          );
          await ledger.post(
            recipes.deposit({
              userId: input.userId,
              assetId: input.toAsset,
              amount: input.fromAmount,
              rail: 'test-convert',
              railRef: `${input.clientConvertId}:in`,
            }),
          );
          return { toAmount: input.fromAmount, ledgerTxId: `tx:${input.clientConvertId}` };
        },
      };

      bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
        nativeAssetId: 'IFC',
        autoInvest: { convert },
      });
      await fund(USER_A, 'USDT', '500');

      const rule = await bank.autoInvest.createDca({
        userId: USER_A,
        spendAssetId: 'USDT',
        buyAssetId: 'BTC',
        amount: amt('100'),
        cadence: 'daily',
        startsAt: new Date('2026-08-01T00:00:00Z'),
      });
      expect(rule.kind).toBe('dca');

      const report = await bank.autoInvest.runDue({ now: new Date('2026-08-09T00:00:00Z'), limit: 200 });
      expect(report.settled).toBe(1);
      expect(await availableOf(USER_A, 'USDT')).toBe('400');
      expect(await availableOf(USER_A, 'BTC')).toBe('100');
    });

    function bankWithConvert(convert: ConvertPort) {
      bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
        nativeAssetId: 'IFC',
        autoInvest: { convert },
      });
    }

    /** Spend the rule amount, receive a known fill. The fill is not the spend. */
    function fillingConvert(received: Amount, calls: { n: number }): ConvertPort {
      return {
        async convert(input) {
          calls.n += 1;
          await ledger.post(
            recipes.withdrawHold({
              userId: input.userId,
              assetId: input.fromAsset,
              amount: input.fromAmount,
              rail: 'test-convert',
              withdrawalId: input.clientConvertId,
            }),
          );
          await ledger.post(
            recipes.withdrawSettle({
              userId: input.userId,
              assetId: input.fromAsset,
              amount: input.fromAmount,
              rail: 'test-convert',
              withdrawalId: input.clientConvertId,
            }),
          );
          await ledger.post(
            recipes.deposit({
              userId: input.userId,
              assetId: input.toAsset,
              amount: received,
              rail: 'test-convert',
              railRef: `${input.clientConvertId}:in`,
            }),
          );
          return { toAmount: received, ledgerTxId: `tx:${input.clientConvertId}` };
        },
      };
    }

    it('a pending DCA row is not reported as settled and the spend stays available', async () => {
      const calls = { n: 0 };
      bankWithConvert(fillingConvert(amt('0.002'), calls));
      await fund(USER_A, 'USDT', '500');
      const startsAt = new Date('2026-08-09T08:00:00.000Z');
      const rule = await bank.autoInvest.createDca({
        userId: USER_A,
        spendAssetId: 'USDT',
        buyAssetId: 'BTC',
        amount: amt('100'),
        cadence: 'daily',
        startsAt,
      });
      const clientRunId = `dca:${rule.id}:${rule.nextRunAt!.toISOString()}`;
      await sql`
        INSERT INTO bank.auto_invest_runs (rule_id, client_run_id, status, amount)
        VALUES (${rule.id}::uuid, ${clientRunId}, 'pending', '100'::numeric)
      `;

      const report = await bank.autoInvest.runDue({ now: startsAt, limit: 200 });

      expect(report.considered).toBe(1);
      expect(report.settled).toBe(0);
      expect(report.skipped).toBe(0);
      expect(report.rejected).toBe(0);
      expect(report.failures).toEqual([]);
      expect(calls.n).toBe(0);
      expect(await availableOf(USER_A, 'USDT')).toBe('500');
      expect(await availableOf(USER_A, 'BTC')).toBe('0');
      const runs = await bank.autoInvest.runsOf(rule.id);
      expect(runs).toHaveLength(1);
      expect(runs[0]?.status).toBe('pending');
      expect(runs[0]?.clientRunId).toBe(clientRunId);
      expect(formatAmount(runs[0]!.amount!)).toBe('100');
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('a rule stuck pending does not starve a due rule created after it', async () => {
      const calls = { n: 0 };
      bankWithConvert(fillingConvert(amt('0.002'), calls));
      await fund(USER_A, 'USDT', '500');
      await fund(USER_B, 'USDT', '500');
      const startsAt = new Date('2026-08-09T11:00:00.000Z');
      const stuck = await bank.autoInvest.createDca({
        userId: USER_A,
        spendAssetId: 'USDT',
        buyAssetId: 'BTC',
        amount: amt('100'),
        cadence: 'daily',
        startsAt,
      });
      await sql`
        INSERT INTO bank.auto_invest_runs (rule_id, client_run_id, status, amount)
        VALUES (${stuck.id}::uuid, ${`dca:${stuck.id}:${stuck.nextRunAt!.toISOString()}`}, 'pending', '100'::numeric)
      `;
      const fresh = await bank.autoInvest.createDca({
        userId: USER_B,
        spendAssetId: 'USDT',
        buyAssetId: 'BTC',
        amount: amt('100'),
        cadence: 'daily',
        startsAt,
      });

      // A batch of one: the stuck rule is older, so it used to take the only slot on every run.
      const report = await bank.autoInvest.runDue({ now: startsAt, limit: 1 });

      expect(report.settled).toBe(1);
      expect(calls.n).toBe(1);
      expect((await bank.autoInvest.runsOf(fresh.id))[0]?.status).toBe('settled');
      expect((await bank.autoInvest.runsOf(stuck.id))[0]?.status).toBe('pending');
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('a rejected DCA row is not reported as settled and convert is not run again', async () => {
      const calls = { n: 0 };
      bankWithConvert({
        async convert() {
          calls.n += 1;
          throw new InsufficientFundsError('available', 'USDT', '100', '0');
        },
      });
      await fund(USER_A, 'USDT', '500');
      const now = new Date('2026-08-09T09:00:00.000Z');
      const rule = await bank.autoInvest.createDca({
        userId: USER_A,
        spendAssetId: 'USDT',
        buyAssetId: 'BTC',
        amount: amt('100'),
        cadence: 'daily',
        startsAt: now,
      });

      const first = await bank.autoInvest.runDue({ now, limit: 200 });
      expect(first.rejected).toBe(1);
      expect(first.settled).toBe(0);
      expect(calls.n).toBe(1);

      const second = await bank.autoInvest.runDue({ now, limit: 200 });
      expect(second.settled).toBe(0);
      expect(second.rejected).toBe(1);
      expect(second.skipped).toBe(0);
      expect(calls.n).toBe(1);
      expect(await availableOf(USER_A, 'USDT')).toBe('500');
      expect(await availableOf(USER_A, 'BTC')).toBe('0');
      const runs = await bank.autoInvest.runsOf(rule.id);
      expect(runs).toHaveLength(1);
      expect(runs[0]?.status).toBe('rejected');
      expect(formatAmount(runs[0]!.amount!)).toBe('100');
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('an UNKNOWN convert outcome leaves the DCA row pending, never rejected', async () => {
      const calls = { n: 0 };
      bankWithConvert({
        async convert() {
          calls.n += 1;
          // The reply was lost: the convert may have filled.
          throw new Error('socket hang up');
        },
      });
      await fund(USER_A, 'USDT', '500');
      const now = new Date('2026-08-09T09:30:00.000Z');
      const rule = await bank.autoInvest.createDca({
        userId: USER_A,
        spendAssetId: 'USDT',
        buyAssetId: 'BTC',
        amount: amt('100'),
        cadence: 'daily',
        startsAt: now,
      });

      const first = await bank.autoInvest.runDue({ now, limit: 200 });
      expect(first.rejected).toBe(0);
      expect(first.settled).toBe(0);
      expect(first.failures).toEqual([{ ruleId: rule.id, code: 'bank.auto_invest_run_failed' }]);
      const runs = await bank.autoInvest.runsOf(rule.id);
      expect(runs).toHaveLength(1);
      expect(runs[0]?.status).toBe('pending');
      expect(calls.n).toBe(1);
    });

    it('books the converted amount and does not convert a settled DCA row again', async () => {
      const calls = { n: 0 };
      bankWithConvert(fillingConvert(amt('0.002'), calls));
      await fund(USER_A, 'USDT', '500');
      const startsAt = new Date('2026-08-09T10:00:00.000Z');
      const rule = await bank.autoInvest.createDca({
        userId: USER_A,
        spendAssetId: 'USDT',
        buyAssetId: 'BTC',
        amount: amt('100'),
        cadence: 'daily',
        startsAt,
      });

      const first = await bank.autoInvest.runDue({ now: startsAt, limit: 200 });
      expect(first.settled).toBe(1);
      expect(calls.n).toBe(1);
      expect(await availableOf(USER_A, 'USDT')).toBe('400');
      expect(await availableOf(USER_A, 'BTC')).toBe('0.002');
      const booked = await bank.autoInvest.runsOf(rule.id);
      expect(booked).toHaveLength(1);
      expect(booked[0]?.status).toBe('settled');
      expect(formatAmount(booked[0]!.amount!)).toBe('0.002');

      // Same client_run_id is due again only if next_run_at did not move.
      // Rewind the schedule so the settled row occupies dca:${ruleId}:${nextRunAt}.
      await sql`
        UPDATE bank.auto_invest_rules SET next_run_at = ${startsAt}
         WHERE id = ${rule.id}::uuid
      `;
      const second = await bank.autoInvest.runDue({ now: startsAt, limit: 200 });
      expect(second.settled).toBe(1);
      expect(second.rejected).toBe(0);
      expect(second.skipped).toBe(0);
      expect(calls.n).toBe(1);
      expect(await availableOf(USER_A, 'USDT')).toBe('400');
      expect(await availableOf(USER_A, 'BTC')).toBe('0.002');
      const runs = await bank.autoInvest.runsOf(rule.id);
      expect(runs).toHaveLength(1);
      expect(runs[0]?.status).toBe('settled');
      expect(formatAmount(runs[0]!.amount!)).toBe('0.002');
      expect(ledger.reconcile()).toEqual({ ok: true });
    });
  });

  describe('cancel + pause + kill switch', () => {
    it('pause stops fires; resume allows them again', async () => {
      const pool = await bank.earn.createPool({
        assetId: 'USDT',
        kind: 'flexible',
        name: 'P',
        aprBps: 100,
      });
      await fund(USER_A, 'USDT', '1000');
      const rule = await bank.autoInvest.createThresholdSweep({
        userId: USER_A,
        assetId: 'USDT',
        threshold: amt('100'),
        targetPoolId: pool.id,
      });
      const paused = await bank.autoInvest.pauseRule(rule.id);
      expect(paused.status).toBe('paused');
      let report = await bank.autoInvest.runDue({ now: new Date('2026-08-09T12:00:00Z'), limit: 200 });
      expect(report.considered).toBe(0);
      expect(await availableOf(USER_A, 'USDT')).toBe('1000');

      const resumed = await bank.autoInvest.resumeRule(rule.id);
      expect(resumed.status).toBe('active');
      report = await bank.autoInvest.runDue({ now: new Date('2026-08-09T12:00:00Z'), limit: 200 });
      expect(report.settled).toBe(1);
      expect(await availableOf(USER_A, 'USDT')).toBe('100');
    });

    it('cancel stops future fires', async () => {
      const pool = await bank.earn.createPool({
        assetId: 'USDT',
        kind: 'flexible',
        name: 'C',
        aprBps: 100,
      });
      await fund(USER_A, 'USDT', '1000');
      const rule = await bank.autoInvest.createThresholdSweep({
        userId: USER_A,
        assetId: 'USDT',
        threshold: amt('100'),
        targetPoolId: pool.id,
      });
      await bank.autoInvest.cancelRule(rule.id);
      const report = await bank.autoInvest.runDue({ now: new Date(), limit: 200 });
      expect(report.considered).toBe(0);
      expect(await availableOf(USER_A, 'USDT')).toBe('1000');
    });

    it('ops.runAutoInvest refuses when the kill switch is off', async () => {
      const { createEdgeContext, encodePrincipal, signPrincipalHeader } = await import('@intafaced/contracts');
      const SECRET = 'a-bank-auto-invest-test-edge-secret-long';
      const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-bank' });
      const raw = encodePrincipal({
        sub: USER_A,
        userId: USER_A,
        sid: '22222222-2222-4222-8222-222222222222',
        scopes: ['admin:treasury'],
        tier: 'full',
        mfa: true,
        expiresAt: new Date(Date.now() + 60_000),
      } as never);
      const ctx = await edgeContext({
        headers: {
          'x-intafaced-principal': raw,
          'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
          'x-intafaced-region': 'DE',
        },
        id: 'req-ai-kill',
      });
      await expect(
        createBankRouter(bank, { autoInvestEnabled: false })
          .createCaller({ ...ctx, service: 'svc-bank' })
          .ops.runAutoInvest({}),
      ).rejects.toMatchObject({
        code: 'SERVICE_UNAVAILABLE',
        cause: { code: 'bank.auto_invest_disabled' },
      });
    });
  });

  describe('card round-up — spare change on capture (no yield invent)', () => {
    async function openFlexPool() {
      return bank.earn.createPool({
        assetId: 'USDT',
        kind: 'flexible',
        name: 'Roundup vault',
        aprBps: 100,
        minDeposit: amt('0.01'),
      });
    }

    it('sweeps 0.70 after a 4.30 capture into the same-asset earn pool', async () => {
      const pool = await openFlexPool();
      await fund(USER_A, 'USDT', '1000');
      const rule = await bank.autoInvest.createCardRoundUp({
        userId: USER_A,
        assetId: 'USDT',
        granularity: amt('1'),
        targetPoolId: pool.id,
      });
      expect(rule.kind).toBe('card_roundup');

      const card = await bank.cards.issue({
        cardId: randomUUID(),
        userId: USER_A,
        assetId: 'USDT',
        perAuthorizationLimit: amt('1000'),
      });
      await bank.cards.authorize({ cardId: card.id, authorizationRef: 'auth-ru-1', amount: amt('4.30') });
      const captured = await bank.cards.capture({
        cardId: card.id,
        authorizationRef: 'auth-ru-1',
        amount: amt('4.30'),
      });

      expect(captured.roundUp.status).toBe('settled');
      if (captured.roundUp.status === 'settled') {
        expect(formatAmount(captured.roundUp.amount)).toBe('0.7');
      }
      // 1000 - 4.30 spend - 0.70 sweep
      expect(await availableOf(USER_A, 'USDT')).toBe('995');
      expect(formatAmount(await bank.earn.stakedOf(USER_A, 'USDT'))).toBe('0.7');
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('skips when the capture is already a multiple of granularity — moves nothing extra', async () => {
      const pool = await openFlexPool();
      await fund(USER_A, 'USDT', '100');
      await bank.autoInvest.createCardRoundUp({
        userId: USER_A,
        assetId: 'USDT',
        granularity: amt('1'),
        targetPoolId: pool.id,
      });
      const card = await bank.cards.issue({
        cardId: randomUUID(),
        userId: USER_A,
        assetId: 'USDT',
        perAuthorizationLimit: amt('100'),
      });
      await bank.cards.authorize({ cardId: card.id, authorizationRef: 'auth-ru-2', amount: amt('5') });
      const captured = await bank.cards.capture({
        cardId: card.id,
        authorizationRef: 'auth-ru-2',
        amount: amt('5'),
      });
      expect(captured.roundUp.status).toBe('skipped');
      expect(await availableOf(USER_A, 'USDT')).toBe('95');
      expect(formatAmount(await bank.earn.stakedOf(USER_A, 'USDT'))).toBe('0');
    });

    it('refuses a cross-asset destination rather than inventing a convert rate', async () => {
      const pool = await openFlexPool();
      await expect(
        bank.autoInvest.createCardRoundUp({
          userId: USER_A,
          assetId: 'USDT',
          granularity: amt('1'),
          targetPoolId: pool.id,
          buyAssetId: 'BTC',
        }),
      ).rejects.toMatchObject({ code: 'bank.auto_invest_rate_unset' });
    });

    it('refuses a second live round-up on the same asset', async () => {
      const pool = await openFlexPool();
      await bank.autoInvest.createCardRoundUp({
        userId: USER_A,
        assetId: 'USDT',
        granularity: amt('1'),
        targetPoolId: pool.id,
      });
      await expect(
        bank.autoInvest.createCardRoundUp({
          userId: USER_A,
          assetId: 'USDT',
          granularity: amt('5'),
          targetPoolId: pool.id,
        }),
      ).rejects.toMatchObject({ code: 'bank.auto_invest_roundup_exists' });
    });

    it('AUTO_INVEST kill skips the hook — capture still stands, nothing swept', async () => {
      const pool = await openFlexPool();
      bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
        nativeAssetId: 'IFC',
        cards: { issuer: cardSim() },
        autoInvest: { enabled: false },
      });
      await fund(USER_A, 'USDT', '1000');
      // Create is allowed while the runner/hook is stopped (same as threshold).
      // Re-enable just long enough to insert, then rebuild disabled.
      const writer = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
        nativeAssetId: 'IFC',
        cards: { issuer: cardSim() },
      });
      await writer.autoInvest.createCardRoundUp({
        userId: USER_A,
        assetId: 'USDT',
        granularity: amt('1'),
        targetPoolId: pool.id,
      });

      const card = await bank.cards.issue({
        cardId: randomUUID(),
        userId: USER_A,
        assetId: 'USDT',
        perAuthorizationLimit: amt('1000'),
      });
      await bank.cards.authorize({ cardId: card.id, authorizationRef: 'auth-ru-kill', amount: amt('4.30') });
      const captured = await bank.cards.capture({
        cardId: card.id,
        authorizationRef: 'auth-ru-kill',
        amount: amt('4.30'),
      });
      expect(captured.roundUp.status).toBe('skipped');
      if (captured.roundUp.status === 'skipped') {
        expect(captured.roundUp.reason).toBe('bank.auto_invest_disabled');
      }
      expect(await availableOf(USER_A, 'USDT')).toBe('995.7');
      expect(formatAmount(await bank.earn.stakedOf(USER_A, 'USDT'))).toBe('0');
    });

    it('pause stops the hook; capture still stands', async () => {
      const pool = await openFlexPool();
      await fund(USER_A, 'USDT', '1000');
      const rule = await bank.autoInvest.createCardRoundUp({
        userId: USER_A,
        assetId: 'USDT',
        granularity: amt('1'),
        targetPoolId: pool.id,
      });
      await bank.autoInvest.pauseRule(rule.id);
      const card = await bank.cards.issue({
        cardId: randomUUID(),
        userId: USER_A,
        assetId: 'USDT',
        perAuthorizationLimit: amt('1000'),
      });
      await bank.cards.authorize({ cardId: card.id, authorizationRef: 'auth-ru-pause', amount: amt('4.30') });
      const captured = await bank.cards.capture({
        cardId: card.id,
        authorizationRef: 'auth-ru-pause',
        amount: amt('4.30'),
      });
      expect(captured.roundUp.status).toBe('none');
      expect(await availableOf(USER_A, 'USDT')).toBe('995.7');
    });

    it('runDue does not fire card_roundup rules', async () => {
      const pool = await openFlexPool();
      await fund(USER_A, 'USDT', '1000');
      await bank.autoInvest.createCardRoundUp({
        userId: USER_A,
        assetId: 'USDT',
        granularity: amt('1'),
        targetPoolId: pool.id,
      });
      const report = await bank.autoInvest.runDue({ now: new Date('2026-08-15T12:00:00Z'), limit: 200 });
      expect(report.considered).toBe(0);
      expect(await availableOf(USER_A, 'USDT')).toBe('1000');
    });

    it('refuses the sweep when available cannot fund it — capture still stands', async () => {
      const pool = await openFlexPool();
      await fund(USER_A, 'USDT', '4.30');
      await bank.autoInvest.createCardRoundUp({
        userId: USER_A,
        assetId: 'USDT',
        granularity: amt('1'),
        targetPoolId: pool.id,
      });
      const card = await bank.cards.issue({
        cardId: randomUUID(),
        userId: USER_A,
        assetId: 'USDT',
        perAuthorizationLimit: amt('10'),
      });
      await bank.cards.authorize({ cardId: card.id, authorizationRef: 'auth-ru-short', amount: amt('4.30') });
      const captured = await bank.cards.capture({
        cardId: card.id,
        authorizationRef: 'auth-ru-short',
        amount: amt('4.30'),
      });
      expect(captured.captured).toBe(amt('4.30'));
      expect(captured.roundUp.status).toBe('refused');
      if (captured.roundUp.status === 'refused') {
        expect(captured.roundUp.reason).toBe('ledger.insufficient_funds');
      }
      expect(await availableOf(USER_A, 'USDT')).toBe('0');
    });
  });

  describe('doctrine — rules hold no balance', () => {
    it('auto_invest tables have no balance-shaped columns outside the allowlist shape', async () => {
      const cols = await sql<Array<{ table_name: string; column_name: string }>>`
        SELECT table_name, column_name
          FROM information_schema.columns
         WHERE table_schema = 'bank'
           AND table_name LIKE 'auto_invest%'
           AND column_name ~* '(balance|total|running|cached|available|held|accrued|outstanding)'
      `;
      expect(cols).toEqual([]);
    });
  });
});
