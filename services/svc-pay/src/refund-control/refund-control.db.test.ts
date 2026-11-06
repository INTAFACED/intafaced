import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryLedger, merchantClearing, parseAmount as amt, type LedgerClient } from '@intafaced/ledger-client';
import { PayService } from '../payment-service.js';
import { installPayoutDestinationShim } from '../payout-destination-test-shim.js';
import { truncatePayForTest } from '../payment-events-test-reset.js';
import { memoryPayoutDestinations } from '../merchant-payout-destination.js';
import { RailRegistry } from '../rails/registry.js';
import { CardSandboxAdapter, SANDBOX_REFUND_REFUSED_TOKEN } from '../rails/card-sandbox.js';
import { REFERENCE_RAIL_ROUTING_PROFILES } from '../routing/decide.js';
import { composeGuards, PayGuardRefusal } from '../seams/guards.js';
import { createRefundApprovalGuards, RefundControl } from './service.js';

/**
 * J-merchant-06: the refund controls around the one refund door, against a real database and the sandbox card rail.
 * Money is checked on the ledger itself (merchant clearing), not on svc-pay's projections.
 */
const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const SECRET = 'svc-pay-refund-control-secret-at-least-32';
const OWNER = '11111111-1111-4111-8111-111111111111';
const FINANCE = '22222222-2222-4222-8222-222222222222';

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_refund_control_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: () => container.stop().then(() => undefined) };
}

describe('refund controls, void and reverse (J-merchant-06)', { timeout: 60_000 }, () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let ledger: MemoryLedger;
  let card: CardSandboxAdapter;
  let pay: PayService;
  let control: RefundControl;

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    sql = db.sql;
  }, 120_000);

  let restoreShim: (() => void) | undefined;
  afterEach(() => {
    restoreShim?.();
    restoreShim = undefined;
  });

  beforeEach(async () => {
    restoreShim = installPayoutDestinationShim(sql);
    await truncatePayForTest(
      sql,
      'pay',
      `TRUNCATE pay.refund_batch_rows, pay.refund_requests, pay.refund_approval_rule_changes, pay.refund_approval_rules, pay.checkout_sessions, pay.payment_links, pay.settlements, pay.payment_events, pay.payments, pay.payment_profiles, pay.merchants RESTART IDENTITY CASCADE`,
    );
    ledger = new MemoryLedger();
    card = new CardSandboxAdapter({ secret: SECRET, toleranceSeconds: 300 });
    pay = new PayService(sql, ledger as LedgerClient, new RailRegistry([card]), {
      payoutDestinations: memoryPayoutDestinations(),
      checkoutRiskBand: 'low',
      routingProfiles: REFERENCE_RAIL_ROUTING_PROFILES.map((p) => ({ ...p })),
      linkDefaultTtlDays: 30,
      linkMaxTtlDays: 365,
      checkoutSessionTtlSeconds: 900,
      maxOpenSessionsPerLink: 25,
      guards: composeGuards(createRefundApprovalGuards()),
    });
    control = new RefundControl(sql, pay);
  }, 30_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  async function merchant() {
    return pay.createMerchant({ userId: OWNER, pricing: { feeBps: 0 } });
  }

  async function authorised(merchantId: string, amount: string, token = 'tok_ok') {
    const p = await pay.createPayment({
      merchantId,
      amount: amt(amount),
      assetId: 'USDC',
      method: 'card',
      railAdapter: 'card-sandbox',
      instrument: { kind: 'card', token },
    });
    return pay.authorize(p.id);
  }

  async function captured(merchantId: string, amount: string, token = 'tok_ok') {
    const p = await authorised(merchantId, amount, token);
    return pay.capture(p.id);
  }

  const clearing = async (merchantId: string) => (await ledger.balance(merchantClearing(merchantId, 'USDC'))).amount;
  const refundedEvents = async (paymentId: string) =>
    (await sql`SELECT payload FROM pay.payment_events WHERE payment_id = ${paymentId} AND event = 'refunded'`).length;

  it('void: an authorisation is released with no ledger post; again answers the same; it can no longer be captured', async () => {
    const m = await merchant();
    const p = await authorised(m.id, '40');
    const before = ledger.journal().length;
    expect((await pay.voidPayment(p.id)).status).toBe('voided');
    expect((await pay.voidPayment(p.id)).status).toBe('voided');
    expect(ledger.journal().length).toBe(before);
    await expect(pay.capture(p.id)).rejects.toMatchObject({ code: 'pay.invalid_transition' });
  });

  it('void: a captured payment is refused, and an unknown rail answer keeps the authorisation and blocks capture', async () => {
    const m = await merchant();
    const c = await captured(m.id, '10');
    await expect(pay.voidPayment(c.id)).rejects.toMatchObject({ code: 'pay.void_not_authorized' });

    const p = await authorised(m.id, '20');
    const real = card.void.bind(card);
    card.void = async () => {
      throw new Error('timeout');
    };
    await expect(pay.voidPayment(p.id)).rejects.toMatchObject({ code: 'pay.void_outcome_unknown' });
    expect((await pay.getPayment(p.id)).status).toBe('authorized');
    // The intent stays: nothing may capture a hold the rail may already have released.
    await expect(pay.capture(p.id)).rejects.toMatchObject({ code: 'pay.void_in_flight' });
    card.void = real;
    expect((await pay.voidPayment(p.id)).status).toBe('voided');
  });

  it('an open dispute refuses a refund and moves nothing', async () => {
    const m = await merchant();
    const p = await captured(m.id, '12');
    await sql`UPDATE pay.payments SET status = 'disputed' WHERE id = ${p.id}`;
    const before = await clearing(m.id);
    await expect(pay.refund(p.id, amt('1'), { refundId: `refund:${p.id}:d` })).rejects.toMatchObject({ code: 'pay.refund_open_dispute' });
    expect(await clearing(m.id)).toBe(before);
  });

  it('above the rule a refund waits: no post until a checker who is not the maker approves, then it runs once', async () => {
    const m = await merchant();
    await control.setRule(m.id, 'USDC', amt('100'), OWNER);
    const p = await captured(m.id, '150');
    const before = await clearing(m.id);
    // Straight through the door: refused by the guard, nothing debited.
    await expect(pay.refund(p.id, amt('150'), { refundId: `refund:${p.id}:a` })).rejects.toBeInstanceOf(PayGuardRefusal);
    expect(await clearing(m.id)).toBe(before);

    const first = await control.request({
      merchantId: m.id,
      paymentId: p.id,
      amount: amt('150'),
      refundId: `refund:${p.id}:a`,
      makerUserId: OWNER,
    });
    expect(first.status).toBe('queued');
    await expect(control.decide({ requestId: first.id, checkerUserId: OWNER, decision: 'approve' })).rejects.toMatchObject({
      code: 'pay.refund_approval_self',
    });
    // The maker changes the amount: the first request is void and its approval can never run.
    const second = await control.request({
      merchantId: m.id,
      paymentId: p.id,
      amount: amt('140'),
      refundId: `refund:${p.id}:b`,
      makerUserId: OWNER,
    });
    expect((await control.get(first.id)).status).toBe('voided');
    await expect(control.decide({ requestId: first.id, checkerUserId: FINANCE, decision: 'approve' })).rejects.toMatchObject({
      code: 'pay.refund_request_closed',
    });
    expect(await clearing(m.id)).toBe(before);

    const done = await control.decide({ requestId: second.id, checkerUserId: FINANCE, decision: 'approve' });
    expect(done.status).toBe('refunded');
    await expect(control.decide({ requestId: second.id, checkerUserId: FINANCE, decision: 'approve' })).rejects.toMatchObject({
      code: 'pay.refund_request_closed',
    });
    // Invariant: exactly the approved amount left clearing, once, and the payment's log agrees with the ledger.
    expect(before - (await clearing(m.id))).toBe(amt('140'));
    expect(await refundedEvents(p.id)).toBe(1);
    expect((await pay.getPayment(p.id)).refundedAmount).toBe(amt('140'));
  });

  it('a queued request is cancelled once and posts nothing; the same key with another amount is refused', async () => {
    const m = await merchant();
    await control.setRule(m.id, 'USDC', amt('5'), OWNER);
    const p = await captured(m.id, '20');
    const r = await control.request({
      merchantId: m.id,
      paymentId: p.id,
      amount: amt('10'),
      refundId: `refund:${p.id}:q`,
      makerUserId: OWNER,
    });
    await expect(
      control.request({ merchantId: m.id, paymentId: p.id, amount: amt('11'), refundId: `refund:${p.id}:q`, makerUserId: OWNER }),
    ).rejects.toMatchObject({ code: 'pay.refund_id_conflict' });
    expect((await control.cancel(r.id)).status).toBe('cancelled');
    await expect(control.cancel(r.id)).rejects.toMatchObject({ code: 'pay.refund_request_closed' });
    expect(await refundedEvents(p.id)).toBe(0);
    await expect(
      control.request({ merchantId: m.id, paymentId: p.id, amount: amt('21'), refundId: `refund:${p.id}:big`, makerUserId: OWNER }),
    ).rejects.toMatchObject({ code: 'pay.refund_exceeds_captured' });
  });

  it('a rail refusal on an approved refund closes the request as failed and returns the money', async () => {
    const m = await merchant();
    await control.setRule(m.id, 'USDC', amt('1'), OWNER);
    const p = await captured(m.id, '5', SANDBOX_REFUND_REFUSED_TOKEN);
    const before = await clearing(m.id);
    const r = await control.request({
      merchantId: m.id,
      paymentId: p.id,
      amount: amt('5'),
      refundId: `refund:${p.id}:x`,
      makerUserId: OWNER,
    });
    const decided = await control.decide({ requestId: r.id, checkerUserId: FINANCE, decision: 'approve' });
    expect(decided).toMatchObject({ status: 'failed', failureCode: 'pay.rail_failed' });
    expect(await clearing(m.id)).toBe(before);
  });

  it('bulk: each row runs once, a run again refunds nothing more, and the refused rows are named', async () => {
    const m = await merchant();
    const a = await captured(m.id, '8');
    const b = await captured(m.id, '8');
    const spent = await captured(m.id, '3');
    await pay.refund(spent.id, amt('3'), { refundId: `refund:${spent.id}:all` });
    const before = await clearing(m.id);
    const batchId = '33333333-3333-4333-8333-333333333333';
    const rows = [{ paymentId: a.id }, { paymentId: b.id }, { paymentId: spent.id }];
    const first = await control.bulk({ merchantId: m.id, batchId, rows, makerUserId: OWNER });
    expect(first.map((r) => [r.outcome, r.refusalCode])).toEqual([
      ['refunded', null],
      ['refunded', null],
      ['refused', 'pay.nothing_captured'],
    ]);
    const again = await control.bulk({ merchantId: m.id, batchId, rows, makerUserId: OWNER });
    expect(again.map((r) => r.outcome)).toEqual(['refunded', 'refunded', 'refused']);
    expect(before - (await clearing(m.id))).toBe(amt('16'));
    expect(await refundedEvents(a.id)).toBe(1);
    expect(await refundedEvents(b.id)).toBe(1);
    await expect(control.bulk({ merchantId: m.id, batchId, rows: [{ paymentId: a.id }], makerUserId: OWNER })).rejects.toMatchObject({
      code: 'pay.refund_batch_invalid',
    });
  });

  it('a refund split into smaller ones is counted whole against the rule', async () => {
    const m = await merchant();
    await control.setRule(m.id, 'USDC', amt('100'), OWNER);
    const p = await captured(m.id, '1000');
    await pay.refund(p.id, amt('100'), { refundId: `refund:${p.id}:s1` });
    const before = await clearing(m.id);
    await expect(pay.refund(p.id, amt('1'), { refundId: `refund:${p.id}:s2` })).rejects.toBeInstanceOf(PayGuardRefusal);
    expect(await clearing(m.id)).toBe(before);
  });

  it('while an approved refund has no answer, no new request may void it, and a retry never sends it twice', async () => {
    const m = await merchant();
    await control.setRule(m.id, 'USDC', amt('1'), OWNER);
    const p = await captured(m.id, '10');
    const r = await control.request({
      merchantId: m.id,
      paymentId: p.id,
      amount: amt('5'),
      refundId: `refund:${p.id}:u`,
      makerUserId: OWNER,
    });
    const real = card.refund.bind(card);
    card.refund = async () => {
      throw new Error('timeout');
    };
    await expect(control.decide({ requestId: r.id, checkerUserId: FINANCE, decision: 'approve' })).rejects.toThrow();
    expect((await control.get(r.id)).status).toBe('approved');
    await expect(
      control.request({ merchantId: m.id, paymentId: p.id, amount: amt('4'), refundId: `refund:${p.id}:v`, makerUserId: OWNER }),
    ).rejects.toMatchObject({ code: 'pay.refund_in_flight' });
    card.refund = real;
    // Only a reconciler asking the rail by the original key may finish it (saga law): the retry is refused in flight, the
    // request stays approved (its hold is never stranded by a void) and nothing is refunded a second time.
    await expect(control.retry(r.id)).rejects.toMatchObject({ code: 'pay.refund_in_flight' });
    expect((await control.get(r.id)).status).toBe('approved');
    expect(await refundedEvents(p.id)).toBe(0);
  });

  it('void refuses a payment whose capture is already on the ledger', async () => {
    const m = await merchant();
    const c = await captured(m.id, '7');
    await sql`UPDATE pay.payments SET status = 'authorized' WHERE id = ${c.id}`;
    await expect(pay.voidPayment(c.id)).rejects.toMatchObject({ code: 'pay.void_not_authorized' });
  });

  it('void: a definite rail refusal is recorded, clears the intent, and the payment can still be captured', async () => {
    const m = await merchant();
    const p = await authorised(m.id, '30');
    const real = card.void.bind(card);
    card.void = async (ref) => ({
      ok: false,
      railRef: ref,
      status: 'failed',
      amount: amt('30'),
      assetId: 'USDC',
      at: new Date(),
      failureCode: 'void.declined',
      failureReason: 'TEST refusal',
    });
    await expect(pay.voidPayment(p.id)).rejects.toMatchObject({ code: 'pay.rail_failed' });
    card.void = real;
    const events = (await sql`SELECT event FROM pay.payment_events WHERE payment_id = ${p.id} AND event LIKE '%void%' ORDER BY seq`).map(
      (r) => r.event,
    );
    expect(events).toEqual(['void.requested', 'rail.void', 'void.refused']);
    expect((await pay.capture(p.id)).status).toBe('captured');
  });

  it('the rule cannot be loosened while a refund waits for approval; every change is kept', async () => {
    const m = await merchant();
    await control.setRule(m.id, 'USDC', amt('5'), OWNER);
    const p = await captured(m.id, '20');
    await control.request({ merchantId: m.id, paymentId: p.id, amount: amt('10'), refundId: `refund:${p.id}:w`, makerUserId: OWNER });
    await expect(control.setRule(m.id, 'USDC', null, OWNER)).rejects.toMatchObject({ code: 'pay.refund_rule_change_blocked' });
    await expect(control.setRule(m.id, 'USDC', amt('50'), OWNER)).rejects.toMatchObject({ code: 'pay.refund_rule_change_blocked' });
    // Tightening is always allowed.
    expect(await control.setRule(m.id, 'USDC', amt('2'), OWNER)).toMatchObject({ threshold: '2' });
    const changes =
      await sql`SELECT old_threshold::text AS o, new_threshold::text AS n FROM pay.refund_approval_rule_changes WHERE merchant_id = ${m.id} ORDER BY seq`;
    // Compared as exact decimals (scaled bigint), never as floats.
    expect(changes.map((c) => [c.o === null ? null : amt(c.o), amt(c.n)])).toEqual([
      [null, amt('5')],
      [amt('5'), amt('2')],
    ]);
  });
});
