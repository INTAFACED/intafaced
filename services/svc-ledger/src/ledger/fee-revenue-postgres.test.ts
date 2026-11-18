import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createTestDb, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import {
  formatAmount,
  houseFees,
  insuranceFund,
  parseAmount as amt,
  railBoundary,
  recipes,
  userAvailable,
  venueBuilderAccount,
  venueBuilderFeeReceivable,
} from '@intafaced/ledger-client';
import { BUILDER_FEE_COLLECT_REASON, VENUE_BUILDER_ACCOUNT_PREFIX, VENUE_BUILDER_FEE_PREFIX } from './fee-revenue.js';
import { PostgresLedger } from './postgres-ledger.js';
import { disableBalanceTrigger } from '../db/journal-guards.testkit.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');

const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'))
  .map((body) => (schema: string) => rewriteSchemaSql(body, 'ledger', schema));

const PAYER = '11111111-1111-4111-8111-111111111111';

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
      `H8a: ledger history is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

describe('PostgresLedger.feeRevenue', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDb | undefined;
  let engine: PostgresLedger;
  let firstFee: Date;
  let lastFee: Date;

  const fee = (key: string, module: string, asset: string, value: string) => ({
    idempotencyKey: key,
    module,
    reason: 'trade.fill.fee',
    entries: [
      { account: userAvailable(PAYER, asset), direction: 'credit' as const, amount: amt(value) },
      { account: houseFees(module, asset), direction: 'debit' as const, amount: amt(value) },
    ],
  });

  const giveBack = (key: string, module: string, asset: string, value: string) => ({
    idempotencyKey: key,
    module,
    reason: 'trade.fill.fee.correction',
    entries: [
      { account: houseFees(module, asset), direction: 'credit' as const, amount: amt(value) },
      { account: userAvailable(PAYER, asset), direction: 'debit' as const, amount: amt(value) },
    ],
  });

  const fund = (asset: string) => ({
    idempotencyKey: `fee-fund-${asset}`,
    module: 'bank',
    reason: 'bank.transfer.in',
    entries: [
      { account: userAvailable(PAYER, asset), direction: 'debit' as const, amount: amt('1000') },
      { account: railBoundary('crypto-native', asset), direction: 'credit' as const, amount: amt('1000') },
    ],
  });

  beforeAll(async () => {
    const admin = await openH8aAdmin();
    adminStop = admin.stop;
    db = await createTestDb({ service: 'ledger_fee_revenue', url: admin.url, migrations });
    await disableBalanceTrigger(db.sql);
    engine = new PostgresLedger(db.sql);

    await engine.post(fund('USDT'));
    await engine.post(fund('BTC'));
    firstFee = (await engine.post(fee('fee-rev-1', 'trade', 'USDT', '10.123456789012345678'))).postedAt;
    await engine.post(fee('fee-rev-2', 'pay', 'USDT', '2'));
    await engine.post(fee('fee-rev-3', 'trade', 'BTC', '0.001'));
    await engine.post(giveBack('fee-back-rev-1', 'trade', 'USDT', '0.5'));
    // Money that is not a fee: the insurance fund is a house account but not `fees:*`.
    await engine.post({
      idempotencyKey: 'insurance-rev-1',
      module: 'futures',
      reason: 'futures.insurance.fund',
      entries: [
        { account: userAvailable(PAYER, 'USDT'), direction: 'credit' as const, amount: amt('77') },
        { account: insuranceFund('USDT'), direction: 'debit' as const, amount: amt('77') },
      ],
    });
    // Our builder fee on two venue fills (earned, owed by the venue), and one claim the venue paid us (Collect).
    await engine.post(
      recipes.builderFeeEarn({
        venueId: 'test-venue',
        venueAccount: 'acct-1',
        fillId: 'f1',
        assetId: 'USDC',
        amount: amt('3'),
        userId: PAYER,
      }),
    );
    await engine.post(
      recipes.builderFeeEarn({
        venueId: 'test-venue',
        venueAccount: 'acct-1',
        fillId: 'f2',
        assetId: 'USDC',
        amount: amt('2'),
        userId: PAYER,
      }),
    );
    await engine.post(
      recipes.builderFeeEarn({
        venueId: 'other-venue',
        venueAccount: 'acct-9',
        fillId: 'f1',
        assetId: 'USDC',
        amount: amt('7'),
        userId: PAYER,
      }),
    );
    await engine.post(recipes.builderFeeReceive({ venueId: 'test-venue', claimId: 'claim-1', assetId: 'USDC', amount: amt('1.5') }));
    lastFee = (await engine.post(fee('fee-rev-4', 'pay', 'USDT', '1'))).postedAt;
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  const wide = () => ({ from: new Date(firstFee.getTime() - 60_000), to: new Date(lastFee.getTime() + 60_000) });

  it('sums earned and returned per venue and asset across every fees:* account, 18dp intact, and collected apart', async () => {
    const rows = await engine.feeRevenue(wide());
    expect(
      rows.map((r) => [
        r.venueId,
        r.assetId,
        formatAmount(r.earned),
        formatAmount(r.returned),
        r.collected === null ? null : formatAmount(r.collected),
      ]),
    ).toEqual([
      [null, 'BTC', '0.001', '0', null],
      ['other-venue', 'USDC', '7', '0', '0'],
      ['test-venue', 'USDC', '5', '0', '1.5'],
      [null, 'USDT', '13.123456789012345678', '0.5', null],
    ]);
  });

  it('counts as collected only what Collect posted: earned 5 at test-venue, of which the venue paid 1.5', async () => {
    const rows = await engine.feeRevenue(wide());
    const venue = rows.find((r) => r.venueId === 'test-venue')!;
    // Before this read split them, the one figure labelled "collected" was the earned 5.
    expect(formatAmount(venue.earned)).toBe('5');
    expect(formatAmount(venue.collected!)).toBe('1.5');
    // A venue that paid nothing yet reads 0, not the earned figure; a fee of our own has no collected figure at all.
    expect(formatAmount(rows.find((r) => r.venueId === 'other-venue')!.collected!)).toBe('0');
    expect(rows.filter((r) => r.venueId === null).every((r) => r.collected === null)).toBe(true);
  });

  it('reads the Collect and earn entries by the names the recipes post under', () => {
    const collect = recipes.builderFeeReceive({ venueId: 'v', claimId: 'c', assetId: 'USDC', amount: amt('1') });
    expect(collect.reason).toBe(BUILDER_FEE_COLLECT_REASON);
    expect(collect.entries.find((e) => e.direction === 'credit')!.account.ownerId).toBe(venueBuilderAccount('v', 'USDC').ownerId);
    expect(venueBuilderAccount('v', 'USDC').ownerId).toBe(`${VENUE_BUILDER_ACCOUNT_PREFIX}v`);
    expect(venueBuilderFeeReceivable('v', 'USDC').ownerId).toBe(`${VENUE_BUILDER_FEE_PREFIX}v`);
  });

  it('leaves out the insurance fund and every user account', async () => {
    const rows = await engine.feeRevenue(wide());
    const usdt = rows.find((r) => r.assetId === 'USDT')!;
    expect(formatAmount(usdt.earned)).not.toContain('77');
    expect(formatAmount(usdt.earned + usdt.returned)).toBe('13.623456789012345678');
  });

  it('uses a half-open window: from is inclusive and to is exclusive', async () => {
    const atFirst = await engine.feeRevenue({ from: firstFee, to: new Date(firstFee.getTime() + 1) });
    expect(atFirst.map((r) => [r.assetId, formatAmount(r.earned)])).toEqual([['USDT', '10.123456789012345678']]);
    const upToFirst = await engine.feeRevenue({ from: new Date(firstFee.getTime() - 60_000), to: firstFee });
    expect(upToFirst).toEqual([]);
  });

  it('omits an asset with no fee movement instead of returning a zero row', async () => {
    const rows = await engine.feeRevenue({ from: new Date(lastFee.getTime() + 60_000), to: new Date(lastFee.getTime() + 120_000) });
    expect(rows).toEqual([]);
  });
});
