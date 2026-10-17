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
import { PayError, PayService, type PayErrorCode } from '../payment-service.js';
import type { PayFail } from './common.js';
import { listMerchantStatement } from './statement.js';
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

function coveringRange(): { from: string; to: string } {
  return {
    from: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    to: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  };
}

const statementFail: PayFail = (message, code) => {
  throw new PayError(message, code);
};

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

    const statement = await owner.merchant.statement.list({ merchantId: mine.id, limit: 50, ...coveringRange() });
    expect(statement.runningBalances).toBe('within_range');
    expect(statement.opening).toBeNull();
    expect(statement.tieOut).toEqual({
      reserve: 'not_booked',
      accounts: [
        {
          assetId: 'USDT',
          clearing: { statement: null, ledger: '0', matches: null },
          proceeds: { statement: null, ledger: '8.75', matches: null },
        },
      ],
    });
    expect(statement.items.every((line) => line.runningOrder === 'clear' && line.runningReason === 'no_opening')).toBe(true);
    expect(statement.items.every((line) => line.runningClearing === null && line.runningProceeds === null)).toBe(true);
    expect(statement.items.find((line) => line.kind === 'payment_captured')).toMatchObject({ windowNet: '10' });
    expect(statement.items.find((line) => line.kind === 'settlement' && line.account === 'clearing')).toMatchObject({ windowNet: '0' });
    expect(statement.items.find((line) => line.kind === 'settlement' && line.account === 'proceeds')).toMatchObject({ windowNet: '9.75' });
    expect(statement.items.find((line) => line.kind === 'fee')).toMatchObject({ windowNet: '0.25' });
    expect(statement.items.find((line) => line.kind === 'refund' && line.account === 'proceeds')).toMatchObject({ windowNet: '8.75' });
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
    expect(JSON.stringify(await developer.merchant.statement.list({ merchantId: mine.id, limit: 20, ...coveringRange() }))).not.toContain(
      'feeBps',
    );
    const viewer = router.createCaller(await ctx(VIEWER));
    expect((await viewer.payment.refunds.list({ merchantId: mine.id, limit: 20 })).items).toHaveLength(1);
    const postedLife = await viewer.settlement.lifecycle({ settlementId: settlement.id });
    expect(postedLife.events.some((event) => event.kind === 'settlement.posted' && event.timeKnown)).toBe(true);
    expect(postedLife.events.some((event) => event.timeKnown === false)).toBe(false);
    expect(postedLife.status).toBe('posted');
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

  it('keeps a paid-out timeline when an earlier approval was rejected, and floors a column that has no confirming time', async () => {
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
    expect(life.events.find((event) => event.kind === 'rail.confirmed')).toMatchObject({ timeKnown: true });
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
    expect((await owner.settlement.get({ settlementId: lied.id })).status).toBe('paid_out');
    expect(column.status).toBe('paid_out');
    expect(column.events.find((event) => event.kind === 'rail.confirmed')).toMatchObject({ at: null, timeKnown: false });
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

  it('floors lifecycle status to the column when migration 0073 timestamps were not backfilled', async () => {
    const mine = await merchant(OWNER);
    const owner = router.createCaller(await ctx(OWNER));
    const cases = [
      { status: 'posted', kind: 'settlement.posted' },
      { status: 'paid_out', kind: 'rail.confirmed' },
      { status: 'failed', kind: 'rail.refused' },
    ] as const;
    for (const item of cases) {
      const { settlement } = await settled(mine.id, `pre-0073-${item.status}`);
      if (item.status === 'paid_out') {
        await sql`
          UPDATE pay.settlements
             SET status = 'paid_out', payout_method = 'crypto-native', payout_ref = 'pre0073-ref',
                 settled_at = NULL, sent_at = NULL, failed_at = NULL
           WHERE id = ${settlement.id}`;
      } else if (item.status === 'failed') {
        await sql`
          UPDATE pay.settlements
             SET status = 'failed', settled_at = NULL, sent_at = NULL, failed_at = NULL
           WHERE id = ${settlement.id}`;
      } else {
        await sql`
          UPDATE pay.settlements
             SET status = 'posted', settled_at = NULL, sent_at = NULL, failed_at = NULL
           WHERE id = ${settlement.id}`;
      }
      const life = await owner.settlement.lifecycle({ settlementId: settlement.id });
      expect(life.status).toBe(item.status);
      expect((await owner.settlement.get({ settlementId: settlement.id })).status).toBe(item.status);
      expect(life.events.find((event) => event.kind === item.kind && event.timeKnown === false)).toMatchObject({
        at: null,
        timeKnown: false,
      });
      expect(JSON.stringify(life)).not.toContain('pre0073-ref');
    }
  });

  it('reports a malformed refund on another merchant as not found, and parses the amount only after the fence', async () => {
    const mine = await merchant(OWNER);
    const other = await merchant(OTHER);
    const foreignPayment = await captured(other.id);
    const foreign = await sql<Array<{ id: string }>>`
      INSERT INTO pay.payment_events (payment_id, event, payload)
      VALUES (${foreignPayment.id}, 'refund.posted', ${sql.json({ refundId: 'rf-foreign-bad', amount: 'nope' })})
      RETURNING id`;
    const owner = router.createCaller(await ctx(OWNER));
    expect(await refused(owner.payment.refunds.get({ refundEventId: foreign[0]!.id }))).toMatchObject({
      pay: 'pay.refund_not_found',
    });

    const ownPayment = await captured(mine.id);
    const own = await sql<Array<{ id: string }>>`
      INSERT INTO pay.payment_events (payment_id, event, payload)
      VALUES (${ownPayment.id}, 'refund.posted', ${sql.json({ refundId: 'rf-own-bad', amount: 'nope' })})
      RETURNING id`;
    expect(await refused(owner.payment.refunds.get({ refundEventId: own[0]!.id }))).toMatchObject({
      pay: 'pay.invalid_amount',
    });
  });

  it('requires a statement window, refuses a span past 92 days, and caps in-range ledger keys at 2000', async () => {
    const mine = await merchant(OWNER);
    const owner = router.createCaller(await ctx(OWNER));
    const day = 24 * 60 * 60 * 1000;
    const from = new Date('2026-01-01T00:00:00.000Z');
    const edge = new Date(from.getTime() + 92 * day).toISOString();
    expect(await refused(owner.merchant.statement.list({ merchantId: mine.id, limit: 20, to: edge }))).toMatchObject({
      pay: 'pay.statement_range_required',
    });
    expect(await refused(owner.merchant.statement.list({ merchantId: mine.id, limit: 20, from: from.toISOString() }))).toMatchObject({
      pay: 'pay.statement_range_required',
    });
    expect(
      await refused(
        owner.merchant.statement.list({
          merchantId: mine.id,
          limit: 20,
          from: from.toISOString(),
          to: new Date(from.getTime() + 92 * day + 1).toISOString(),
        }),
      ),
    ).toMatchObject({ pay: 'pay.statement_range_too_wide' });
    const empty = await owner.merchant.statement.list({
      merchantId: mine.id,
      limit: 20,
      from: from.toISOString(),
      to: edge,
    });
    expect(empty.items).toEqual([]);
    expect(empty.opening).toBeNull();
    expect(empty.runningBalances).toBe('within_range');

    await sql`
      INSERT INTO pay.payments (merchant_id, amount, currency, method, rail_adapter, status)
      SELECT ${mine.id}, 1, 'USDT', 'card', 'card-sandbox', 'created'
      FROM generate_series(1, 2001)`;
    await sql`
      INSERT INTO pay.payment_events (payment_id, event, ts)
      SELECT id, 'captured',
             CASE WHEN n = 2001 THEN TIMESTAMPTZ '2020-07-01T00:00:00Z' ELSE TIMESTAMPTZ '2020-06-01T00:00:00Z' END
        FROM (
          SELECT id, row_number() OVER (ORDER BY id) AS n
            FROM pay.payments
           WHERE merchant_id = ${mine.id}
        ) numbered`;
    const bounded = await owner.merchant.statement.list({
      merchantId: mine.id,
      limit: 20,
      from: '2020-06-01T00:00:00.000Z',
      to: '2020-06-15T00:00:00.000Z',
    });
    expect(bounded.items).toEqual([]);
    expect(bounded.runningBalances).toBe('within_range');
    const outside = await owner.merchant.statement.list({
      merchantId: mine.id,
      limit: 20,
      from: '2024-01-01T00:00:00.000Z',
      to: '2024-01-15T00:00:00.000Z',
    });
    expect(outside.items).toEqual([]);
    expect(
      await refused(
        owner.merchant.statement.list({
          merchantId: mine.id,
          limit: 20,
          from: '2020-06-01T00:00:00.000Z',
          to: '2020-07-02T00:00:00.000Z',
        }),
      ),
    ).toMatchObject({ pay: 'pay.statement_too_large' });
  });

  it('reports window nets when the window starts on a payout or on a settlement whose captures are earlier', async () => {
    const mine = await merchant(OWNER);
    const owner = router.createCaller(await ctx(OWNER));
    const payment = await captured(mine.id);
    await pause(30);
    const settlement = await pay.settleWindow({
      merchantId: mine.id,
      window: '2026-08-01',
      assetId: 'USDT',
      from: new Date('2020-01-01T00:00:00.000Z'),
      to: new Date('2030-01-01T00:00:00.000Z'),
    });
    await pause(30);
    await pay.payoutSettlement({
      settlementId: settlement.id,
      railId: 'card-sandbox',
      destination: { kind: 'bank', ref: 'DE89370400440532013000' },
    });

    const captureTx = await ledger.getTxByKey(`payment.capture:${payment.id}`);
    const settlementPosting = await ledger.getTxByKey(`settlement:${mine.id}:2026-08-01:USDT`);
    const holdTx = await ledger.getTxByKey(`pay.proceeds.payout.hold:${settlement.id}:0`);
    expect(captureTx).not.toBeNull();
    expect(settlementPosting).not.toBeNull();
    expect(holdTx).not.toBeNull();
    expect(captureTx!.postedAt.getTime()).toBeLessThan(settlementPosting!.postedAt.getTime());
    expect(settlementPosting!.postedAt.getTime()).toBeLessThan(holdTx!.postedAt.getTime());

    const settledOnly = await owner.merchant.statement.list({
      merchantId: mine.id,
      limit: 20,
      from: new Date(captureTx!.postedAt.getTime() + 1).toISOString(),
      to: holdTx!.postedAt.toISOString(),
    });
    expect(settledOnly.runningBalances).toBe('within_range');
    expect(settledOnly.opening).toBeNull();
    expect(settledOnly.items.some((line) => line.kind === 'payment_captured' || line.kind === 'payout')).toBe(false);
    expect(settledOnly.items.some((line) => line.runningOrder === 'order_ambiguous')).toBe(false);
    expect(settledOnly.items.find((line) => line.account === 'clearing')).toMatchObject({
      kind: 'settlement',
      direction: 'credit',
      amount: '10',
      windowNet: '-10',
      runningReason: 'no_opening',
      runningClearing: null,
      runningProceeds: null,
    });
    expect(settledOnly.items.find((line) => line.account === 'proceeds')).toMatchObject({
      kind: 'settlement',
      direction: 'debit',
      amount: '9.75',
      windowNet: '9.75',
      runningReason: 'no_opening',
    });
    expect(settledOnly.items.find((line) => line.kind === 'fee')).toMatchObject({ windowNet: '0.25', runningReason: 'no_opening' });

    const payoutOnly = await owner.merchant.statement.list({
      merchantId: mine.id,
      limit: 20,
      from: new Date(settlementPosting!.postedAt.getTime() + 1).toISOString(),
      to: new Date(holdTx!.postedAt.getTime() + 60_000).toISOString(),
    });
    expect(payoutOnly.runningBalances).toBe('within_range');
    expect(payoutOnly.items.some((line) => line.kind === 'payment_captured' || line.kind === 'settlement')).toBe(false);
    expect(payoutOnly.items.some((line) => line.runningOrder === 'order_ambiguous')).toBe(false);
    expect(payoutOnly.items.find((line) => line.account === 'proceeds')).toMatchObject({
      kind: 'payout',
      direction: 'credit',
      amount: '9.75',
      windowNet: '-9.75',
      runningReason: 'no_opening',
      runningClearing: null,
      runningProceeds: null,
    });
  });

  it('refuses a second statement list while this merchant holds a live lease', async () => {
    const mine = await merchant(OWNER);
    const other = await merchant(OTHER);
    const owner = router.createCaller(await ctx(OWNER));
    const otherCaller = router.createCaller(await ctx(OTHER));
    const held = randomUUID();
    await sql`
      INSERT INTO pay.merchant_statement_leases (merchant_id, lease_id, expires_at)
      VALUES (${mine.id}, ${held}, now() + interval '60 seconds')
    `;
    try {
      expect(await refused(owner.merchant.statement.list({ merchantId: mine.id, limit: 20, ...coveringRange() }))).toMatchObject({
        trpc: 'TOO_MANY_REQUESTS',
        pay: 'pay.statement_busy',
      });
      const free = await otherCaller.merchant.statement.list({ merchantId: other.id, limit: 20, ...coveringRange() });
      expect(free.runningBalances).toBe('within_range');
      expect(free.items).toEqual([]);
      const [row] = await sql<Array<{ lease_id: string }>>`
        SELECT lease_id::text AS lease_id
          FROM pay.merchant_statement_leases
         WHERE merchant_id = ${mine.id}
      `;
      expect(row?.lease_id).toBe(held);
    } finally {
      await sql`DELETE FROM pay.merchant_statement_leases WHERE merchant_id = ${mine.id}`;
    }
    const again = await owner.merchant.statement.list({ merchantId: mine.id, limit: 20, ...coveringRange() });
    expect(again.items).toEqual([]);
    expect(again.runningBalances).toBe('within_range');
  });

  it('takes over an expired statement lease and releases it when the scan finishes', async () => {
    const mine = await merchant(OWNER);
    await captured(mine.id);
    const stale = randomUUID();
    await sql`
      INSERT INTO pay.merchant_statement_leases (merchant_id, lease_id, expires_at)
      VALUES (${mine.id}, ${stale}, now() - interval '1 second')
    `;
    let seen: string | null = null;
    const page = await listMerchantStatement(
      sql,
      {
        balance: ledger.balance.bind(ledger),
        getTxByKey: async (key) => {
          const [row] = await sql<Array<{ lease_id: string }>>`
            SELECT lease_id::text AS lease_id
              FROM pay.merchant_statement_leases
             WHERE merchant_id = ${mine.id}
          `;
          seen = row?.lease_id ?? null;
          return ledger.getTxByKey(key);
        },
      },
      { merchantId: mine.id, limit: 20, ...coveringRange() },
      statementFail,
    );
    expect(page.runningBalances).toBe('within_range');
    expect(seen).toBeTruthy();
    expect(seen).not.toBe(stale);
    expect(await sql`SELECT 1 FROM pay.merchant_statement_leases WHERE merchant_id = ${mine.id}`).toHaveLength(0);
  });

  it('releases the statement lease when the scan throws', async () => {
    const mine = await merchant(OWNER);
    await captured(mine.id);
    let seen: string | null = null;
    await expect(
      listMerchantStatement(
        sql,
        {
          balance: ledger.balance.bind(ledger),
          getTxByKey: async () => {
            const [row] = await sql<Array<{ lease_id: string }>>`
              SELECT lease_id::text AS lease_id
                FROM pay.merchant_statement_leases
               WHERE merchant_id = ${mine.id}
            `;
            seen = row?.lease_id ?? null;
            throw new Error('scan failed');
          },
        },
        { merchantId: mine.id, limit: 20, ...coveringRange() },
        statementFail,
      ),
    ).rejects.toThrow('scan failed');
    expect(seen).toBeTruthy();
    expect(await sql`SELECT 1 FROM pay.merchant_statement_leases WHERE merchant_id = ${mine.id}`).toHaveLength(0);
    const again = await pay.listStatement({ merchantId: mine.id, limit: 20, ...coveringRange() });
    expect(again.runningBalances).toBe('within_range');
  });

  it('refuses a third merchant while two statement scans are in flight on this process', async () => {
    const firstMerchant = await merchant(OWNER);
    const secondMerchant = await merchant(OTHER);
    const thirdMerchant = await merchant('44444444-4444-4444-8444-444444444444');
    await captured(firstMerchant.id);
    await captured(secondMerchant.id);
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let opened = (): void => undefined;
    const bothIn = new Promise<void>((resolve) => {
      opened = resolve;
    });
    let entered = 0;
    const blocking = {
      balance: ledger.balance.bind(ledger),
      getTxByKey: async () => {
        entered += 1;
        if (entered === 2) opened();
        await gate;
        return null;
      },
    };
    const range = coveringRange();
    const input = (merchantId: string) => ({ merchantId, limit: 20, ...range });
    const first = listMerchantStatement(sql, blocking, input(firstMerchant.id), statementFail);
    const second = listMerchantStatement(sql, blocking, input(secondMerchant.id), statementFail);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        bothIn,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('statement scans did not reach the ledger read')), 5_000);
        }),
      ]);
      await expect(listMerchantStatement(sql, blocking, input(thirdMerchant.id), statementFail)).rejects.toMatchObject({
        code: 'pay.statement_busy' satisfies PayErrorCode,
      });
      const held = await sql<Array<{ merchant_id: string }>>`
        SELECT merchant_id::text AS merchant_id FROM pay.merchant_statement_leases
      `;
      expect(new Set(held.map((row) => row.merchant_id))).toEqual(new Set([firstMerchant.id, secondMerchant.id]));
    } finally {
      if (timer) clearTimeout(timer);
      release();
      await Promise.allSettled([first, second]);
    }
    expect(await sql`SELECT 1 FROM pay.merchant_statement_leases`).toHaveLength(0);
    const after = await pay.listStatement(input(thirdMerchant.id));
    expect(after.items).toEqual([]);
    expect(after.runningBalances).toBe('within_range');
  });
});
