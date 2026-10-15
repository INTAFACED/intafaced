import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { formatAmount, MemoryLedger, parseAmount as amt } from '@intafaced/ledger-client';
import { PayService } from '../payment-service.js';
import { truncatePayForTest } from '../payment-events-test-reset.js';
import { UserMoneyService } from '../user-money-service.js';
import { memoryPayoutDestinations } from '../merchant-payout-destination.js';
import { RailRegistry } from '../rails/registry.js';
import { CardSandboxAdapter } from '../rails/card-sandbox.js';
import { CryptoNativeAdapter } from '../rails/crypto-native.js';
import { BankPayoutAbsentAdapter } from '../rails/bank-payout.js';
import { MemoryChain } from '../rails/chain-port.js';
import { REFERENCE_RAIL_ROUTING_PROFILES } from '../routing/decide.js';
import { composeGuards, FRESH } from '../seams/guards.js';
import { buildPayGuards } from '../seams/registry.js';
import { createW1ControlGuards } from '../seams/slots/w1-control.js';
import { ChangeService } from './changes.js';
import { createControlGuards } from './guards.js';
import {
  applyChange,
  DEST_A,
  DEST_B,
  DEST_C,
  migrations,
  openAdmin,
  resetControl,
  SECRET,
  TEST_GLOBAL_RULE,
  TEST_TIER,
} from './control.testkit.js';

/**
 * W1 guards against the real money paths and a real Postgres. All numbers are
 * TEST VALUES from control.testkit.ts.
 */
describe('W1 control guards', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db!: TestDatabase;
  let sql!: TestDatabase['sql'];
  let ledger: MemoryLedger;
  let chain: MemoryChain;
  let rails: RailRegistry;
  let changes!: ChangeService;

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    sql = db.sql;
    changes = new ChangeService(sql);
  }, 120_000);

  beforeEach(async () => {
    await resetControl(sql);
    ledger = new MemoryLedger();
    chain = new MemoryChain();
    rails = new RailRegistry([
      new CardSandboxAdapter({ secret: SECRET, toleranceSeconds: 300 }),
      new CryptoNativeAdapter({ chain, secret: SECRET, minConfirmations: 6, toleranceSeconds: 300 }),
      new BankPayoutAbsentAdapter(),
    ]);
  }, 30_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  const required = () => composeGuards(createControlGuards({ sql, mode: 'required' }));
  const service = (guards = required()) =>
    new PayService(sql, ledger, rails, {
      payoutDestinations: memoryPayoutDestinations(),
      guards,
      checkoutRiskBand: 'low',
      routingProfiles: REFERENCE_RAIL_ROUTING_PROFILES.map((p) =>
        p.railId === 'crypto-native' ? { ...p, successRate: '0.90' } : { ...p },
      ),
      linkDefaultTtlDays: 30,
      linkMaxTtlDays: 365,
      checkoutSessionTtlSeconds: 900,
      maxOpenSessionsPerLink: 25,
    });

  async function merchant(userId: string, pay = service()) {
    return pay.createMerchant({ userId, pricing: { feeBps: 0 } });
  }

  async function configure(merchantId: string, opts: { pricing?: boolean; tier?: typeof TEST_TIER } = {}) {
    const tier = opts.tier ?? TEST_TIER;
    await applyChange(changes, sql, { scope: 'tier', change: { kind: 'upsert_tier', tier } });
    await applyChange(changes, sql, { scope: 'merchant', merchantId, change: { kind: 'set_tier', tierId: tier.id, archetypeId: null } });
    if (opts.pricing !== false) {
      await applyChange(changes, sql, {
        scope: 'pricing',
        change: { kind: 'set_pricing_layer', layer: 'global', scopeId: null, rules: [TEST_GLOBAL_RULE] },
      });
    }
  }

  const pay = (p: PayService, merchantId: string, amount: string) =>
    p.createPayment({
      requestId: randomUUID(),
      merchantId,
      amount: amt(amount),
      assetId: 'USDT',
      method: 'crypto',
      railAdapter: 'crypto-native',
    });

  /** The payer has sent the money and the payment is authorized: ready to capture. Creates nothing the caps can see. */
  async function fund(p: PayService, paymentId: string, amount: string) {
    const address = await chain.acceptanceAddress(paymentId, 'USDT');
    chain.credit({ address, assetId: 'USDT', amount: amt(amount), from: '0xbuyer', confirmations: 12 });
    await p.authorize(paymentId);
  }

  /** Create, fund and capture one payment: the only way volume reaches the counters. */
  async function captured(p: PayService, merchantId: string, amount: string) {
    const created = await pay(p, merchantId, amount);
    await fund(p, created.id, amount);
    return p.capture(created.id);
  }

  const usage = async (merchantId: string, kind: string) => {
    const rows = await sql<
      Array<{ used: string }>
    >`SELECT used FROM pay.control_cap_usage WHERE merchant_id = ${merchantId} AND cap_kind = ${kind}`;
    return rows[0] ? formatAmount(amt(rows[0].used)) : '0';
  };

  describe('mode', () => {
    it('off (the default) is a no-op: nothing configured, payments and settlements behave as before, nothing is counted', async () => {
      expect(createControlGuards({ sql, mode: 'off' })).toEqual({});
      expect(createW1ControlGuards({ sql, merchantControls: 'off' })).toEqual({});
      expect(Object.keys(createW1ControlGuards({ sql, merchantControls: 'required' })).sort()).toEqual([
        'beforePaymentAdmit',
        'beforePayoutAdmit',
        'beforeSettlementRun',
        'beforeUserMoneyWithdrawal',
      ]);
      const p = service(buildPayGuards({ sql }));
      const m = await merchant('99999999-9999-4999-8999-999999999999', p);
      const created = await pay(p, m.id, '1000000');
      expect(created.status).toBe('created');
      expect((await sql`SELECT 1 FROM pay.control_cap_usage`).length).toBe(0);
      expect((await sql`SELECT 1 FROM pay.control_pricing_snapshots`).length).toBe(0);
    });

    it('required refuses an unconfigured merchant on every money path', async () => {
      const p = service();
      const m = await merchant('99999999-9999-4999-8999-999999999999', p);
      await expect(pay(p, m.id, '10')).rejects.toMatchObject({ code: 'pay.tier_unassigned' });
    });
  });

  describe('unconfigured refuses with typed errors (no defaults)', () => {
    it('no tier -> pay.tier_unassigned; tier without caps for the asset -> pay.caps_unconfigured; no pricing -> pay.pricing_unconfigured', async () => {
      const p = service();
      const m = await merchant('99999999-9999-4999-8999-999999999999', p);
      await expect(pay(p, m.id, '10')).rejects.toMatchObject({ code: 'pay.tier_unassigned' });

      const usdOnly = {
        ...TEST_TIER,
        id: 'usd-only',
        caps: TEST_TIER.caps.map((c) => (c.kind === 'beneficiaries_per_day' ? c : { ...c, assetCode: 'USD' })),
        approvalThresholds: [{ assetCode: 'USD', amount: '50' }],
        founderThresholds: [{ assetCode: 'USD', amount: '150' }],
      };
      await configure(m.id, { tier: usdOnly, pricing: false });
      await expect(pay(p, m.id, '10')).rejects.toMatchObject({ code: 'pay.caps_unconfigured' });

      await configure(m.id, { pricing: false });
      await expect(pay(p, m.id, '10')).rejects.toMatchObject({ code: 'pay.pricing_unconfigured' });
      expect((await sql`SELECT 1 FROM pay.payments`).length).toBe(0);
      expect((await sql`SELECT 1 FROM pay.control_cap_usage`).length).toBe(0);

      await configure(m.id);
      expect((await pay(p, m.id, '10')).status).toBe('created');
    });

    it('a settlement window is refused before it freezes when pricing is missing', async () => {
      const p = service(composeGuards({}));
      const m = await merchant('99999999-9999-4999-8999-999999999999', p);
      const created = await pay(p, m.id, '10');
      const address = await chain.acceptanceAddress(created.id, 'USDT');
      chain.credit({ address, assetId: 'USDT', amount: amt('10'), from: '0xbuyer', confirmations: 12 });
      await p.authorize(created.id);
      await p.capture(created.id);
      const strict = service();
      const settle = () =>
        strict.settleWindow({
          merchantId: m.id,
          window: 'w1',
          assetId: 'USDT',
          from: new Date(Date.now() - 86_400_000),
          to: new Date(Date.now() + 86_400_000),
        });
      await expect(settle()).rejects.toMatchObject({ code: 'pay.tier_unassigned' });
      await configure(m.id, { pricing: false });
      await expect(settle()).rejects.toMatchObject({ code: 'pay.pricing_unconfigured' });
      expect((await sql`SELECT 1 FROM pay.settlements`).length).toBe(0);
    });
  });

  describe('intake caps count CAPTURED volume, never created payments', () => {
    it("a stranger's created-but-uncaptured payments consume no cap and no pricing band", async () => {
      const p = service();
      const m = await merchant('99999999-9999-4999-8999-999999999999', p);
      await configure(m.id);
      // Public checkout lets anyone create payments. Twenty at the per-payment maximum would have filled the
      // 300 daily cap six times over if creation were counted.
      for (let i = 0; i < 20; i += 1) expect((await pay(p, m.id, '100')).status).toBe('created');
      expect((await sql`SELECT 1 FROM pay.control_cap_usage`).length).toBe(0);
      expect((await sql`SELECT 1 FROM pay.control_cap_events`).length).toBe(0);
      expect((await sql`SELECT 1 FROM pay.control_pricing_snapshots`).length).toBe(0);
      // The merchant's real customer still gets through, and the band still starts at zero volume.
      const real = await captured(p, m.id, '100');
      expect(real.status).toBe('captured');
      expect(await usage(m.id, 'daily_intake')).toBe('100');
      const snap = (await sql`SELECT monthly_volume_before FROM pay.control_pricing_snapshots WHERE subject_id = ${real.id}`)[0]!;
      expect(formatAmount(amt(String(snap.monthly_volume_before)))).toBe('0');
    });

    it('public checkout is the same: opening sessions counts nothing', async () => {
      const p = service();
      const m = await merchant('99999999-9999-4999-8999-999999999999', p);
      await configure(m.id);
      const link = await p.createPaymentLink({ merchantId: m.id, label: 'Stranger link', amount: amt('100'), currency: 'USDT' });
      for (let i = 0; i < 5; i += 1) {
        await p.openCheckoutSession({ linkToken: link.token, geoCountry: 'ID', method: 'crypto' });
      }
      expect((await sql`SELECT 1 FROM pay.payments`).length).toBe(5);
      expect((await sql`SELECT 1 FROM pay.checkout_sessions`).length).toBe(5);
      expect((await sql`SELECT 1 FROM pay.control_cap_usage`).length).toBe(0);
    });

    it('create still enforces the single-payment bound and refuses early when the day or month has no room, without counting', async () => {
      const p = service();
      const m = await merchant('99999999-9999-4999-8999-999999999999', p);
      await configure(m.id, {
        tier: { ...TEST_TIER, caps: TEST_TIER.caps.map((c) => (c.kind === 'monthly_intake' ? { ...c, limit: '150' } : c)) },
      });
      await expect(pay(p, m.id, '100.000000000000000001')).rejects.toMatchObject({ code: 'pay.cap_per_payment_exceeded' });
      await captured(p, m.id, '100');
      await expect(pay(p, m.id, '50.000000000000000001')).rejects.toMatchObject({ code: 'pay.cap_monthly_intake_exceeded' });
      expect((await captured(p, m.id, '50')).status).toBe('captured');
      expect(await usage(m.id, 'monthly_intake')).toBe('150');
      // The day (300) has room; the month (150) is full.
      await expect(pay(p, m.id, '1')).rejects.toMatchObject({ code: 'pay.cap_monthly_intake_exceeded' });
    });

    it('8 parallel captures of 33.333333333333333333 against a daily cap of 100: exactly 3 commit, the 4th unit never fits', async () => {
      const p = service();
      const m = await merchant('99999999-9999-4999-8999-999999999999', p);
      await configure(m.id, {
        tier: { ...TEST_TIER, caps: TEST_TIER.caps.map((c) => (c.kind === 'daily_intake' ? { ...c, limit: '100' } : c)) },
      });
      const ids: string[] = [];
      for (let i = 0; i < 8; i += 1) {
        const created = await pay(p, m.id, '33.333333333333333333');
        await fund(p, created.id, '33.333333333333333333');
        ids.push(created.id);
      }
      expect(await usage(m.id, 'daily_intake')).toBe('0');
      const results = await Promise.allSettled(ids.map((id) => p.capture(id)));
      const ok = results.filter((r) => r.status === 'fulfilled');
      const refused = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(ok).toHaveLength(3);
      expect(refused).toHaveLength(5);
      for (const r of refused) expect(r.reason).toMatchObject({ code: 'pay.cap_daily_intake_exceeded' });
      expect(await usage(m.id, 'daily_intake')).toBe('99.999999999999999999');
      // A refused capture moved nothing: those payments are still authorized, not captured.
      expect((await sql`SELECT 1 FROM pay.payments WHERE status = 'captured'`).length).toBe(3);
      expect((await sql`SELECT 1 FROM pay.payments WHERE status = 'authorized'`).length).toBe(5);
      // One minor unit of headroom is left: it fits. One more does not.
      expect((await captured(p, m.id, '0.000000000000000001')).status).toBe('captured');
      expect(await usage(m.id, 'daily_intake')).toBe('100');
      await expect(pay(p, m.id, '0.000000000000000001')).rejects.toMatchObject({ code: 'pay.cap_daily_intake_exceeded' });
      expect(await usage(m.id, 'daily_intake')).toBe('100');
    }, 60_000);

    it('a per-merchant override replaces the tier cap of the same kind and asset', async () => {
      const p = service();
      const m = await merchant('99999999-9999-4999-8999-999999999999', p);
      await configure(m.id);
      await applyChange(changes, sql, {
        scope: 'merchant',
        merchantId: m.id,
        change: { kind: 'set_caps', caps: [{ kind: 'per_payment', assetCode: 'USDT', limit: '20' }] },
      });
      await expect(pay(p, m.id, '21')).rejects.toMatchObject({ code: 'pay.cap_per_payment_exceeded' });
      expect((await captured(p, m.id, '20')).status).toBe('captured');
    });

    it('a capture is refused before the rail is asked, so a refused capture leaves the payment authorized and uncounted', async () => {
      const p = service();
      const m = await merchant('99999999-9999-4999-8999-999999999999', p);
      await configure(m.id, {
        tier: { ...TEST_TIER, caps: TEST_TIER.caps.map((c) => (c.kind === 'daily_intake' ? { ...c, limit: '100' } : c)) },
      });
      const a = await pay(p, m.id, '60');
      const b = await pay(p, m.id, '60');
      await fund(p, a.id, '60');
      await fund(p, b.id, '60');
      await p.capture(a.id);
      await expect(p.capture(b.id)).rejects.toMatchObject({ code: 'pay.cap_daily_intake_exceeded' });
      expect((await p.getPayment(b.id)).status).toBe('authorized');
      expect(await usage(m.id, 'daily_intake')).toBe('60');
      // Room appears (the day rolls over, here: the owner raises the cap) and the same capture then lands.
      await applyChange(changes, sql, {
        scope: 'merchant',
        merchantId: m.id,
        change: { kind: 'set_caps', caps: [{ kind: 'daily_intake', assetCode: 'USDT', limit: '200' }] },
      });
      expect((await p.capture(b.id)).status).toBe('captured');
      expect(await usage(m.id, 'daily_intake')).toBe('120');
    });
  });

  describe('replay and recovery are never refused', () => {
    it('a repeat of a captured payment succeeds after the cap is exhausted and does not count again', async () => {
      const p = service();
      const m = await merchant('99999999-9999-4999-8999-999999999999', p);
      await configure(m.id, {
        tier: { ...TEST_TIER, caps: TEST_TIER.caps.map((c) => (c.kind === 'daily_intake' ? { ...c, limit: '100' } : c)) },
      });
      const first = await captured(p, m.id, '60');
      await expect(pay(p, m.id, '60')).rejects.toMatchObject({ code: 'pay.cap_daily_intake_exceeded' });
      const again = await p.capture(first.id);
      expect(again.id).toBe(first.id);
      expect(again.status).toBe('captured');
      expect(await usage(m.id, 'daily_intake')).toBe('60');
      // A repeat of the same create (same request id) is a replay: neither refused nor counted.
      const requestId = randomUUID();
      const input = {
        requestId,
        merchantId: m.id,
        amount: amt('30'),
        assetId: 'USDT',
        method: 'crypto' as const,
        railAdapter: 'crypto-native',
      };
      const created = await p.createPayment(input);
      await captured(p, m.id, '10');
      expect((await p.createPayment(input)).id).toBe(created.id);
      expect(await usage(m.id, 'daily_intake')).toBe('70');
    });

    it('the guard counts only a fresh CAPTURE, once per payment even when two racing calls both read fresh', async () => {
      const m = await merchant('99999999-9999-4999-8999-999999999999');
      await configure(m.id);
      const guards = required();
      const paymentId = randomUUID();
      const ctx = (
        kind: 'payment.create' | 'payment.authorize' | 'payment.capture',
        replay: Parameters<typeof guards.beforePaymentAdmit>[0]['replay'],
        tx: typeof sql,
      ) => ({ tx, kind, paymentId, merchantId: m.id, payload: { assetId: 'USDT', amount: '40' }, replay });
      // Create and authorize never count, fresh or not.
      await sql.begin(async (tx) => {
        await guards.beforePaymentAdmit(ctx('payment.create', FRESH, tx as never));
        await guards.beforePaymentAdmit(ctx('payment.authorize', FRESH, tx as never));
        await guards.beforePaymentAdmit(ctx('payment.capture', { kind: 'replay', reason: 'already_captured' }, tx as never));
      });
      expect(await usage(m.id, 'daily_intake')).toBe('0');
      await Promise.all([
        sql.begin((tx) => guards.beforePaymentAdmit(ctx('payment.capture', FRESH, tx as never))),
        sql.begin((tx) => guards.beforePaymentAdmit(ctx('payment.capture', FRESH, tx as never))),
      ]);
      expect(await usage(m.id, 'daily_intake')).toBe('40');
      expect(await usage(m.id, 'monthly_intake')).toBe('40');
      expect((await sql`SELECT 1 FROM pay.control_pricing_snapshots WHERE subject_id = ${paymentId}`).length).toBe(1);
      // A later recovery of the same payment finds it counted already.
      await sql.begin((tx) =>
        guards.beforePaymentAdmit(ctx('payment.capture', { kind: 'recovery', reason: 'ledger_already_booked' }, tx as never)),
      );
      expect(await usage(m.id, 'daily_intake')).toBe('40');
    });

    it('a recovered capture is never refused, and is counted once when its first count rolled back with the capture', async () => {
      const m = await merchant('99999999-9999-4999-8999-999999999999');
      await configure(m.id, {
        tier: { ...TEST_TIER, caps: TEST_TIER.caps.map((c) => (c.kind === 'daily_intake' ? { ...c, limit: '30' } : c)) },
      });
      const guards = required();
      const paymentId = randomUUID();
      const recover = () =>
        sql.begin((tx) =>
          guards.beforePaymentAdmit({
            tx: tx as never,
            kind: 'payment.capture',
            paymentId,
            merchantId: m.id,
            payload: { assetId: 'USDT', amount: '40' },
            replay: { kind: 'recovery', reason: 'ledger_already_booked' },
          }),
        );
      // 40 is over the 30 cap, but the money is already on the ledger: counted, not refused.
      await recover();
      expect(await usage(m.id, 'daily_intake')).toBe('40');
      await recover();
      expect(await usage(m.id, 'daily_intake')).toBe('40');
      // And a fresh capture now finds no room.
      await expect(
        sql.begin((tx) =>
          guards.beforePaymentAdmit({
            tx: tx as never,
            kind: 'payment.capture',
            paymentId: randomUUID(),
            merchantId: m.id,
            payload: { assetId: 'USDT', amount: '1' },
            replay: FRESH,
          }),
        ),
      ).rejects.toMatchObject({ code: 'pay.cap_daily_intake_exceeded' });
    });
  });

  describe('payout caps and beneficiaries', () => {
    const payoutCtx = (tx: unknown, merchantId: string, over: Record<string, unknown> = {}) => ({
      tx: tx as never,
      settlementId: randomUUID(),
      merchantId,
      assetId: 'USDT',
      amount: amt('10'),
      railId: 'crypto-native',
      destination: DEST_A,
      attempt: 0,
      replay: FRESH,
      ...over,
    });

    it('daily payout cap is exact to the minor unit and counts a settlement attempt once', async () => {
      const m = await merchant('99999999-9999-4999-8999-999999999999');
      await configure(m.id, {
        tier: { ...TEST_TIER, caps: TEST_TIER.caps.map((c) => (c.kind === 'daily_payout' ? { ...c, limit: '30' } : c)) },
      });
      const g = required();
      const same = randomUUID();
      await sql.begin((tx) => g.beforePayoutAdmit(payoutCtx(tx, m.id, { settlementId: same, amount: amt('20') })));
      await sql.begin((tx) => g.beforePayoutAdmit(payoutCtx(tx, m.id, { settlementId: same, amount: amt('20') })));
      expect(await usage(m.id, 'daily_payout')).toBe('20');
      await expect(
        sql.begin((tx) => g.beforePayoutAdmit(payoutCtx(tx, m.id, { amount: amt('10.000000000000000001') }))),
      ).rejects.toMatchObject({
        code: 'pay.cap_daily_payout_exceeded',
      });
      await sql.begin((tx) => g.beforePayoutAdmit(payoutCtx(tx, m.id, { amount: amt('10') })));
      expect(await usage(m.id, 'daily_payout')).toBe('30');
      // A recovery is never refused and never counted.
      await sql.begin((tx) =>
        g.beforePayoutAdmit(payoutCtx(tx, m.id, { amount: amt('10'), replay: { kind: 'recovery', reason: 'payout_hold_booked' } })),
      );
      expect(await usage(m.id, 'daily_payout')).toBe('30');
    });

    it('daily payout is counted once per settlement: retries after a failed attempt do not count again, and are not refused by their own earlier count', async () => {
      const m = await merchant('99999999-9999-4999-8999-999999999999');
      await configure(m.id, {
        tier: { ...TEST_TIER, caps: TEST_TIER.caps.map((c) => (c.kind === 'daily_payout' ? { ...c, limit: '30' } : c)) },
      });
      const g = required();
      const settlementId = randomUUID();
      for (const attempt of [0, 1, 2, 3]) {
        await sql.begin((tx) => g.beforePayoutAdmit(payoutCtx(tx, m.id, { settlementId, amount: amt('20'), attempt })));
        expect(await usage(m.id, 'daily_payout')).toBe('20');
      }
      // Another settlement still sees only the 20 counted once: 10 fits, 10.000000000000000001 does not.
      await expect(
        sql.begin((tx) => g.beforePayoutAdmit(payoutCtx(tx, m.id, { amount: amt('10.000000000000000001') }))),
      ).rejects.toMatchObject({ code: 'pay.cap_daily_payout_exceeded' });
      await sql.begin((tx) => g.beforePayoutAdmit(payoutCtx(tx, m.id, { amount: amt('10') })));
      expect(await usage(m.id, 'daily_payout')).toBe('30');
      // A racing repeat of the same attempt is a no-op too.
      await Promise.all([
        sql.begin((tx) => g.beforePayoutAdmit(payoutCtx(tx, m.id, { settlementId, amount: amt('20'), attempt: 4 }))),
        sql.begin((tx) => g.beforePayoutAdmit(payoutCtx(tx, m.id, { settlementId, amount: amt('20'), attempt: 4 }))),
      ]);
      expect(await usage(m.id, 'daily_payout')).toBe('30');
    });

    it('a retry to a NEW destination still counts as a new beneficiary (only the money is counted once)', async () => {
      const m = await merchant('99999999-9999-4999-8999-999999999999');
      await configure(m.id);
      const g = required();
      const settlementId = randomUUID();
      await sql.begin((tx) => g.beforePayoutAdmit(payoutCtx(tx, m.id, { settlementId, attempt: 0, destination: DEST_A })));
      await sql.begin((tx) => g.beforePayoutAdmit(payoutCtx(tx, m.id, { settlementId, attempt: 1, destination: DEST_B })));
      expect(await usage(m.id, 'beneficiaries_per_day')).toBe('2');
      expect(await usage(m.id, 'daily_payout')).toBe('10');
      await expect(
        sql.begin((tx) => g.beforePayoutAdmit(payoutCtx(tx, m.id, { settlementId, attempt: 2, destination: DEST_C }))),
      ).rejects.toMatchObject({ code: 'pay.cap_beneficiaries_exceeded' });
    });

    it('beneficiaries per day: a third distinct destination is refused, a known one is not', async () => {
      const m = await merchant('99999999-9999-4999-8999-999999999999');
      await configure(m.id);
      const g = required();
      await sql.begin((tx) => g.beforePayoutAdmit(payoutCtx(tx, m.id, { destination: DEST_A })));
      await sql.begin((tx) => g.beforePayoutAdmit(payoutCtx(tx, m.id, { destination: DEST_B })));
      await expect(sql.begin((tx) => g.beforePayoutAdmit(payoutCtx(tx, m.id, { destination: DEST_C })))).rejects.toMatchObject({
        code: 'pay.cap_beneficiaries_exceeded',
      });
      await sql.begin((tx) =>
        g.beforePayoutAdmit(payoutCtx(tx, m.id, { destination: { ...DEST_A, ref: DEST_A.ref.toUpperCase().replace('0X', '0x') } })),
      );
      expect(await usage(m.id, 'beneficiaries_per_day')).toBe('2');
    });

    it('a missing payout cap or threshold refuses with its typed error', async () => {
      const m = await merchant('99999999-9999-4999-8999-999999999999');
      const g = required();
      await expect(sql.begin((tx) => g.beforePayoutAdmit(payoutCtx(tx, m.id)))).rejects.toMatchObject({ code: 'pay.tier_unassigned' });
      await configure(m.id, {
        tier: {
          ...TEST_TIER,
          approvalThresholds: [{ assetCode: 'USD', amount: '50' }],
          founderThresholds: [{ assetCode: 'USD', amount: '150' }],
        },
      });
      await expect(sql.begin((tx) => g.beforePayoutAdmit(payoutCtx(tx, m.id)))).rejects.toMatchObject({
        code: 'pay.approval_threshold_unconfigured',
      });
    });
  });

  describe('an owner cannot leave through a user-money withdrawal what a payout would be stopped from sending', () => {
    const OWNER = '77777777-7777-4777-8777-777777777777';
    const BANK = { kind: 'bank', ref: 'DE89370400440532013000' };
    const wdTier = (daily: string) => ({
      ...TEST_TIER,
      caps: TEST_TIER.caps.map((c) => (c.kind === 'daily_payout' ? { ...c, limit: daily } : c)),
    });

    beforeEach(async () => {
      await truncatePayForTest(sql, 'pay', 'TRUNCATE pay.withdrawals, pay.deposits RESTART IDENTITY CASCADE');
    });

    function money(guards: ReturnType<typeof required>) {
      return new UserMoneyService(sql, ledger, rails, { operatorCreditRails: ['card-sandbox'], guards });
    }
    async function funded(guards: ReturnType<typeof required>, userId = OWNER) {
      const svc = money(guards);
      await svc.credit({
        userId,
        assetId: 'USDT',
        amount: amt('200'),
        rail: 'card-sandbox',
        railRef: `seed-${userId}`,
        creditedBy: '99999999-9999-4999-8999-999999999999',
      });
      return svc;
    }
    const request = (clientRef: string, amount: string, userId = OWNER, destination = BANK) => ({
      userId,
      assetId: 'USDT',
      amount: amt(amount),
      rail: 'card-sandbox',
      destination,
      clientRef,
    });

    it("required: a withdrawal over the owner merchant's daily payout cap is refused, leaves no claim, and counts nothing", async () => {
      const m = await merchant(OWNER);
      await configure(m.id, { tier: wdTier('30') });
      const svc = await funded(required());
      expect((await svc.withdraw(request('w1', '20'))).status).toBe('sent');
      expect(await usage(m.id, 'daily_payout')).toBe('20');
      await expect(svc.withdraw(request('w2', '10.000000000000000001'))).rejects.toMatchObject({ code: 'pay.cap_daily_payout_exceeded' });
      expect((await sql`SELECT 1 FROM pay.withdrawals WHERE client_ref = 'w2'`).length).toBe(0);
      expect(await usage(m.id, 'daily_payout')).toBe('20');
      expect((await svc.withdraw(request('w3', '10'))).status).toBe('sent');
      expect(await usage(m.id, 'daily_payout')).toBe('30');
      // A repeat of a sent withdrawal is a replay: returned, not refused, not counted again.
      expect((await svc.withdraw(request('w3', '10'))).status).toBe('sent');
      expect(await usage(m.id, 'daily_payout')).toBe('30');
    });

    it('off: the same withdrawal goes through and nothing is counted (no change from before)', async () => {
      const m = await merchant(OWNER);
      await configure(m.id, { tier: wdTier('30') });
      const svc = await funded(composeGuards(createControlGuards({ sql, mode: 'off' })));
      expect((await svc.withdraw(request('w-off', '150'))).status).toBe('sent');
      expect((await sql`SELECT 1 FROM pay.control_cap_usage`).length).toBe(0);
    });

    it('required: the beneficiary cap applies to withdrawals and is shared with payouts', async () => {
      const m = await merchant(OWNER);
      await configure(m.id);
      const svc = await funded(required());
      const g = required();
      // One beneficiary used by a payout today, one by a withdrawal: the third distinct destination is refused.
      await sql.begin((tx) =>
        g.beforePayoutAdmit({
          tx: tx as never,
          settlementId: randomUUID(),
          merchantId: m.id,
          assetId: 'USDT',
          amount: amt('10'),
          railId: 'crypto-native',
          destination: DEST_A,
          attempt: 0,
          replay: FRESH,
        }),
      );
      await svc.withdraw(request('b1', '10', OWNER, { kind: 'bank', ref: 'DE89370400440532013000' }));
      expect(await usage(m.id, 'beneficiaries_per_day')).toBe('2');
      await expect(svc.withdraw(request('b2', '10', OWNER, { kind: 'bank', ref: 'GB29NWBK60161331926819' }))).rejects.toMatchObject({
        code: 'pay.cap_beneficiaries_exceeded',
      });
      // A destination already used today costs nothing.
      expect((await svc.withdraw(request('b3', '10'))).status).toBe('sent');
    });

    it('required: at or above the approval threshold is refused (no approval can exist for a withdrawal); just under goes through', async () => {
      const m = await merchant(OWNER);
      await configure(m.id);
      const svc = await funded(required());
      await expect(svc.withdraw(request('t1', '50'))).rejects.toMatchObject({ code: 'pay.approval_required' });
      expect((await sql`SELECT 1 FROM pay.withdrawals`).length).toBe(0);
      expect((await svc.withdraw(request('t2', '49.999999999999999999'))).status).toBe('sent');
    });

    it('required: a merchant owner with nothing configured is refused (no defaults); a user who owns no merchant is untouched', async () => {
      await merchant(OWNER);
      const svc = await funded(required());
      await expect(svc.withdraw(request('u1', '5'))).rejects.toMatchObject({ code: 'pay.tier_unassigned' });
      const PLAIN = '88888888-8888-4888-8888-888888888888';
      const plain = await funded(required(), PLAIN);
      expect((await plain.withdraw(request('p1', '150', PLAIN))).status).toBe('sent');
      expect((await sql`SELECT 1 FROM pay.control_cap_usage`).length).toBe(0);
    });

    it('required: an owner of two merchants is held to both, so neither cap can be bypassed through the other', async () => {
      const m1 = await merchant(OWNER);
      const m2 = await merchant(OWNER);
      await configure(m1.id, { tier: wdTier('100') });
      await applyChange(changes, sql, {
        scope: 'merchant',
        merchantId: m2.id,
        change: { kind: 'set_caps', caps: [{ kind: 'daily_payout', assetCode: 'USDT', limit: '15' }] },
      });
      await applyChange(changes, sql, {
        scope: 'merchant',
        merchantId: m2.id,
        change: { kind: 'set_tier', tierId: TEST_TIER.id, archetypeId: null },
      });
      const svc = await funded(required());
      await expect(svc.withdraw(request('two', '20'))).rejects.toMatchObject({ code: 'pay.cap_daily_payout_exceeded' });
      expect((await sql`SELECT 1 FROM pay.control_cap_usage`).length).toBe(0);
      expect((await svc.withdraw(request('two-ok', '10'))).status).toBe('sent');
      expect(await usage(m1.id, 'daily_payout')).toBe('10');
      expect(await usage(m2.id, 'daily_payout')).toBe('10');
    });

    it('the guard counts a withdrawal once per client reference, ignores replay and recovery, and refuses nothing it did not count', async () => {
      const m = await merchant(OWNER);
      await configure(m.id, { tier: wdTier('30') });
      const g = required();
      const ctx = (tx: unknown, over: Record<string, unknown> = {}) => ({
        tx: tx as never,
        userId: OWNER,
        assetId: 'USDT',
        amount: amt('20'),
        rail: 'card-sandbox',
        destination: BANK,
        clientRef: 'same',
        replay: FRESH,
        ...over,
      });
      await sql.begin((tx) => g.beforeUserMoneyWithdrawal(ctx(tx)));
      await sql.begin((tx) => g.beforeUserMoneyWithdrawal(ctx(tx)));
      await sql.begin((tx) => g.beforeUserMoneyWithdrawal(ctx(tx, { replay: { kind: 'replay', reason: 'withdrawal_already_sent' } })));
      await sql.begin((tx) =>
        g.beforeUserMoneyWithdrawal(
          ctx(tx, { clientRef: 'other', amount: amt('99'), replay: { kind: 'recovery', reason: 'withdrawal_hold_booked' } }),
        ),
      );
      expect(await usage(m.id, 'daily_payout')).toBe('20');
    });
  });

  describe('pricing snapshots', () => {
    it('stores the rule, band, computed amounts and rounding on each CAPTURED payment, using month-to-date captured volume for the band', async () => {
      const p = service();
      const m = await merchant('99999999-9999-4999-8999-999999999999', p);
      await configure(m.id);
      const [rule] = await sql<Array<{ id: string }>>`SELECT id FROM pay.control_pricing_rules WHERE layer = 'global'`;
      const a1 = await captured(p, m.id, '10');
      const a2 = await captured(p, m.id, '20');
      const snap = async (id: string) =>
        (await sql`SELECT * FROM pay.control_pricing_snapshots WHERE subject_kind = 'payment' AND subject_id = ${id}`)[0]!;
      const s1 = await snap(a1.id);
      // 10 x 250 bps = 0.25, + 0.30 flat = 0.55 (hand-computed)
      expect(s1.rule_id).toBe(rule!.id);
      expect(s1.applied_layer).toBe('global');
      expect(formatAmount(amt(String(s1.fee)))).toBe('0.55');
      expect(formatAmount(amt(String(s1.bps_fee)))).toBe('0.25');
      expect(s1.rounding_beneficiary).toBe('platform');
      expect(s1.rounding_mode).toBe('ceil');
      expect(formatAmount(amt(String(s1.monthly_volume_before)))).toBe('0');
      const s2 = await snap(a2.id);
      expect(formatAmount(amt(String(s2.fee)))).toBe('0.8');
      expect(formatAmount(amt(String(s2.monthly_volume_before)))).toBe('10');
    });

    it('a snapshot is append-only, and a later rule change does not rewrite it', async () => {
      const p = service();
      const m = await merchant('99999999-9999-4999-8999-999999999999', p);
      await configure(m.id);
      const a1 = await captured(p, m.id, '10');
      await applyChange(changes, sql, {
        scope: 'pricing',
        change: {
          kind: 'set_pricing_layer',
          layer: 'global',
          scopeId: null,
          rules: [{ ...TEST_GLOBAL_RULE, bands: [{ fromAmount: '0', feeBps: 100, flatFee: null }] }],
        },
      });
      const a2 = await captured(p, m.id, '10');
      const fee = async (id: string) =>
        formatAmount(amt(String((await sql`SELECT fee FROM pay.control_pricing_snapshots WHERE subject_id = ${id}`)[0]!.fee)));
      expect(await fee(a1.id)).toBe('0.55');
      expect(await fee(a2.id)).toBe('0.1');
      await expect(sql`UPDATE pay.control_pricing_snapshots SET fee = 0`).rejects.toThrow(/append-only/);
      await expect(sql`UPDATE pay.control_pricing_rules SET asset_code = 'X'`).rejects.toThrow(/immutable/);
      expect((await sql`SELECT 1 FROM pay.control_pricing_rules WHERE layer = 'global'`).length).toBe(2);
    });

    it('layering: a tier rule beats global, a merchant rule beats the tier, and the chain is recorded', async () => {
      const p = service();
      const m = await merchant('99999999-9999-4999-8999-999999999999', p);
      await configure(m.id);
      const body = (feeBps: number) => ({ ...TEST_GLOBAL_RULE, bands: [{ fromAmount: '0', feeBps, flatFee: null }], spreadBps: null });
      await applyChange(changes, sql, {
        scope: 'pricing',
        change: { kind: 'set_pricing_layer', layer: 'tier', scopeId: TEST_TIER.id, rules: [body(100)] },
      });
      const t = await captured(p, m.id, '10');
      await applyChange(changes, sql, {
        scope: 'pricing',
        change: { kind: 'set_pricing_layer', layer: 'merchant', scopeId: m.id, rules: [body(50)] },
      });
      const mm = await captured(p, m.id, '10');
      const row = async (id: string) =>
        (await sql`SELECT applied_layer, fee, rule_chain FROM pay.control_pricing_snapshots WHERE subject_id = ${id}`)[0]!;
      const rt = await row(t.id);
      expect(rt.applied_layer).toBe('tier');
      expect(formatAmount(amt(String(rt.fee)))).toBe('0.1');
      expect((rt.rule_chain as Array<{ layer: string }>).map((c) => c.layer)).toEqual(['global', 'tier']);
      const rm = await row(mm.id);
      expect(rm.applied_layer).toBe('merchant');
      expect(formatAmount(amt(String(rm.fee)))).toBe('0.05');
      expect((rm.rule_chain as Array<{ layer: string }>).map((c) => c.layer)).toEqual(['global', 'tier', 'merchant']);
    });

    it('settlement: pricing frozen with the booked fee beside it, reserve computed and left unwired', async () => {
      const p = service();
      const m = await merchant('99999999-9999-4999-8999-999999999999', p);
      await configure(m.id);
      const created = await pay(p, m.id, '10');
      const address = await chain.acceptanceAddress(created.id, 'USDT');
      chain.credit({ address, assetId: 'USDT', amount: amt('10'), from: '0xbuyer', confirmations: 12 });
      await p.authorize(created.id);
      await p.capture(created.id);
      const settlement = await p.settleWindow({
        merchantId: m.id,
        window: 'w-snap',
        assetId: 'USDT',
        from: new Date(Date.now() - 86_400_000),
        to: new Date(Date.now() + 86_400_000),
      });
      const s = (
        await sql`SELECT * FROM pay.control_pricing_snapshots WHERE subject_kind = 'settlement' AND subject_id = ${settlement.id}`
      )[0]!;
      // Engine: 10 x 250 bps + 0.30 = 0.55. The settlement row still carries its own booked fee (feeBps 0 here).
      expect(formatAmount(amt(String(s.fee)))).toBe('0.55');
      expect(formatAmount(amt(String(s.booked_fee)))).toBe('0');
      // Reserve: 1000 bps of net 10 = 1, held 7 days, not booked to any ledger.
      expect(formatAmount(amt(String(s.reserve_amount)))).toBe('1');
      expect(s.reserve_hold_days).toBe(7);
      expect(s.reserve_ledger_status).toBe('unwired');
      const days = (new Date(s.reserve_release_at as string).getTime() - new Date(s.created_at as string).getTime()) / 86_400_000;
      expect(Math.round(days)).toBe(7);
      // Re-running the window is a replay: still one snapshot.
      await p.settleWindow({
        merchantId: m.id,
        window: 'w-snap',
        assetId: 'USDT',
        from: new Date(Date.now() - 86_400_000),
        to: new Date(Date.now() + 86_400_000),
      });
      expect((await sql`SELECT 1 FROM pay.control_pricing_snapshots WHERE subject_kind = 'settlement'`).length).toBe(1);
    });
  });
});
