import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { formatAmount, MemoryLedger, merchantClearing, parseAmount as amt, userAvailable } from '@intafaced/ledger-client';
import { PayService } from '../payment-service.js';
import { signPayload } from '../rails/webhook-signature.js';
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

  const required = () => composeGuards(createControlGuards({ sql, mode: 'required', ledger }));
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
        'afterPaymentCaptureBooked',
        'beforePaymentAdmit',
        'beforePayoutAdmit',
        'beforeSettlementRun',
        'beforeUserMoneyWithdrawal',
      ]);
      const p = service(buildPayGuards({ sql, merchantControls: 'off' }));
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

    it('create refuses to the minor unit once captured volume has used the headroom; the cap is enforced there and only there', async () => {
      const p = service();
      const m = await merchant('99999999-9999-4999-8999-999999999999', p);
      await configure(m.id, {
        tier: { ...TEST_TIER, caps: TEST_TIER.caps.map((c) => (c.kind === 'daily_intake' ? { ...c, limit: '100' } : c)) },
      });
      for (let i = 0; i < 3; i += 1) await captured(p, m.id, '33.333333333333333333');
      expect(await usage(m.id, 'daily_intake')).toBe('99.999999999999999999');
      // One minor unit of headroom is left: it fits. One more does not.
      expect((await captured(p, m.id, '0.000000000000000001')).status).toBe('captured');
      expect(await usage(m.id, 'daily_intake')).toBe('100');
      await expect(pay(p, m.id, '0.000000000000000001')).rejects.toMatchObject({ code: 'pay.cap_daily_intake_exceeded' });
      expect(await usage(m.id, 'daily_intake')).toBe('100');
      expect((await sql`SELECT 1 FROM pay.control_audit WHERE kind = 'payment.captured_over_cap'`).length).toBe(0);
    }, 60_000);

    it('8 payments created inside the headroom and captured in parallel all land: none refused or stranded, all counted, the 5 over the cap flagged', async () => {
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
      expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
      expect((await sql`SELECT 1 FROM pay.payments WHERE status = 'captured'`).length).toBe(8);
      expect((await sql`SELECT 1 FROM pay.payments WHERE status = 'authorized'`).length).toBe(0);
      expect(await usage(m.id, 'daily_intake')).toBe('266.666666666666666664');
      expect(await usage(m.id, 'monthly_intake')).toBe('266.666666666666666664');
      const flags = await sql<
        Array<{ after: { exceeded: string[] } }>
      >`SELECT after FROM pay.control_audit WHERE kind = 'payment.captured_over_cap'`;
      expect(flags).toHaveLength(5);
      for (const f of flags) expect(f.after.exceeded).toContain('daily_intake');
    }, 60_000);

    it('a rail `captured` webhook past the monthly cap is captured, counted once and flagged, never left authorized', async () => {
      const p = service();
      const m = await merchant('99999999-9999-4999-8999-999999999999', p);
      await configure(m.id, {
        tier: { ...TEST_TIER, caps: TEST_TIER.caps.map((c) => (c.kind === 'monthly_intake' ? { ...c, limit: '150' } : c)) },
      });
      const cardAuthorized = async () => {
        const created = await p.createPayment({
          requestId: randomUUID(),
          merchantId: m.id,
          amount: amt('100'),
          assetId: 'USDT',
          method: 'card',
          railAdapter: 'card-sandbox',
          instrument: { kind: 'card', token: 'tok_ok' },
        });
        return p.authorize(created.id);
      };
      const first = await cardAuthorized();
      const second = await cardAuthorized();
      await p.capture(first.id);
      expect(await usage(m.id, 'monthly_intake')).toBe('100');
      const webhook = (id: string) => {
        const body = JSON.stringify({ id, type: 'captured', ref: second.railRef, amount: '100', assetId: 'USDT' });
        const timestamp = Math.floor(Date.now() / 1000).toString();
        return {
          headers: { 'x-sandbox-signature': signPayload(SECRET, timestamp, body), 'x-sandbox-timestamp': timestamp },
          body,
        };
      };
      const outcome = await p.handleWebhook('card-sandbox', webhook('evt_capture_over_cap'));
      expect(outcome.applied).toBe(true);
      expect((await p.getPayment(second.id)).status).toBe('captured');
      expect(await usage(m.id, 'monthly_intake')).toBe('200');
      const flags = await sql<Array<{ after: { paymentId: string; exceeded: string[] } }>>`
        SELECT after FROM pay.control_audit WHERE kind = 'payment.captured_over_cap'`;
      expect(flags).toHaveLength(1);
      expect(flags[0]!.after).toMatchObject({ paymentId: second.id, exceeded: ['monthly_intake'] });
      // A redelivery with a new event id finds it captured: nothing changes.
      expect((await p.handleWebhook('card-sandbox', webhook('evt_capture_over_cap_2'))).applied).toBe(false);
      expect(await usage(m.id, 'monthly_intake')).toBe('200');
      expect((await sql`SELECT 1 FROM pay.control_audit WHERE kind = 'payment.captured_over_cap'`).length).toBe(1);
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
      expect((await captured(p, m.id, '20')).status).toBe('captured');
    });
  });

  describe('the capture counters are held only after the rail and ledger calls', () => {
    /** Backends that currently hold any lock on the cap counter table. */
    const counterLockHolders = async () =>
      (
        await sql<Array<{ pid: number }>>`
          SELECT DISTINCT l.pid FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
           WHERE c.relname = 'control_cap_usage' AND l.granted AND l.pid <> pg_backend_pid()`
      ).length;

    it("a slow rail capture holds no counter lock and does not block the merchant's other captures", async () => {
      const p = service();
      const m = await merchant('99999999-9999-4999-8999-999999999999', p);
      await configure(m.id);
      const card = () =>
        p
          .createPayment({
            requestId: randomUUID(),
            merchantId: m.id,
            amount: amt('10'),
            assetId: 'USDT',
            method: 'card',
            railAdapter: 'card-sandbox',
            instrument: { kind: 'card', token: 'tok_ok' },
          })
          .then((c) => p.authorize(c.id));
      const slow = await card();
      const other = await card();
      const adapter = rails.get('card-sandbox');
      const realCapture = adapter.capture.bind(adapter);
      let entered!: () => void;
      const inRail = new Promise<void>((resolve) => (entered = resolve));
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      adapter.capture = async (ref: string) => {
        if (ref === slow.railRef) {
          entered();
          await gate;
        }
        return realCapture(ref);
      };
      try {
        const slowCapture = p.capture(slow.id);
        await inRail;
        // The slow capture is inside the rail call, holding its transaction open.
        expect(await counterLockHolders()).toBe(0);
        // Another capture for the SAME merchant and asset completes meanwhile.
        expect((await p.capture(other.id)).status).toBe('captured');
        expect(await usage(m.id, 'daily_intake')).toBe('10');
        release();
        expect((await slowCapture).status).toBe('captured');
        expect(await usage(m.id, 'daily_intake')).toBe('20');
      } finally {
        release();
        adapter.capture = realCapture;
      }
    }, 30_000);

    it('a counter lock that cannot be had in 2s refuses as unavailable (retry later), leaves the payment authorized, and the retry counts once', async () => {
      const p = service();
      const m = await merchant('99999999-9999-4999-8999-999999999999', p);
      await configure(m.id);
      await captured(p, m.id, '10');
      const created = await pay(p, m.id, '10');
      await fund(p, created.id, '10');
      let holding!: () => void;
      const held = new Promise<void>((resolve) => (holding = resolve));
      let letGo!: () => void;
      const hold = new Promise<void>((resolve) => (letGo = resolve));
      const blocker = sql.begin(async (tx) => {
        await tx`SELECT 1 FROM pay.control_cap_usage WHERE merchant_id = ${m.id} FOR UPDATE`;
        holding();
        await hold;
      });
      await held;
      const started = Date.now();
      await expect(p.capture(created.id)).rejects.toMatchObject({ code: 'pay.guard_unavailable' });
      expect(Date.now() - started).toBeLessThan(10_000);
      expect((await p.getPayment(created.id)).status).toBe('authorized');
      letGo();
      await blocker;
      expect((await p.capture(created.id)).status).toBe('captured');
      expect(await usage(m.id, 'daily_intake')).toBe('20');
    }, 30_000);
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

    it('create and authorize never count; the capture hook counts once per payment even when two racing calls both run', async () => {
      const m = await merchant('99999999-9999-4999-8999-999999999999');
      await configure(m.id);
      const guards = required();
      const paymentId = randomUUID();
      const admit = (kind: 'payment.create' | 'payment.authorize', tx: typeof sql) =>
        guards.beforePaymentAdmit({ tx, kind, paymentId, merchantId: m.id, payload: { assetId: 'USDT', amount: '40' }, replay: FRESH });
      const booked = (tx: typeof sql) =>
        guards.afterPaymentCaptureBooked({ tx, paymentId, merchantId: m.id, assetId: 'USDT', amount: amt('40') });
      await sql.begin(async (tx) => {
        await admit('payment.create', tx as never);
        await admit('payment.authorize', tx as never);
        await guards.beforePaymentAdmit({
          tx: tx as never,
          kind: 'payment.capture',
          paymentId,
          merchantId: m.id,
          payload: { assetId: 'USDT', amount: '40' },
          replay: FRESH,
        });
      });
      expect(await usage(m.id, 'daily_intake')).toBe('0');
      await Promise.all([sql.begin((tx) => booked(tx as never)), sql.begin((tx) => booked(tx as never))]);
      expect(await usage(m.id, 'daily_intake')).toBe('40');
      expect(await usage(m.id, 'monthly_intake')).toBe('40');
      expect((await sql`SELECT 1 FROM pay.control_pricing_snapshots WHERE subject_id = ${paymentId}`).length).toBe(1);
      // A later recovery of the same capture finds it counted already.
      await sql.begin((tx) => booked(tx as never));
      expect(await usage(m.id, 'daily_intake')).toBe('40');
    });

    it('a capture over every cap, or with its config gone, is counted and flagged once and never refused', async () => {
      const m = await merchant('99999999-9999-4999-8999-999999999999');
      await configure(m.id, {
        tier: { ...TEST_TIER, caps: TEST_TIER.caps.map((c) => (c.kind === 'daily_intake' ? { ...c, limit: '30' } : c)) },
      });
      const guards = required();
      const paymentId = randomUUID();
      const booked = (id: string, amount: string) =>
        sql.begin((tx) =>
          guards.afterPaymentCaptureBooked({ tx: tx as never, paymentId: id, merchantId: m.id, assetId: 'USDT', amount: amt(amount) }),
        );
      // 150 is over the per-payment (100) and the day (30): counted all the same.
      await booked(paymentId, '150');
      await booked(paymentId, '150');
      expect(await usage(m.id, 'daily_intake')).toBe('150');
      const flags = await sql<
        Array<{ after: { exceeded: string[] } }>
      >`SELECT after FROM pay.control_audit WHERE kind = 'payment.captured_over_cap'`;
      expect(flags).toHaveLength(1);
      expect(flags[0]!.after.exceeded).toEqual(['per_payment', 'daily_intake']);
      // A merchant with no tier at all: still counted, flagged as config_missing, no pricing snapshot.
      const bare = await merchant('99999999-9999-4999-8999-999999999998');
      const bareId = randomUUID();
      await sql.begin((tx) =>
        guards.afterPaymentCaptureBooked({ tx: tx as never, paymentId: bareId, merchantId: bare.id, assetId: 'USDT', amount: amt('5') }),
      );
      expect(await usage(bare.id, 'daily_intake')).toBe('5');
      expect((await sql`SELECT 1 FROM pay.control_audit WHERE merchant_id = ${bare.id} AND reason LIKE '%config_missing%'`).length).toBe(1);
      expect((await sql`SELECT 1 FROM pay.control_pricing_snapshots WHERE subject_id = ${bareId}`).length).toBe(0);
    });

    it('a failing over-cap notice does not roll back a capture whose ledger post landed', async () => {
      const warnings: Array<Record<string, unknown>> = [];
      const p = service(
        composeGuards(
          createControlGuards({
            sql,
            mode: 'required',
            warn: (fields) => {
              warnings.push(fields);
            },
          }),
        ),
      );
      const m = await merchant('99999999-9999-4999-8999-999999999997', p);
      await configure(m.id);
      const ids: string[] = [];
      for (let i = 0; i < 4; i += 1) {
        const created = await pay(p, m.id, '100');
        await fund(p, created.id, '100');
        ids.push(created.id);
      }
      await sql.unsafe(`
        CREATE OR REPLACE FUNCTION pay.test_reject_over_cap_notice() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'notice insert refused';
        END $$;
        CREATE TRIGGER test_reject_over_cap_notice
        BEFORE INSERT ON pay.merchant_notifications
        FOR EACH ROW EXECUTE FUNCTION pay.test_reject_over_cap_notice();
      `);
      try {
        for (const id of ids) expect((await p.capture(id)).status).toBe('captured');
        expect(await usage(m.id, 'daily_intake')).toBe('400');
        expect(warnings).toEqual([
          expect.objectContaining({
            event: 'payment.captured_over_cap_notice_failed',
            paymentId: ids[3],
            merchantId: m.id,
          }),
        ]);
        expect(await sql`SELECT 1 FROM pay.merchant_notifications WHERE merchant_id = ${m.id}`).toHaveLength(0);
        expect(await sql`SELECT 1 FROM pay.control_audit WHERE merchant_id = ${m.id} AND kind = 'payment.captured_over_cap'`).toHaveLength(
          1,
        );
        expect(await ledger.getTxByKey(`payment.capture:${ids[3]!.toLowerCase()}`)).not.toBeNull();
      } finally {
        await sql`DROP TRIGGER IF EXISTS test_reject_over_cap_notice ON pay.merchant_notifications`;
        await sql`DROP FUNCTION IF EXISTS pay.test_reject_over_cap_notice()`;
      }
    });

    it('a pricing rule that cannot be computed skips the snapshot, never the capture', async () => {
      const m = await merchant('99999999-9999-4999-8999-999999999999');
      await configure(m.id);
      // A rule whose arithmetic fails (a fee that would exceed the amount's scale) is stored as config; make it unreadable.
      await sql`ALTER TABLE pay.control_pricing_rules DISABLE TRIGGER USER`;
      await sql`UPDATE pay.control_pricing_rules SET bands = '[{"fromAmount":"0","feeBps":-1,"flatFee":null}]'::jsonb WHERE layer = 'global'`;
      await sql`ALTER TABLE pay.control_pricing_rules ENABLE TRIGGER USER`;
      const paymentId = randomUUID();
      await sql.begin((tx) =>
        required().afterPaymentCaptureBooked({ tx: tx as never, paymentId, merchantId: m.id, assetId: 'USDT', amount: amt('5') }),
      );
      expect(await usage(m.id, 'daily_intake')).toBe('5');
      expect((await sql`SELECT 1 FROM pay.control_pricing_snapshots WHERE subject_id = ${paymentId}`).length).toBe(0);
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

    it('a retry on a LATER day is counted on its own day; a same-day retry stays free', async () => {
      const m = await merchant('99999999-9999-4999-8999-999999999999');
      await configure(m.id, {
        tier: { ...TEST_TIER, caps: TEST_TIER.caps.map((c) => (c.kind === 'daily_payout' ? { ...c, limit: '30' } : c)) },
      });
      let clock = new Date('2026-03-10T10:00:00Z');
      const g = composeGuards(createControlGuards({ sql, mode: 'required', now: () => clock, ledger }));
      const settlementId = randomUUID();
      const byDay = async () =>
        Object.fromEntries(
          (
            await sql<Array<{ period_key: string; used: string }>>`
              SELECT period_key, used FROM pay.control_cap_usage WHERE merchant_id = ${m.id} AND cap_kind = 'daily_payout'`
          ).map((r) => [r.period_key, formatAmount(amt(r.used))]),
        );
      await sql.begin((tx) => g.beforePayoutAdmit(payoutCtx(tx, m.id, { settlementId, amount: amt('20'), attempt: 0 })));
      await sql.begin((tx) => g.beforePayoutAdmit(payoutCtx(tx, m.id, { settlementId, amount: amt('20'), attempt: 1 })));
      expect(await byDay()).toEqual({ '2026-03-10': '20' });
      clock = new Date('2026-03-11T00:00:01Z');
      await sql.begin((tx) => g.beforePayoutAdmit(payoutCtx(tx, m.id, { settlementId, amount: amt('20'), attempt: 2 })));
      await sql.begin((tx) => g.beforePayoutAdmit(payoutCtx(tx, m.id, { settlementId, amount: amt('20'), attempt: 3 })));
      expect(await byDay()).toEqual({ '2026-03-10': '20', '2026-03-11': '20' });
      // The later day's count is real: it takes its share of that day's cap.
      await expect(
        sql.begin((tx) => g.beforePayoutAdmit(payoutCtx(tx, m.id, { amount: amt('10.000000000000000001') }))),
      ).rejects.toMatchObject({
        code: 'pay.cap_daily_payout_exceeded',
      });
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

  describe('a personal withdrawal is not a merchant payout', () => {
    const OWNER = '77777777-7777-4777-8777-777777777777';
    const BANK = { kind: 'bank', ref: 'DE89370400440532013000' };
    const wdTier = (daily: string) => ({
      ...TEST_TIER,
      caps: TEST_TIER.caps.map((c) => (c.kind === 'daily_payout' ? { ...c, limit: daily } : c)),
    });

    beforeEach(async () => {
      await truncatePayForTest(sql, 'pay', 'TRUNCATE pay.withdrawals, pay.deposits RESTART IDENTITY CASCADE');
    });

    /** A USDT settlement for the merchant, made with the controls off so nothing is counted. */
    let windowSeq = 0;
    async function settle(merchantId: string, assetId = 'USDT') {
      const off = service(composeGuards({}));
      const created = await pay(off, merchantId, '10');
      await fund(off, created.id, '10');
      await off.capture(created.id);
      windowSeq += 1;
      return off.settleWindow({
        merchantId,
        window: `wd-${windowSeq}`,
        assetId,
        from: new Date(Date.now() - 86_400_000),
        to: new Date(Date.now() + 86_400_000),
      });
    }

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

    it('required: a personal withdrawal is not refused for a payout cap, and it counts nothing', async () => {
      const m = await merchant(OWNER);
      await configure(m.id, { tier: wdTier('30') });
      await settle(m.id);
      const svc = await funded(required());
      expect((await svc.withdraw(request('w1', '20'))).status).toBe('sent');
      expect((await svc.withdraw(request('w2', '40'))).status).toBe('sent');
      expect(await usage(m.id, 'daily_payout')).toBe('0');
      expect((await sql`SELECT 1 FROM pay.control_beneficiaries`).length).toBe(0);
    });

    it('required: an owner withdrawal is refused when the merchant still has a legacy settlement over the payout cap', async () => {
      const m = await merchant(OWNER);
      await configure(m.id, { tier: wdTier('30') });
      const off = service(composeGuards({}));
      const created = await pay(off, m.id, '10');
      await fund(off, created.id, '10');
      await off.capture(created.id);
      windowSeq += 1;
      const window = `wd-legacy-${windowSeq}`;
      await ledger.post({
        idempotencyKey: `settlement:${m.id}:${window}:USDT`,
        module: 'pay',
        reason: 'pay.settled',
        meta: { merchantId: m.id, window, assetId: 'USDT' },
        entries: [
          { account: merchantClearing(m.id, 'USDT'), direction: 'credit', amount: amt('10') },
          { account: userAvailable(OWNER, 'USDT'), direction: 'debit', amount: amt('10') },
        ],
      });
      const settled = await off.settleWindow({
        merchantId: m.id,
        window,
        assetId: 'USDT',
        from: new Date(Date.now() - 86_400_000),
        to: new Date(Date.now() + 86_400_000),
      });
      expect(settled.status).toBe('posted');
      const svc = await funded(required());
      expect((await svc.withdraw(request('legacy-w1', '20'))).status).toBe('sent');
      expect(await usage(m.id, 'daily_payout')).toBe('20');
      await expect(svc.withdraw(request('legacy-w2', '10.000000000000000001'))).rejects.toMatchObject({
        code: 'pay.cap_daily_payout_exceeded',
      });
      expect((await sql`SELECT 1 FROM pay.withdrawals WHERE client_ref = 'legacy-w2'`).length).toBe(0);
      expect(await usage(m.id, 'daily_payout')).toBe('20');
    });

    it('required: a pending row with a pre-cutover post puts the owner under the payout cap', async () => {
      const m = await merchant(OWNER);
      await configure(m.id, { tier: wdTier('30') });
      const off = service(composeGuards({}));
      const created = await pay(off, m.id, '10');
      await fund(off, created.id, '10');
      await off.capture(created.id);
      windowSeq += 1;
      const window = `wd-pending-legacy-${windowSeq}`;
      await ledger.post({
        idempotencyKey: `settlement:${m.id}:${window}:USDT`,
        module: 'pay',
        reason: 'pay.settled',
        meta: { merchantId: m.id, window, assetId: 'USDT' },
        entries: [
          { account: merchantClearing(m.id, 'USDT'), direction: 'credit', amount: amt('10') },
          { account: userAvailable(OWNER, 'USDT'), direction: 'debit', amount: amt('10') },
        ],
      });
      await sql`
        INSERT INTO pay.settlements (merchant_id, "window", asset_id, gross, fees, net, status)
        VALUES (${m.id}, ${window}, 'USDT', 10, 0, 10, 'pending')
      `;
      const svc = await funded(required());
      expect((await svc.withdraw(request('pending-legacy-w1', '20'))).status).toBe('sent');
      expect(await usage(m.id, 'daily_payout')).toBe('20');
      await expect(svc.withdraw(request('pending-legacy-w2', '10.000000000000000001'))).rejects.toMatchObject({
        code: 'pay.cap_daily_payout_exceeded',
      });
      expect(await usage(m.id, 'daily_payout')).toBe('20');
    });

    it('required: a pending settlement with no ledger post does not cap the owner', async () => {
      const m = await merchant(OWNER);
      await configure(m.id, { tier: wdTier('30') });
      windowSeq += 1;
      await sql`
        INSERT INTO pay.settlements (merchant_id, "window", asset_id, gross, fees, net, status)
        VALUES (${m.id}, ${`wd-pending-empty-${windowSeq}`}, 'USDT', 10, 0, 10, 'pending')
      `;
      const svc = await funded(required());
      expect((await svc.withdraw(request('pending-empty', '40'))).status).toBe('sent');
      expect(await usage(m.id, 'daily_payout')).toBe('0');
    });

    it('required: beforePayoutAdmit still enforces the daily payout cap on the proceeds payout', async () => {
      const m = await merchant(OWNER);
      await configure(m.id, { tier: wdTier('30') });
      await settle(m.id);
      const g = required();
      const admit = (tx: unknown, amount: bigint) =>
        g.beforePayoutAdmit({
          tx: tx as never,
          settlementId: randomUUID(),
          merchantId: m.id,
          assetId: 'USDT',
          amount,
          railId: 'crypto-native',
          destination: DEST_A,
          attempt: 0,
          replay: FRESH,
        });
      await sql.begin((tx) => admit(tx, amt('20')));
      await expect(sql.begin((tx) => admit(tx, amt('10.000000000000000001')))).rejects.toMatchObject({
        code: 'pay.cap_daily_payout_exceeded',
      });
      expect(await usage(m.id, 'daily_payout')).toBe('20');
    });

    it('required: an owner with settlements and nothing configured can still withdraw personal funds', async () => {
      const m = await merchant(OWNER);
      await settle(m.id);
      const svc = await funded(required());
      expect((await svc.withdraw(request('u1', '5'))).status).toBe('sent');
      expect((await sql`SELECT 1 FROM pay.control_cap_usage`).length).toBe(0);
      // The payout door is still closed: no tier means no payout admission.
      const g = required();
      await expect(
        sql.begin((tx) =>
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
        ),
      ).rejects.toMatchObject({ code: 'pay.tier_unassigned' });
    });

    it('the withdrawal hook does not count, including replay and a later day', async () => {
      const m = await merchant(OWNER);
      await configure(m.id, { tier: wdTier('30') });
      await settle(m.id);
      let clock = new Date('2026-03-10T10:00:00Z');
      const g = composeGuards(createControlGuards({ sql, mode: 'required', now: () => clock, ledger }));
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
      await sql.begin((tx) => g.beforeUserMoneyWithdrawal(ctx(tx, { replay: { kind: 'replay', reason: 'withdrawal_already_sent' } })));
      clock = new Date('2026-03-11T00:00:01Z');
      await sql.begin((tx) => g.beforeUserMoneyWithdrawal(ctx(tx)));
      expect(await usage(m.id, 'daily_payout')).toBe('0');
      expect((await sql`SELECT 1 FROM pay.control_beneficiaries WHERE merchant_id = ${m.id}`).length).toBe(0);
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
