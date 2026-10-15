import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { formatAmount, MemoryLedger, parseAmount as amt } from '@intafaced/ledger-client';
import { PayService } from '../payment-service.js';
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
      routingProfiles: REFERENCE_RAIL_ROUTING_PROFILES.map((p) => ({ ...p })),
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

  describe('caps are exact under concurrency', () => {
    it('8 parallel payments of 33.333333333333333333 against a daily cap of 100: exactly 3 admitted, the 4th unit never fits', async () => {
      const p = service();
      const m = await merchant('99999999-9999-4999-8999-999999999999', p);
      await configure(m.id, {
        tier: { ...TEST_TIER, caps: TEST_TIER.caps.map((c) => (c.kind === 'daily_intake' ? { ...c, limit: '100' } : c)) },
      });
      const results = await Promise.allSettled(Array.from({ length: 8 }, () => pay(p, m.id, '33.333333333333333333')));
      const ok = results.filter((r) => r.status === 'fulfilled');
      const refused = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(ok).toHaveLength(3);
      expect(refused).toHaveLength(5);
      for (const r of refused) expect(r.reason).toMatchObject({ code: 'pay.cap_daily_intake_exceeded' });
      expect(await usage(m.id, 'daily_intake')).toBe('99.999999999999999999');
      // One minor unit of headroom is left: it fits. One more does not.
      expect((await pay(p, m.id, '0.000000000000000001')).status).toBe('created');
      expect(await usage(m.id, 'daily_intake')).toBe('100');
      await expect(pay(p, m.id, '0.000000000000000001')).rejects.toMatchObject({ code: 'pay.cap_daily_intake_exceeded' });
      expect(await usage(m.id, 'daily_intake')).toBe('100');
    }, 60_000);

    it('per-payment cap refuses a payment one minor unit over; the monthly cap is enforced too', async () => {
      const p = service();
      const m = await merchant('99999999-9999-4999-8999-999999999999', p);
      await configure(m.id, {
        tier: { ...TEST_TIER, caps: TEST_TIER.caps.map((c) => (c.kind === 'monthly_intake' ? { ...c, limit: '150' } : c)) },
      });
      await expect(pay(p, m.id, '100.000000000000000001')).rejects.toMatchObject({ code: 'pay.cap_per_payment_exceeded' });
      expect((await pay(p, m.id, '100')).status).toBe('created');
      await expect(pay(p, m.id, '50.000000000000000001')).rejects.toMatchObject({ code: 'pay.cap_monthly_intake_exceeded' });
      expect((await pay(p, m.id, '50')).status).toBe('created');
    });

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
      expect((await pay(p, m.id, '20')).status).toBe('created');
    });
  });

  describe('replay and recovery are never refused or counted', () => {
    it('a repeat of a counted payment succeeds after the cap is exhausted and does not count again', async () => {
      const p = service();
      const m = await merchant('99999999-9999-4999-8999-999999999999', p);
      await configure(m.id, {
        tier: { ...TEST_TIER, caps: TEST_TIER.caps.map((c) => (c.kind === 'daily_intake' ? { ...c, limit: '100' } : c)) },
      });
      const requestId = randomUUID();
      const input = {
        requestId,
        merchantId: m.id,
        amount: amt('60'),
        assetId: 'USDT',
        method: 'crypto' as const,
        railAdapter: 'crypto-native',
      };
      const first = await p.createPayment(input);
      await expect(pay(p, m.id, '60')).rejects.toMatchObject({ code: 'pay.cap_daily_intake_exceeded' });
      const again = await p.createPayment(input);
      expect(again.id).toBe(first.id);
      expect(await usage(m.id, 'daily_intake')).toBe('60');
    });

    it('the guard itself ignores replay and recovery, and counts one business key once when two racing calls both read fresh', async () => {
      const m = await merchant('99999999-9999-4999-8999-999999999999');
      await configure(m.id);
      const guards = required();
      const paymentId = randomUUID();
      const ctx = (replay: Parameters<typeof guards.beforePaymentAdmit>[0]['replay'], tx: typeof sql) => ({
        tx,
        kind: 'payment.create' as const,
        paymentId,
        merchantId: m.id,
        payload: { assetId: 'USDT', amount: '40' },
        replay,
      });
      await sql.begin(async (tx) => {
        await guards.beforePaymentAdmit(ctx({ kind: 'replay', reason: 'payment_exists' }, tx as never));
        await guards.beforePaymentAdmit(ctx({ kind: 'recovery', reason: 'ledger_already_booked' }, tx as never));
      });
      expect(await usage(m.id, 'daily_intake')).toBe('0');
      await Promise.all([
        sql.begin((tx) => guards.beforePaymentAdmit(ctx(FRESH, tx as never))),
        sql.begin((tx) => guards.beforePaymentAdmit(ctx(FRESH, tx as never))),
      ]);
      expect(await usage(m.id, 'daily_intake')).toBe('40');
      expect(await usage(m.id, 'monthly_intake')).toBe('40');
      expect((await sql`SELECT 1 FROM pay.control_pricing_snapshots WHERE subject_id = ${paymentId}`).length).toBe(1);
    });

    it('authorize and capture are not intake: they neither count nor refuse', async () => {
      const m = await merchant('99999999-9999-4999-8999-999999999999');
      const guards = required();
      for (const kind of ['payment.authorize', 'payment.capture'] as const) {
        await sql.begin((tx) =>
          guards.beforePaymentAdmit({
            tx: tx as never,
            kind,
            paymentId: randomUUID(),
            merchantId: m.id,
            payload: { assetId: 'USDT', amount: '1' },
            replay: FRESH,
          }),
        );
      }
      expect((await sql`SELECT 1 FROM pay.control_cap_usage`).length).toBe(0);
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

  describe('pricing snapshots', () => {
    it('stores the rule, band, computed amounts and rounding on each payment, using month-to-date volume for the band', async () => {
      const p = service();
      const m = await merchant('99999999-9999-4999-8999-999999999999', p);
      await configure(m.id);
      const [rule] = await sql<Array<{ id: string }>>`SELECT id FROM pay.control_pricing_rules WHERE layer = 'global'`;
      const a1 = await pay(p, m.id, '10');
      const a2 = await pay(p, m.id, '20');
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
      const a1 = await pay(p, m.id, '10');
      await applyChange(changes, sql, {
        scope: 'pricing',
        change: {
          kind: 'set_pricing_layer',
          layer: 'global',
          scopeId: null,
          rules: [{ ...TEST_GLOBAL_RULE, bands: [{ fromAmount: '0', feeBps: 100, flatFee: null }] }],
        },
      });
      const a2 = await pay(p, m.id, '10');
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
      const t = await pay(p, m.id, '10');
      await applyChange(changes, sql, {
        scope: 'pricing',
        change: { kind: 'set_pricing_layer', layer: 'merchant', scopeId: m.id, rules: [body(50)] },
      });
      const mm = await pay(p, m.id, '10');
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
