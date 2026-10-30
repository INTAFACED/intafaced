import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, formatAmount, parseAmount } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFounderAuthority } from './founder-authority.js';
import { loadHaltAutoTripConfig } from './halts/config.js';
import { PayHaltStore } from './halts/store.js';
import { decodeListCursor } from './list-page.js';
import { teamReadFromSql } from './merchant-team-read.js';
import { createPayHaltsRouter } from './namespaces/pay-halts.js';
import { PayService } from './payment-service.js';
import { truncatePayForTest } from './payment-events-test-reset.js';
import { ExportService } from './merchant-ops/exports.js';
import { CardSandboxAdapter } from './rails/card-sandbox.js';
import { RailRegistry } from './rails/registry.js';
import { createPayRouter } from './router.js';
import { UserMoneyService } from './user-money-service.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', 'drizzle');
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
const FINANCE_B = '33333333-3333-4333-8333-333333333333';
const ADMIN = '77777777-7777-4777-8777-777777777777';
const DEVELOPER = '88888888-8888-4888-8888-888888888888';
const FINANCE = '99999999-9999-4999-8999-999999999999';
const INVITED = '44444444-4444-4444-8444-444444444444';
const REMOVED = '55555555-5555-4555-8555-555555555555';
const STRANGER = '66666666-6666-4666-8666-666666666666';
const SECRET = 'sk_live_provider_secret_do_not_echo';

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_merchant_reads_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

async function ctx(scopes: string[], userId: string): Promise<Context> {
  const { token } = await issueAccessToken({ userId, sessionId: randomUUID(), scopes, tier: 'full', mfa: true }, authConfig);
  return { principal: await verifyAccessToken(token, authConfig), service: null, region: 'DE', requestId: randomUUID() };
}

function payCode(err: unknown): { trpc: string | undefined; pay: string | undefined } {
  const error = err as { code?: string; message?: string };
  return { trpc: error.code, pay: /pay\.[a-z0-9_.]+/.exec(error.message ?? '')?.[0] };
}

describe('merchant team reads, list pages, and stored detail', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let pay!: PayService;
  let router!: ReturnType<typeof createPayRouter>;
  let halts!: ReturnType<typeof createPayHaltsRouter>;

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    sql = db.sql;
  }, 180_000);

  beforeEach(async () => {
    await truncatePayForTest(sql, 'pay', 'TRUNCATE pay.merchants RESTART IDENTITY CASCADE');
    const ledger = new MemoryLedger();
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
    halts = createPayHaltsRouter(
      createFounderAuthority({
        identityUrl: 'https://identity.invalid',
        serviceSecret: 's'.repeat(32),
        fetcher: async () => new Response('{}', { status: 403 }),
      }),
      {
        store: new PayHaltStore(sql, loadHaltAutoTripConfig({})),
        merchants: pay,
        team: teamReadFromSql(sql),
      },
    );
  }, 30_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  async function merchant(userId: string) {
    return pay.createMerchant({ userId, pricing: { feeBps: 250 } });
  }

  async function member(merchantId: string, userId: string, role: string, status: 'active' | 'invited' | 'removed') {
    await sql`
      INSERT INTO pay.merchant_team_members (merchant_id, user_id, role, status, invited_by, activated_at, removed_at)
      VALUES (
        ${merchantId}, ${userId}, ${role}, ${status}, ${OWNER},
        ${status === 'active' ? sql`now()` : null},
        ${status === 'removed' ? sql`now()` : null}
      )`;
  }

  async function payment(merchantId: string, assetId = 'USDT', customerRef?: string) {
    return pay.createPayment({
      merchantId,
      amount: parseAmount('10'),
      assetId,
      method: 'card',
      railAdapter: 'card-sandbox',
      instrument: { kind: 'card', token: 'tok_ok' },
      ...(customerRef ? { customerRef } : {}),
    });
  }

  it('lets an active viewer read payments, settlements, and halt status, and refuses everyone else the same way', async () => {
    const mine = await merchant(OWNER);
    const other = await merchant(FINANCE_B);
    await member(mine.id, VIEWER, 'viewer', 'active');
    await member(other.id, FINANCE_B, 'finance', 'active');
    await member(mine.id, INVITED, 'viewer', 'invited');
    await member(mine.id, REMOVED, 'admin', 'removed');
    const row = await payment(mine.id, 'USDT', 'cust-w2c');
    const missingId = randomUUID();

    const viewer = router.createCaller(await ctx(['pay:read'], VIEWER));
    const got = await viewer.payment.get({ paymentId: row.id });
    expect(got.id).toBe(row.id);
    expect(got.pricingSnapshot).toBeNull();
    expect(got.failure).toBeNull();
    const listed = await viewer.payment.list({ merchantId: mine.id, limit: 10 });
    expect(listed.items.map((item) => item.id)).toEqual([row.id]);
    const history = await viewer.payment.history({ paymentId: row.id, limit: 20 });
    expect(history).toEqual(
      expect.arrayContaining([expect.objectContaining({ event: 'created', amount: '10', assetId: 'USDT', failure: null })]),
    );
    expect(history.every((event) => !('payload' in event) && !('railEventId' in event))).toBe(true);
    expect(JSON.stringify(history)).not.toContain('tok_ok');
    const haltViewer = halts.createCaller(await ctx(['pay:read'], VIEWER));
    await expect(haltViewer.payHalts.status({ merchantId: mine.id })).resolves.toMatchObject({ readable: true });

    const finance = router.createCaller(await ctx(['pay:read'], FINANCE_B));
    const foreign = await finance.payment.get({ paymentId: row.id }).catch((err: unknown) => err);
    const missing = await finance.payment.get({ paymentId: missingId }).catch((err: unknown) => err);
    expect(payCode(foreign)).toEqual(payCode(missing));
    expect(payCode(foreign).pay).toBe('pay.payment_not_found');
    const foreignList = await finance.payment.list({ merchantId: mine.id, limit: 10 }).catch((err: unknown) => err);
    const missingList = await finance.payment.list({ merchantId: randomUUID(), limit: 10 }).catch((err: unknown) => err);
    expect(payCode(foreignList)).toEqual(payCode(missingList));
    expect(payCode(foreignList).pay).toBe('pay.merchant_not_found');

    for (const userId of [INVITED, REMOVED, STRANGER]) {
      const caller = router.createCaller(await ctx(['pay:read'], userId));
      const refused = await caller.payment.get({ paymentId: row.id }).catch((err: unknown) => err);
      expect(payCode(refused).pay).toBe('pay.payment_not_found');
      const halt = halts.createCaller(await ctx(['pay:read'], userId));
      const haltRefused = await halt.payHalts.status({ merchantId: mine.id }).catch((err: unknown) => err);
      expect(payCode(haltRefused).trpc).toBe('FORBIDDEN');
    }

    const writer = router.createCaller(await ctx(['pay:write'], VIEWER));
    const created = await writer.payment
      .create({ merchantId: mine.id, amount: '10', assetId: 'USDT', method: 'card', railAdapter: 'card-sandbox' })
      .catch((err: unknown) => err);
    expect(payCode(created).pay).toBe('pay.merchant_not_found');
    expect(await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM pay.payments WHERE merchant_id = ${mine.id}`).toEqual([{ n: 1 }]);
  });

  it('pages payments and settlements by created_at and id, and applies search, date, and asset filters', async () => {
    const mine = await merchant(OWNER);
    const first = await payment(mine.id, 'USDT', 'cust-alpha');
    const second = await payment(mine.id, 'USD');
    const stamp = '2026-01-15T12:00:00.000000Z';
    await sql`UPDATE pay.payments SET created_at = ${stamp}::timestamptz WHERE id IN (${first.id}, ${second.id})`;
    await sql`UPDATE pay.payments SET rail_ref = 'rail-ref-w2c' WHERE id = ${second.id}`;

    const owner = router.createCaller(await ctx(['pay:read'], OWNER));
    await expect(owner.payment.list({ merchantId: mine.id })).rejects.toMatchObject({
      message: expect.stringContaining('pay.payment_list_limit_unset'),
    });
    const capped = await pay.listPayments({ merchantId: mine.id, limit: 201 });
    expect(capped.items.length).toBeLessThanOrEqual(200);

    const page = await owner.payment.list({ merchantId: mine.id, limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toEqual(expect.any(String));
    const rest = await owner.payment.list({ merchantId: mine.id, limit: 1, cursor: page.nextCursor! });
    expect(rest.nextCursor).toBeNull();
    expect(new Set([page.items[0]!.id, rest.items[0]!.id])).toEqual(new Set([first.id, second.id]));

    expect((await owner.payment.list({ merchantId: mine.id, limit: 10, search: first.id })).items.map((item) => item.id)).toEqual([
      first.id,
    ]);
    expect((await owner.payment.list({ merchantId: mine.id, limit: 10, search: 'cust-alpha' })).items.map((item) => item.id)).toEqual([
      first.id,
    ]);
    expect((await owner.payment.list({ merchantId: mine.id, limit: 10, search: 'rail-ref-w2c' })).items.map((item) => item.id)).toEqual([
      second.id,
    ]);
    // A caller who reads the rail reference masked cannot confirm a guessed one by searching for it; the other keys still match.
    expect((await pay.listPayments({ merchantId: mine.id, limit: 10, search: 'rail-ref-w2c', searchRailRef: false })).items).toEqual([]);
    expect(
      (await pay.listPayments({ merchantId: mine.id, limit: 10, search: 'cust-alpha', searchRailRef: false })).items.map((item) => item.id),
    ).toEqual([first.id]);
    expect((await owner.payment.list({ merchantId: mine.id, limit: 10, assetId: 'USD' })).items.map((item) => item.id)).toEqual([
      second.id,
    ]);
    expect(
      (await owner.payment.list({ merchantId: mine.id, limit: 10, from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z' }))
        .items,
    ).toHaveLength(2);
    expect((await owner.payment.list({ merchantId: mine.id, limit: 10, from: '2026-03-01T00:00:00.000Z' })).items).toHaveLength(0);
    await expect(owner.payment.list({ merchantId: mine.id, limit: 10, cursor: 'not-a-cursor' })).rejects.toMatchObject({
      message: expect.stringContaining('pay.list_cursor_invalid'),
    });
    await expect(
      pay.listPayments({ merchantId: mine.id, limit: 10, from: '2026-02-01T00:00:00.000Z', to: '2026-01-01T00:00:00.000Z' }),
    ).rejects.toMatchObject({
      code: 'pay.list_range_invalid',
    });

    const [pending] = await sql<{ id: string }[]>`
      INSERT INTO pay.settlements (merchant_id, "window", asset_id, gross, fees, net, status, payout_ref)
      VALUES (${mine.id}, '2099-01-01', 'USDT', 1, 0, 1, 'pending', 'payout-ref-w2c')
      RETURNING id`;
    const unread = await owner.settlement.get({ settlementId: pending!.id });
    expect(unread.sentAt).toBeNull();
    expect(unread.settledAt).toBeNull();
    expect(unread.failedAt).toBeNull();
    expect(unread.failure).toBeNull();
    expect(unread.pricingSnapshot).toBeNull();
    expect(
      (await owner.settlement.list({ merchantId: mine.id, limit: 10, search: 'payout-ref-w2c' })).items.map((item) => item.id),
    ).toEqual([pending!.id]);
    expect((await owner.settlement.list({ merchantId: mine.id, limit: 10, search: '2099-01-01' })).items).toHaveLength(1);
  });

  it('counts the filter, searches the merchant reference only, and lists each rail try', async () => {
    const mine = await merchant(OWNER);
    const named = await pay.createPayment({
      merchantId: mine.id,
      amount: parseAmount('10'),
      assetId: 'USDT',
      method: 'card',
      railAdapter: 'card-sandbox',
      instrument: { kind: 'card', token: 'tok_ok' },
      metadata: { reference: 'ord-77', name: 'Alice', email: 'alice@example.com' },
    });
    const other = await pay.createPayment({
      merchantId: mine.id,
      amount: parseAmount('25'),
      assetId: 'USDT',
      method: 'card',
      railAdapter: 'card-sandbox',
      instrument: { kind: 'card', token: 'tok_ok' },
      customerRef: 'cust-beta',
    });
    const failed = await payment(mine.id, 'USDT');
    await pay.authorize(named.id);
    await pay.authorize(other.id);
    await sql`UPDATE pay.payments SET status = 'captured'::pay.payment_status WHERE id IN (${named.id}, ${other.id})`;
    await sql`UPDATE pay.payments SET status = 'failed'::pay.payment_status WHERE id = ${failed.id}`;

    const owner = router.createCaller(await ctx(['pay:read', 'pay:write'], OWNER));
    const page = await owner.payment.list({ merchantId: mine.id, limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.summary).toEqual({
      matchedCount: '3',
      succeededCount: '2',
      failedCount: '1',
      finishedCount: '3',
      successRate: '67',
    });
    expect(JSON.stringify(page)).not.toContain('alice@example.com');
    expect(JSON.stringify(page)).not.toContain('Alice');

    expect((await owner.payment.list({ merchantId: mine.id, limit: 10, search: 'ord-77' })).items.map((item) => item.id)).toEqual([
      named.id,
    ]);
    expect((await owner.payment.list({ merchantId: mine.id, limit: 10, search: 'Alice' })).items).toHaveLength(0);
    expect((await owner.payment.list({ merchantId: mine.id, limit: 10, search: 'alice@example.com' })).items).toHaveLength(0);
    expect(
      (await owner.payment.list({ merchantId: mine.id, limit: 10, amountMin: '20', amountMax: '30' })).items.map((item) => item.id),
    ).toEqual([other.id]);
    await expect(owner.payment.list({ merchantId: mine.id, limit: 10, amountMin: '' })).rejects.toMatchObject({
      message: expect.stringContaining('pay.list_amount_invalid'),
    });
    await expect(owner.payment.list({ merchantId: mine.id, limit: 10, amountMin: '30', amountMax: '20' })).rejects.toMatchObject({
      message: expect.stringContaining('pay.list_amount_range_invalid'),
    });
    await expect(pay.listPayments({ merchantId: mine.id, limit: 10, amountMin: ' 10' })).rejects.toMatchObject({
      code: 'pay.list_amount_invalid',
    });

    const detail = await owner.payment.get({ paymentId: named.id });
    expect(detail.railRef).toEqual(expect.any(String));
    expect(detail.attempts).toHaveLength(1);
    expect(detail.attempts[0]).toMatchObject({ status: 'authorized', mapsTo: 'authorized' });
    await sql`
      INSERT INTO pay.payment_events (payment_id, event, payload)
      VALUES (
        ${named.id},
        'rail.authorize',
        ${sql.json({
          ok: false,
          status: 'failed',
          railRef: 'rail-try-2',
          amount: '10',
          assetId: 'USDT',
          at: '2026-04-02T00:00:00.000Z',
          failureCode: 'card.declined',
          failureReason: null,
        })}
      )`;
    const both = await owner.payment.get({ paymentId: named.id });
    expect(both.attempts.map((attempt) => attempt.status)).toEqual(['authorized', 'failed']);
    expect(both.attempts[1]).toMatchObject({ railRef: 'rail-try-2', mapsTo: 'failed' });
    expect(both.status).toBe('captured');

    const exports = new ExportService(sql);
    const caller = {
      userId: OWNER,
      merchantId: mine.id,
      role: 'owner' as const,
      viaApiKey: false,
      interactive: true,
    };
    await expect(
      exports.create(caller, { requestId: randomUUID(), kind: 'payments', filters: { amountMin: '' }, columns: ['payment_id', 'amount'] }),
    ).rejects.toMatchObject({ code: 'pay.export_filter_invalid' });
    const job = await exports.create(caller, {
      requestId: randomUUID(),
      kind: 'payments',
      filters: { status: 'failed', amountMin: '5', amountMax: '15' },
      columns: ['payment_id', 'amount'],
    });
    expect(await exports.process(job.job.jobId)).toBe(true);
    const file = await exports.download(caller, job.job.jobId);
    expect(file.rowCount).toBe(1);
    expect(file.fileName).toMatch(/\.csv$/);
    const lines = file.content.split('\r\n').filter((line) => line.length > 0);
    expect(lines[0]).toBe('payment_id,amount');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain(failed.id);
    expect(lines[1]).toContain(formatAmount(parseAmount('10')));
    expect(file.content).not.toContain(named.id);
    expect(file.content).not.toContain('alice@example.com');
  });

  it('returns the stored fee, settlement timestamps, payment lines, and a safe failure', async () => {
    const mine = await merchant(OWNER);
    const created = await payment(mine.id);
    const authorized = await pay.authorize(created.id);
    const captured = await pay.capture(authorized.id);
    const [rule] = await sql<{ id: string }[]>`
      INSERT INTO pay.control_pricing_rules (layer, scope_id, asset_code, bands, rounding_beneficiary, version, created_by)
      VALUES ('merchant', ${mine.id}, 'USDT', '[{"fromAmount":"0","feeBps":250}]'::jsonb, 'platform', 1, ${OWNER})
      RETURNING id`;
    await sql`
      INSERT INTO pay.control_pricing_snapshots (
        subject_kind, subject_id, merchant_id, asset_code, applied_layer, rule_id, rule_chain,
        base_amount, monthly_volume_before, band_from, fee_bps, rounding_beneficiary, rounding_mode,
        bps_fee, fee_before_clamp, fee
      ) VALUES (
        'payment', ${captured.id}, ${mine.id}, 'USDT', 'merchant', ${rule!.id}, '[]'::jsonb,
        10, 0, 0, 250, 'platform', 'ceil', 0.25, 0.25, 1.25
      )`;
    await sql`UPDATE pay.merchants SET pricing = '{"feeBps":900}'::jsonb WHERE id = ${mine.id}`;

    await member(mine.id, ADMIN, 'admin', 'active');
    await member(mine.id, FINANCE, 'finance', 'active');
    await member(mine.id, DEVELOPER, 'developer', 'active');
    await member(mine.id, VIEWER, 'viewer', 'active');

    const owner = router.createCaller(await ctx(['pay:read'], OWNER));
    const detail = await owner.payment.get({ paymentId: captured.id });
    expect(detail.pricingSnapshot).toMatchObject({ fee: '1.25', feeBps: 250, ruleId: rule!.id, appliedLayer: 'merchant' });
    for (const userId of [ADMIN, FINANCE]) {
      const caller = router.createCaller(await ctx(['pay:read'], userId));
      expect((await caller.payment.get({ paymentId: captured.id })).pricingSnapshot).toMatchObject({
        fee: '1.25',
        ruleId: rule!.id,
        appliedLayer: 'merchant',
      });
    }
    for (const userId of [VIEWER, DEVELOPER]) {
      const caller = router.createCaller(await ctx(['pay:read'], userId));
      const snap = (await caller.payment.get({ paymentId: captured.id })).pricingSnapshot;
      expect(snap).toEqual({ fee: '1.25' });
      expect(JSON.stringify(snap)).not.toContain(rule!.id);
    }

    const posted = await pay.settleWindow({
      merchantId: mine.id,
      window: '2026-10-16',
      assetId: 'USDT',
      from: new Date('2020-01-01T00:00:00.000Z'),
      to: new Date('2030-01-01T00:00:00.000Z'),
    });
    const settlement = await owner.settlement.get({ settlementId: posted.id });
    expect(settlement.settledAt).toEqual(expect.any(String));
    expect(settlement.sentAt).toBeNull();
    expect(settlement.failedAt).toBeNull();
    const lines = await owner.settlement.lines({ settlementId: posted.id, limit: 10 });
    expect(lines.items.map((line) => line.paymentId)).toContain(captured.id);
    expect(lines.items[0]!.amount).toBe('10');
    expect(lines.items[0]!.includedAmountKnown).toBe(true);

    const failedPayment = await payment(mine.id);
    await sql`
      INSERT INTO pay.payment_events (payment_id, event, payload)
      VALUES (${failedPayment.id}, 'failed', ${sql.json({ failureCode: 'card.declined', failureReason: SECRET })})`;
    const failed = await owner.payment.get({ paymentId: failedPayment.id });
    expect(failed.failure).toEqual({ code: 'card.declined', message: 'The card was declined.' });
    expect(JSON.stringify(failed)).not.toContain(SECRET);
    expect(JSON.stringify(await owner.payment.list({ merchantId: mine.id, limit: 10 }))).not.toContain(SECRET);

    const viewerSettlement = await router.createCaller(await ctx(['pay:read'], VIEWER)).settlement.get({ settlementId: posted.id });
    expect(viewerSettlement.pricingSnapshot).toBeNull();
  });

  it('hides rail failure text, the instrument, and the routing decision from every team role', async () => {
    const mine = await merchant(OWNER);
    for (const [userId, role] of [
      [VIEWER, 'viewer'],
      [DEVELOPER, 'developer'],
      [FINANCE, 'finance'],
      [ADMIN, 'admin'],
    ] as const) {
      await member(mine.id, userId, role, 'active');
    }
    const row = await pay.createPayment({
      merchantId: mine.id,
      amount: parseAmount('10'),
      assetId: 'USDT',
      method: 'card',
      railAdapter: 'card-sandbox',
      instrument: { kind: 'card', token: SECRET },
    });
    await sql`
      INSERT INTO pay.payment_events (payment_id, event, payload)
      VALUES
        (${row.id}, 'failed', ${sql.json({ failureCode: 'card.declined', failureReason: SECRET, railPayload: { secret: SECRET } })}),
        (${row.id}, 'rail.authorize', ${sql.json({ failureReason: SECRET, amount: '10', assetId: 'USDT' })}),
        (${row.id}, 'rail.selected', ${sql.json({ kind: 'pay.routing.decision', chosenRailId: SECRET, considered: [{ railId: SECRET }] })})`;

    const ownerHistory = JSON.stringify(
      await router.createCaller(await ctx(['pay:read'], OWNER)).payment.history({ paymentId: row.id, limit: 20 }),
    );
    expect(ownerHistory).toContain(SECRET);

    for (const userId of [VIEWER, DEVELOPER, FINANCE, ADMIN]) {
      const history = await router.createCaller(await ctx(['pay:read'], userId)).payment.history({ paymentId: row.id, limit: 20 });
      const body = JSON.stringify(history);
      expect(body).not.toContain(SECRET);
      expect(body).not.toContain('failureReason');
      expect(body).not.toContain('chosenRailId');
      expect(body).not.toContain('railPayload');
      expect(history.every((event) => !('payload' in event))).toBe(true);
      expect(body).toContain('card.declined');
      expect(body).toContain('The card was declined.');
    }
  });

  it('lists settlement lines at the frozen net, which sums to the gross', async () => {
    const mine = await merchant(OWNER);
    const other = await merchant(FINANCE);
    // The authorization amount is frozen and the event log is append-only, so a
    // partial capture cannot be written. The rail interface refuses it; the
    // difference is a refund, then a further partial refund. The frozen net is
    // 20 - 8 - 4 = 8, not the face amount 20.
    const partial = await pay.createPayment({
      merchantId: mine.id,
      amount: parseAmount('20'),
      assetId: 'USDT',
      method: 'card',
      railAdapter: 'card-sandbox',
      instrument: { kind: 'card', token: 'tok_ok' },
    });
    const authorized = await pay.authorize(partial.id);
    await expect(pay.capture(authorized.id, { amount: parseAmount('12') })).rejects.toMatchObject({
      code: 'pay.partial_capture_unsupported',
    });
    const captured = await pay.capture(authorized.id);
    await pay.refund(captured.id, parseAmount('8'));
    await pay.refund(captured.id, parseAmount('4'));
    const whole = await payment(mine.id);
    await pay.capture((await pay.authorize(whole.id)).id);

    const posted = await pay.settleWindow({
      merchantId: mine.id,
      window: '2026-10-16-lines',
      assetId: 'USDT',
      from: new Date('2020-01-01T00:00:00.000Z'),
      to: new Date('2030-01-01T00:00:00.000Z'),
    });
    expect(formatAmount(posted.gross)).toBe('18');

    const owner = router.createCaller(await ctx(['pay:read'], OWNER));
    const lines = await owner.settlement.lines({ settlementId: posted.id, limit: 10 });
    const byId = new Map(lines.items.map((line) => [line.paymentId, line]));
    expect(byId.get(captured.id)).toMatchObject({ amount: '8', includedAmountKnown: true });
    expect(byId.get(whole.id)).toMatchObject({ amount: '10', includedAmountKnown: true });
    const sum = lines.items.reduce((total, line) => total + parseAmount(line.amount ?? '0'), 0n);
    expect(formatAmount(sum)).toBe(formatAmount(posted.gross));

    const foreign = await payment(other.id);
    await sql`
      INSERT INTO pay.payment_events (payment_id, event, payload)
      VALUES (${foreign.id}, 'settlement.included', ${sql.json({ settlementId: posted.id, amount: '999', assetId: 'USDT' })})`;
    const fenced = await owner.settlement.lines({ settlementId: posted.id, limit: 10 });
    expect(fenced.items.map((line) => line.paymentId)).not.toContain(foreign.id);

    const [older] = await sql<{ id: string }[]>`
      INSERT INTO pay.settlements (merchant_id, "window", asset_id, gross, fees, net, status)
      VALUES (${mine.id}, '2001-01-01', 'USDT', 10, 0, 10, 'posted')
      RETURNING id`;
    await sql`
      INSERT INTO pay.payment_events (payment_id, event, payload)
      VALUES (${whole.id}, 'settlement.included', ${sql.json({ settlementId: older!.id, window: '2001-01-01', assetId: 'USDT' })})`;
    const legacy = await owner.settlement.lines({ settlementId: older!.id, limit: 10 });
    expect(legacy.items).toEqual([expect.objectContaining({ paymentId: whole.id, amount: null, includedAmountKnown: false })]);

    const [index] = await sql<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE indexname = 'payment_events_settlement_included_idx'`;
    expect(index!.indexdef).toMatch(/payload\s*->>\s*'settlementId'/);
    expect(index!.indexdef).toContain('settlement.included');
  });

  it('does not put a live payment id in a sandbox list cursor', async () => {
    const mine = await merchant(OWNER);
    const newest = await payment(mine.id);
    // This harness only registers the sandbox rail. The live row is inserted
    // with a rail id that does not end in `-sandbox`; the column cannot be updated later.
    const [live] = await sql<{ id: string }[]>`
      INSERT INTO pay.payments (merchant_id, amount, currency, method, rail_adapter, status, created_at)
      VALUES (${mine.id}, 10, 'USDT', 'crypto', 'crypto-native', 'created', '2026-06-02T00:00:00.000Z')
      RETURNING id`;
    const oldest = await payment(mine.id);
    await sql`UPDATE pay.payments SET created_at = '2026-06-03T00:00:00.000Z' WHERE id = ${newest.id}`;
    await sql`UPDATE pay.payments SET created_at = '2026-06-01T00:00:00.000Z' WHERE id = ${oldest.id}`;

    const page = await pay.listPayments({ merchantId: mine.id, limit: 1, railMode: 'sandbox' });
    expect(page.items.map((item) => item.id)).toEqual([newest.id]);
    expect(decodeListCursor(page.nextCursor!).id).toBe(newest.id);
    const rest = await pay.listPayments({ merchantId: mine.id, limit: 1, railMode: 'sandbox', cursor: page.nextCursor! });
    expect(rest.items.map((item) => item.id)).toEqual([oldest.id]);
    expect(rest.nextCursor).toBeNull();
    expect([page.items[0]!.id, rest.items[0]!.id]).not.toContain(live!.id);
  });

  it('emits a settlement failure only while the settlement is failed', async () => {
    const mine = await merchant(OWNER);
    const [paid] = await sql<{ id: string }[]>`
      INSERT INTO pay.settlements (
        merchant_id, "window", asset_id, gross, fees, net, status, payout_method, payout_ref, failure_code, failed_at
      )
      VALUES (
        ${mine.id}, '2099-02-02', 'USDT', 1, 0, 1, 'paid_out', 'card-sandbox', 'rail-ref-paid', 'bank.rejected', now()
      )
      RETURNING id`;
    const owner = router.createCaller(await ctx(['pay:read'], OWNER));
    const detail = await owner.settlement.get({ settlementId: paid!.id });
    expect(detail.status).toBe('paid_out');
    expect(detail.failure).toBeNull();
    expect(detail.failedAt).toBeNull();
    expect(detail.createdAt).not.toBe('1970-01-01T00:00:00.000Z');
  });

  async function bindSession(merchantId: string, linkId: string, paymentId: string) {
    await sql`
      INSERT INTO pay.checkout_sessions (
        link_id, merchant_id, payment_id, token_hash, token_prefix, amount, currency, rail_adapter, expires_at
      ) VALUES (
        ${linkId}, ${merchantId}, ${paymentId}, ${randomUUID()}, 'cs_test', 10, 'USDT', 'card-sandbox', now() + interval '15 minutes'
      )`;
  }

  it('filters payment.list by linkId and returns an empty page for a foreign or missing link', async () => {
    const mine = await merchant(OWNER);
    const other = await merchant(FINANCE_B);
    const mineLink = await pay.createPaymentLink({ merchantId: mine.id, label: 'mine' });
    const otherLink = await pay.createPaymentLink({ merchantId: other.id, label: 'theirs' });
    const linked = await payment(mine.id);
    const alsoLinked = await payment(mine.id);
    const direct = await payment(mine.id);
    const theirs = await payment(other.id);
    await bindSession(mine.id, mineLink.id, linked.id);
    await bindSession(mine.id, mineLink.id, alsoLinked.id);
    await bindSession(other.id, otherLink.id, theirs.id);
    await sql`UPDATE pay.payments SET created_at = '2026-04-02T00:00:00.000Z' WHERE id = ${linked.id}`;
    await sql`UPDATE pay.payments SET created_at = '2026-04-03T00:00:00.000Z' WHERE id = ${alsoLinked.id}`;

    const owner = router.createCaller(await ctx(['pay:read'], OWNER));
    const page = await owner.payment.list({ merchantId: mine.id, limit: 1, linkId: mineLink.id });
    expect(page.items.map((item) => item.id)).toEqual([alsoLinked.id]);
    expect(page.nextCursor).toEqual(expect.any(String));
    const rest = await owner.payment.list({ merchantId: mine.id, limit: 10, linkId: mineLink.id, cursor: page.nextCursor! });
    expect(rest.items.map((item) => item.id)).toEqual([linked.id]);
    expect(rest.nextCursor).toBeNull();
    expect(rest.items.map((item) => item.id)).not.toContain(direct.id);

    const open = await owner.payment.list({ merchantId: mine.id, limit: 1 });
    const foreign = await owner.payment.list({
      merchantId: mine.id,
      limit: 10,
      linkId: otherLink.id,
      cursor: open.nextCursor!,
    });
    const missing = await owner.payment.list({ merchantId: mine.id, limit: 10, linkId: randomUUID() });
    const empty = {
      items: [],
      nextCursor: null,
      summary: { matchedCount: '0', succeededCount: '0', failedCount: '0', finishedCount: '0', successRate: null },
    };
    expect(foreign).toEqual(empty);
    expect(missing).toEqual(empty);
    await expect(owner.payment.list({ merchantId: mine.id, limit: 10, linkId: 'not-a-link' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('reads the checkout profile the write stored, and refuses a foreign merchant like a missing one', async () => {
    const mine = await merchant(OWNER);
    const other = await merchant(FINANCE_B);
    await member(mine.id, VIEWER, 'viewer', 'active');
    await member(mine.id, DEVELOPER, 'developer', 'active');
    await member(mine.id, FINANCE, 'finance', 'active');
    await member(mine.id, ADMIN, 'admin', 'active');
    const owner = router.createCaller(await ctx(['pay:read', 'pay:write'], OWNER));
    expect(await owner.merchant.checkoutSettings.get({ merchantId: mine.id })).toEqual({ status: 'not_configured' });

    const storedRouting = { bearer: 'merchant' };
    const first = await owner.merchant.profile({
      merchantId: mine.id,
      domains: ['old.example'],
      checkoutConfig: { brandName: 'Old' },
      feeRouting: { bearer: 'customer' },
    });
    const second = await owner.merchant.profile({
      merchantId: mine.id,
      domains: ['checkout.example'],
      feeRouting: storedRouting,
    });
    await sql`UPDATE pay.payment_profiles SET created_at = now() - interval '1 minute' WHERE id = ${first.id}`;
    const current = await owner.merchant.checkoutSettings.get({ merchantId: mine.id });
    expect(current).toMatchObject({
      status: 'configured',
      profileId: second.id,
      domains: ['checkout.example'],
      checkoutConfig: {},
      feeRouting: storedRouting,
    });
    expect(current).not.toMatchObject({ profileId: first.id });
    if (current.status === 'configured') expect(current.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    for (const userId of [VIEWER, DEVELOPER]) {
      const caller = router.createCaller(await ctx(['pay:read'], userId));
      expect(await caller.merchant.checkoutSettings.get({ merchantId: mine.id })).toMatchObject({
        profileId: second.id,
        checkoutConfig: {},
        feeRouting: null,
      });
    }
    for (const userId of [FINANCE, ADMIN]) {
      const caller = router.createCaller(await ctx(['pay:read'], userId));
      expect(await caller.merchant.checkoutSettings.get({ merchantId: mine.id })).toMatchObject({
        profileId: second.id,
        checkoutConfig: {},
        feeRouting: storedRouting,
      });
    }

    const otherOwner = router.createCaller(await ctx(['pay:read', 'pay:write'], FINANCE_B));
    const hidden = await otherOwner.merchant.profile({
      merchantId: other.id,
      domains: ['other.example'],
      checkoutConfig: { brandName: 'Hidden' },
    });
    expect(await otherOwner.merchant.checkoutSettings.get({ merchantId: other.id })).toMatchObject({
      profileId: hidden.id,
      domains: ['other.example'],
      checkoutConfig: { brandName: 'Hidden' },
      feeRouting: {},
    });
    const foreign = await owner.merchant.checkoutSettings.get({ merchantId: other.id }).catch((err: unknown) => err);
    const missing = await owner.merchant.checkoutSettings.get({ merchantId: randomUUID() }).catch((err: unknown) => err);
    expect(payCode(foreign)).toEqual(payCode(missing));
    expect(payCode(foreign).pay).toBe('pay.merchant_not_found');
    expect(JSON.stringify(foreign)).not.toContain('other.example');
    expect(JSON.stringify(await owner.merchant.checkoutSettings.get({ merchantId: mine.id }))).not.toContain('other.example');

    const stranger = router.createCaller(await ctx(['pay:read'], STRANGER));
    const strangerForeign = await stranger.merchant.checkoutSettings.get({ merchantId: mine.id }).catch((err: unknown) => err);
    const strangerMissing = await stranger.merchant.checkoutSettings.get({ merchantId: randomUUID() }).catch((err: unknown) => err);
    expect(payCode(strangerForeign)).toEqual(payCode(strangerMissing));

    await sql`UPDATE pay.payment_profiles SET checkout_config = '[]'::jsonb WHERE id = ${second.id}`;
    await expect(owner.merchant.checkoutSettings.get({ merchantId: mine.id })).rejects.toMatchObject({
      message: expect.stringContaining('pay.checkout_settings_unreadable'),
    });
  });
});
