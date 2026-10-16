import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, parseAmount, recipes, type LedgerClient } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { maskDestination } from '../control/mask-destination.js';
import { teamReadFromSql } from '../merchant-team-read.js';
import { MerchantPayoutDestinationStore } from '../merchant-payout-destination.js';
import { PayService } from '../payment-service.js';
import { truncatePayForTest } from '../payment-events-test-reset.js';
import { CardSandboxAdapter } from '../rails/card-sandbox.js';
import { RailRegistry } from '../rails/registry.js';
import { createPayRouter } from '../router.js';
import { UserMoneyService } from '../user-money-service.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
  .sort()
  .map((name) => readFileSync(join(drizzleDir, name), 'utf8'));

const authConfig = {
  secret: 'a-test-signing-secret-that-is-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};

const OWNER = '11111111-1111-4111-8111-111111111111';
const VIEWER = '22222222-2222-4222-8222-222222222222';
const DEVELOPER = '88888888-8888-4888-8888-888888888888';
const OTHER = '33333333-3333-4333-8333-333333333333';
const DEST = '0xDEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEF';
const RAIL_TEXT = 'rail-text-must-stay-off-the-wire';

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_portal_reads_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

async function ctx(userId: string): Promise<Context> {
  const { token } = await issueAccessToken({ userId, sessionId: randomUUID(), scopes: ['pay:read'], tier: 'full', mfa: true }, authConfig);
  return { principal: await verifyAccessToken(token, authConfig), service: null, region: 'DE', requestId: randomUUID() };
}

function payCode(err: unknown): { trpc: string | undefined; pay: string | undefined } {
  const error = err as { code?: string; message?: string };
  return { trpc: error.code, pay: /pay\.[a-z0-9_.]+/.exec(error.message ?? '')?.[0] };
}

async function refused(run: Promise<unknown>) {
  try {
    await run;
    throw new Error('expected a refusal');
  } catch (err) {
    if (err instanceof Error && err.message === 'expected a refusal') throw err;
    return payCode(err);
  }
}

describe('merchant portal reads', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let ledger!: LedgerClient;
  let pay!: PayService;
  let router!: ReturnType<typeof createPayRouter>;

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    sql = db.sql;
  }, 180_000);

  beforeEach(async () => {
    await truncatePayForTest(sql, 'pay', 'TRUNCATE pay.merchants RESTART IDENTITY CASCADE');
    ledger = new MemoryLedger();
    const rails = new RailRegistry([
      new CardSandboxAdapter({ secret: 'svc-pay-test-secret-at-least-32-characters', toleranceSeconds: 300 }),
    ]);
    pay = new PayService(sql, ledger, rails, {
      checkoutRiskBand: 'low',
      linkDefaultTtlDays: 30,
      linkMaxTtlDays: 365,
      checkoutSessionTtlSeconds: 900,
      maxOpenSessionsPerLink: 25,
    });
    router = createPayRouter(
      pay,
      rails,
      new UserMoneyService(sql, ledger, rails, { operatorCreditRails: [] }),
      null,
      undefined,
      undefined,
      teamReadFromSql(sql),
    );
  }, 30_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  async function merchant(userId: string) {
    return pay.createMerchant({ userId, pricing: { feeBps: 250 } });
  }

  async function member(merchantId: string, userId: string, role: string) {
    await sql`
      INSERT INTO pay.merchant_team_members (merchant_id, user_id, role, status, invited_by, activated_at)
      VALUES (${merchantId}, ${userId}, ${role}, 'active', ${OWNER}, now())`;
  }

  async function captured(merchantId: string, assetId = 'USDT') {
    const row = await pay.createPayment({
      merchantId,
      amount: parseAmount('10'),
      assetId,
      method: 'card',
      railAdapter: 'card-sandbox',
      instrument: { kind: 'card', token: 'tok_ok' },
    });
    await pay.authorize(row.id);
    return pay.capture(row.id);
  }

  async function settled(merchantId: string, window: string) {
    const payment = await captured(merchantId);
    const settlement = await pay.settleWindow({
      merchantId,
      window,
      assetId: 'USDT',
      from: new Date('2020-01-01T00:00:00.000Z'),
      to: new Date('2030-01-01T00:00:00.000Z'),
    });
    return { payment, settlement };
  }

  it('lists a settled refund against merchant proceeds and ties the statement to the same accounts', async () => {
    const mine = await merchant(OWNER);
    await member(mine.id, VIEWER, 'viewer');
    await member(mine.id, DEVELOPER, 'developer');
    const { payment, settlement } = await settled(mine.id, '2026-10-16');
    await pay.refund(payment.id, parseAmount('1'), { refundId: 'rf-proceeds' });

    const owner = router.createCaller(await ctx(OWNER));
    const refunds = await owner.payment.refunds.list({ merchantId: mine.id, limit: 20, paymentId: payment.id });
    expect(refunds.nextCursor).toBeNull();
    expect(refunds.items).toHaveLength(1);
    expect(refunds.items[0]).toMatchObject({
      refundId: 'rf-proceeds',
      paymentId: payment.id,
      merchantId: mine.id,
      amount: '1',
      assetId: 'USDT',
      reason: null,
      actor: null,
      status: 'settled',
      source: 'settled',
      ledgerEffect: { recorded: true, pot: 'merchantProceeds', direction: 'credit' },
    });
    expect(await owner.payment.refunds.get({ refundEventId: refunds.items[0]!.id })).toEqual(refunds.items[0]);

    const byStatus = await owner.payment.refunds.list({ merchantId: mine.id, limit: 20, status: 'posted' });
    expect(byStatus.items).toHaveLength(0);
    const byAsset = await owner.payment.refunds.list({ merchantId: mine.id, limit: 20, assetId: 'BTC' });
    expect(byAsset.items).toHaveLength(0);
    const bySearch = await owner.payment.refunds.list({ merchantId: mine.id, limit: 20, search: 'rf-proceeds' });
    expect(bySearch.items.map((item) => item.refundId)).toEqual(['rf-proceeds']);
    const byDate = await owner.payment.refunds.list({
      merchantId: mine.id,
      limit: 20,
      from: '2030-01-01T00:00:00.000Z',
    });
    expect(byDate.items).toHaveLength(0);
    expect(await refused(owner.payment.refunds.list({ merchantId: mine.id, limit: 20, cursor: 'nope' }))).toMatchObject({
      trpc: 'BAD_REQUEST',
      pay: 'pay.list_cursor_invalid',
    });
    expect(await refused(owner.payment.refunds.list({ merchantId: mine.id }))).toMatchObject({
      trpc: 'PRECONDITION_FAILED',
      pay: 'pay.refund_list_limit_unset',
    });

    const statement = await owner.merchant.statement.list({ merchantId: mine.id, limit: 50 });
    expect(statement.tieOut).toEqual({
      reserve: 'not_booked',
      accounts: [
        {
          assetId: 'USDT',
          clearing: { statement: '0', ledger: '0', matches: true },
          proceeds: { statement: '8.75', ledger: '8.75', matches: true },
        },
      ],
    });
    expect(statement.items.some((line) => line.kind === 'payment_captured')).toBe(true);
    expect(statement.items.some((line) => line.kind === 'fee' && line.amount === '0.25')).toBe(true);
    expect(statement.items.some((line) => line.kind === 'settlement' && line.account === 'proceeds')).toBe(true);
    expect(statement.items.some((line) => line.kind === 'refund' && line.account === 'proceeds')).toBe(true);
    expect(statement.items.some((line) => line.kind === 'reserve')).toBe(false);
    const body = JSON.stringify(statement);
    expect(body).not.toContain('feeBps');
    expect(body).not.toContain('spreadBps');
    expect(body).not.toContain('ruleId');

    const developer = router.createCaller(await ctx(DEVELOPER));
    expect(JSON.stringify(await developer.merchant.statement.list({ merchantId: mine.id, limit: 20 }))).not.toContain('feeBps');
    const viewer = router.createCaller(await ctx(VIEWER));
    expect((await viewer.payment.refunds.list({ merchantId: mine.id, limit: 20 })).items).toHaveLength(1);
    expect(
      (await viewer.settlement.lifecycle({ settlementId: settlement.id })).events.some((event) => event.kind === 'settlement.posted'),
    ).toBe(true);
  });

  it('classifies a legacy settled refund as userAvailable when that is the pot the ledger credited', async () => {
    const mine = await merchant(OWNER);
    const { payment } = await settled(mine.id, '2026-10-16');
    await ledger.post(
      recipes.deposit({
        userId: OWNER,
        assetId: 'USDT',
        amount: parseAmount('1'),
        rail: 'card-sandbox',
        railRef: 'fund-legacy-refund',
      }),
    );
    const tx = await ledger.post(
      recipes.paymentRefund({
        refundId: 'rf-legacy',
        paymentId: payment.id,
        merchantId: mine.id,
        merchantUserId: OWNER,
        assetId: 'USDT',
        amount: parseAmount('1'),
        rail: 'card-sandbox',
        source: 'settled',
        settledPot: 'user',
      }),
    );
    await sql`
      INSERT INTO pay.payment_events (payment_id, event, payload)
      VALUES (
        ${payment.id},
        'refund.posted',
        ${sql.json({ refundId: 'rf-legacy', amount: '1', source: 'settled', ledgerTxId: tx.id })}
      )`;
    const owner = router.createCaller(await ctx(OWNER));
    const page = await owner.payment.refunds.list({ merchantId: mine.id, limit: 20, search: 'rf-legacy' });
    expect(page.items[0]?.ledgerEffect).toMatchObject({ recorded: true, pot: 'userAvailable', direction: 'credit', ledgerTxId: tx.id });
  });

  it('keeps a paid-out timeline complete when an earlier approval was rejected, and does not copy the status column', async () => {
    const mine = await merchant(OWNER);
    const { settlement } = await settled(mine.id, '2026-10-16');
    await sql`
      INSERT INTO pay.control_payout_approvals (
        merchant_id, settlement_id, asset_code, amount, rail_id, destination_kind, destination_ref,
        payload_hash, status, founder_required, maker_user_id, checker_user_id, decided_at, created_at, expires_at
      ) VALUES (
        ${mine.id}, ${settlement.id}, 'USDT', 1, 'crypto-native', 'crypto', ${DEST},
        ${'sha256:' + 'ab'.repeat(32)}, 'rejected', false, ${OWNER}, ${VIEWER},
        '2026-01-02T00:00:00Z', '2026-01-01T00:00:00Z', '2026-12-01T00:00:00Z'
      )`;
    const admissionId = randomUUID();
    await sql`
      INSERT INTO pay.payout_admissions (
        id, settlement_id, merchant_id, merchant_user_id, attempt, business_id, net, asset_id,
        rail_id, destination_kind, destination_ref, "window", merchant_control_version, admitted_at
      ) VALUES (
        ${admissionId}, ${settlement.id}, ${mine.id}, ${OWNER}, 0, ${'biz-' + admissionId}, 8.75, 'USDT',
        'crypto-native', 'crypto', ${DEST}, '2026-10-16', 0, '2026-02-01T00:00:00Z'
      )`;
    await sql`
      INSERT INTO pay.payout_outcomes (admission_id, kind, payload, occurred_at) VALUES
        (${admissionId}, 'rail_accepted', ${sql.json({ railRef: DEST, failureReason: RAIL_TEXT })}, '2026-03-01T00:00:00Z'),
        (${admissionId}, 'settled', '{}', '2026-04-01T00:00:00Z')`;
    await sql`
      UPDATE pay.settlements
         SET status = 'paid_out', sent_at = '2026-03-01T00:00:00Z', payout_method = 'crypto-native', payout_ref = ${DEST}
       WHERE id = ${settlement.id}`;

    const owner = router.createCaller(await ctx(OWNER));
    const life = await owner.settlement.lifecycle({ settlementId: settlement.id });
    expect(life.status).toBe('paid_out');
    expect(life.screening).toBe('not_recorded');
    expect(life.fee).toBe('0.25');
    expect(life.failure).toBeNull();
    expect(life.destination).toEqual({
      railId: 'crypto-native',
      kind: 'crypto',
      destinationMasked: maskDestination('crypto', DEST),
    });
    const kinds = life.events.map((event) => event.kind);
    expect(kinds).toContain('approval.rejected');
    expect(kinds).toContain('rail.sent');
    expect(kinds).toContain('rail.confirmed');
    expect(kinds.indexOf('approval.rejected')).toBeLessThan(kinds.indexOf('rail.confirmed'));
    const wire = JSON.stringify(life);
    expect(wire).not.toContain(DEST);
    expect(wire).not.toContain(RAIL_TEXT);
    expect(wire).not.toContain('checker_reason');

    await new MerchantPayoutDestinationStore(sql).persist({
      merchantId: mine.id,
      railId: 'crypto-native',
      kind: 'crypto',
      ref: DEST,
    });
    const used = await owner.merchant.payoutDestinations.list({ merchantId: mine.id, limit: 10 });
    expect(used.items[0]?.lastUsedAt).toEqual(expect.any(String));
    expect(JSON.stringify(used)).not.toContain(DEST);

    const { settlement: lied } = await settled(mine.id, '2026-10-17');
    await sql`
      UPDATE pay.settlements
         SET status = 'paid_out', payout_method = 'crypto-native', payout_ref = ${DEST}
       WHERE id = ${lied.id}`;
    const column = await owner.settlement.lifecycle({ settlementId: lied.id });
    expect(column.status).not.toBe('paid_out');
    expect(column.status).toBe('posted');
    expect(column.events.some((event) => event.kind === 'rail.confirmed')).toBe(false);
  });

  it('masks the destination inventory and refuses a foreign merchant the same way as a missing one', async () => {
    const mine = await merchant(OWNER);
    const other = await merchant(OTHER);
    await member(mine.id, VIEWER, 'viewer');
    await member(mine.id, DEVELOPER, 'developer');
    const store = new MerchantPayoutDestinationStore(sql);
    await store.persist({ merchantId: mine.id, railId: 'crypto-native', kind: 'crypto', ref: DEST });
    await store.persist({ merchantId: mine.id, railId: 'card-sandbox', kind: 'bank', ref: 'GB82WEST12345698765432' });
    await store.persist({ merchantId: other.id, railId: 'crypto-native', kind: 'crypto', ref: DEST });
    await sql`
      UPDATE pay.merchant_payout_destinations
         SET created_at = '2020-01-01T00:00:00Z'
       WHERE merchant_id = ${mine.id} AND rail_id = 'card-sandbox'`;

    const owner = router.createCaller(await ctx(OWNER));
    expect('setDefault' in owner.merchant.payoutDestinations).toBe(false);
    expect('remove' in owner.merchant.payoutDestinations).toBe(false);
    const first = await owner.merchant.payoutDestinations.list({ merchantId: mine.id, limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await owner.merchant.payoutDestinations.list({ merchantId: mine.id, limit: 1, cursor: first.nextCursor! });
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map((item) => item.railId))).toEqual(new Set(['crypto-native', 'card-sandbox']));
    expect(JSON.stringify(first) + JSON.stringify(second)).not.toContain(DEST);
    expect(first.items.concat(second.items).every((item) => item.screeningState === 'not_recorded' && item.defaultFlag === 'unset')).toBe(
      true,
    );

    const viewer = router.createCaller(await ctx(VIEWER));
    const developer = router.createCaller(await ctx(DEVELOPER));
    expect((await viewer.merchant.payoutDestinations.list({ merchantId: mine.id, limit: 10 })).items).toHaveLength(2);
    expect((await developer.merchant.payoutDestinations.list({ merchantId: mine.id, limit: 10 })).items).toHaveLength(2);
    expect(await refused(owner.merchant.payoutDestinations.list({ merchantId: mine.id }))).toMatchObject({
      pay: 'pay.destination_list_limit_unset',
    });

    const ghost = randomUUID();
    const foreign = await refused(owner.merchant.payoutDestinations.list({ merchantId: other.id, limit: 10 }));
    const missing = await refused(owner.merchant.payoutDestinations.list({ merchantId: ghost, limit: 10 }));
    expect(foreign).toEqual(missing);
    expect(foreign.pay).toBe('pay.merchant_not_found');

    const { payment, settlement } = await settled(other.id, '2026-10-16');
    await pay.refund(payment.id, parseAmount('1'), { refundId: 'rf-other' });
    const otherRefunds = await router.createCaller(await ctx(OTHER)).payment.refunds.list({ merchantId: other.id, limit: 10 });
    const foreignRefund = await refused(owner.payment.refunds.get({ refundEventId: otherRefunds.items[0]!.id }));
    const missingRefund = await refused(owner.payment.refunds.get({ refundEventId: ghost }));
    expect(foreignRefund).toEqual(missingRefund);
    expect(foreignRefund.pay).toBe('pay.refund_not_found');

    const foreignLife = await refused(owner.settlement.lifecycle({ settlementId: settlement.id }));
    const missingLife = await refused(owner.settlement.lifecycle({ settlementId: ghost }));
    expect(foreignLife).toEqual(missingLife);
    expect(foreignLife.pay).toBe('pay.settlement_not_found');

    const foreignStatement = await refused(owner.merchant.statement.list({ merchantId: other.id, limit: 10 }));
    const missingStatement = await refused(owner.merchant.statement.list({ merchantId: ghost, limit: 10 }));
    expect(foreignStatement).toEqual(missingStatement);
    expect(foreignStatement.pay).toBe('pay.merchant_not_found');
    expect(await refused(owner.merchant.statement.list({ merchantId: mine.id }))).toMatchObject({
      pay: 'pay.statement_list_limit_unset',
    });
  });
});
