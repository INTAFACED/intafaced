import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryLedger, parseAmount as amt } from '@intafaced/ledger-client';
import { PayService } from '../payment-service.js';
import { truncatePayForTest } from '../payment-events-test-reset.js';
import { memoryPayoutDestinations } from '../merchant-payout-destination.js';
import { installPayoutDestinationShim } from '../payout-destination-test-shim.js';
import { RailRegistry } from '../rails/registry.js';
import { CardSandboxAdapter } from '../rails/card-sandbox.js';
import { CryptoNativeAdapter } from '../rails/crypto-native.js';
import { BankPayoutAbsentAdapter } from '../rails/bank-payout.js';
import { MemoryChain } from '../rails/chain-port.js';
import { REFERENCE_RAIL_ROUTING_PROFILES } from '../routing/decide.js';
import { composeGuards, PayGuardRefusal, type PartialPayGuards } from './guards.js';
import { createCategoryGuards } from '../onboarding-policy/category.js';

/**
 * The seams are wired into the real money paths (not just defined).
 *
 * Same Postgres arrangement as payment-service.test.ts: `TEST_DATABASE_URL`, or
 * a Testcontainer when it is unset. The existing svc-pay suites running with
 * NO guards passed are the proof that the defaults preserve behaviour.
 */
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

const SECRET = 'svc-pay-seams-test-secret-at-least-32-characters';
const USER = '11111111-1111-4111-8111-111111111111';
const DEST = { kind: 'crypto', ref: '0x0000000000000000000000000000000000000f01' };

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_seams_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

describe('guard seams are called on the real money paths', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let ledger: MemoryLedger;
  let chain: MemoryChain;
  let rails: RailRegistry;

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    sql = db.sql;
  }, 120_000);

  let restorePayoutShim: (() => void) | undefined;
  afterEach(() => {
    restorePayoutShim?.();
    restorePayoutShim = undefined;
  });
  beforeEach(async () => {
    restorePayoutShim = installPayoutDestinationShim(sql);
    await truncatePayForTest(
      sql,
      'pay',
      `TRUNCATE pay.merchant_category_events, pay.merchant_categories, pay.business_category_events, pay.business_categories, pay.checkout_sessions, pay.payment_links, pay.settlements, pay.payment_events, pay.payments, pay.payment_profiles, pay.merchants RESTART IDENTITY CASCADE`,
    );
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

  const service = (parts: PartialPayGuards = {}) =>
    new PayService(sql, ledger, rails, { payoutDestinations: memoryPayoutDestinations(), guards: composeGuards(parts) });

  async function capturedCryptoPayment(pay: PayService, merchantId: string, amount = '10') {
    const created = await pay.createPayment({
      merchantId,
      amount: amt(amount),
      assetId: 'USDT',
      method: 'crypto',
      railAdapter: 'crypto-native',
    });
    const address = await chain.acceptanceAddress(created.id, 'USDT');
    chain.credit({ address, assetId: 'USDT', amount: amt(amount), from: '0xbuyer', confirmations: 12 });
    await pay.authorize(created.id);
    await pay.capture(created.id);
    return created;
  }

  const settle = (pay: PayService, merchantId: string, window: string) =>
    pay.settleWindow({
      merchantId,
      window,
      assetId: 'USDT',
      from: new Date(Date.now() - 24 * 3600_000),
      to: new Date(Date.now() + 24 * 3600_000),
    });

  it('payment, settlement and payout hooks fire with the right context; conversion stays uncalled', async () => {
    const seen = {
      payment: [] as string[],
      settlement: [] as string[],
      payoutAdmit: vi.fn(async () => undefined),
      payoutExecute: vi.fn(async () => undefined),
      conversion: vi.fn(async () => undefined),
    };
    const pay = service({
      beforePaymentAdmit: async (ctx) => void seen.payment.push(ctx.kind),
      beforeSettlementRun: async (ctx) => void seen.settlement.push(ctx.phase),
      beforePayoutAdmit: seen.payoutAdmit,
      beforePayoutExecute: seen.payoutExecute,
      beforeConversion: seen.conversion,
    });
    const m = await pay.createMerchant({ userId: USER, pricing: { feeBps: 0 } });
    await capturedCryptoPayment(pay, m.id);
    expect(new Set(seen.payment)).toEqual(new Set(['payment.create', 'payment.authorize', 'payment.capture']));
    const settlement = await settle(pay, m.id, 'seam-all');
    expect(seen.settlement).toEqual(['prepare', 'post']);
    await pay.payoutSettlement({ settlementId: settlement.id, railId: 'crypto-native', destination: DEST });
    expect(seen.payoutAdmit).toHaveBeenCalledTimes(1);
    expect(seen.payoutAdmit).toHaveBeenCalledWith(
      expect.objectContaining({
        settlementId: settlement.id,
        merchantId: m.id,
        railId: 'crypto-native',
        destination: DEST,
        amount: settlement.net,
      }),
    );
    expect(seen.payoutExecute).toHaveBeenCalledTimes(1);
    expect(seen.conversion).not.toHaveBeenCalled();
  });

  it('a refusing beforePaymentAdmit leaves no payment row', async () => {
    const pay = service({
      beforePaymentAdmit: async () => {
        throw new PayGuardRefusal('pay.guard_test_refused', 'refused');
      },
    });
    const m = await service().createMerchant({ userId: USER, pricing: { feeBps: 0 } });
    await expect(
      pay.createPayment({ merchantId: m.id, amount: amt('5'), assetId: 'USDT', method: 'crypto', railAdapter: 'crypto-native' }),
    ).rejects.toMatchObject({ code: 'pay.guard_test_refused' });
    expect(await sql`SELECT id FROM pay.payments`).toHaveLength(0);
  });

  it('public checkout goes through beforePaymentAdmit; a raw guard error refuses closed and leaves no payment or session', async () => {
    const checkout = (parts: PartialPayGuards = {}) =>
      new PayService(sql, ledger, rails, {
        payoutDestinations: memoryPayoutDestinations(),
        guards: composeGuards(parts),
        checkoutRiskBand: 'low',
        routingProfiles: REFERENCE_RAIL_ROUTING_PROFILES.map((p) =>
          p.railId === 'crypto-native'
            ? { ...p, successRate: '0.90' }
            : p.railId === 'card-sandbox'
              ? { ...p, successRate: '0.88' }
              : { ...p },
        ),
        linkDefaultTtlDays: 30,
        linkMaxTtlDays: 365,
        checkoutSessionTtlSeconds: 900,
        maxOpenSessionsPerLink: 25,
      });
    const open = checkout();
    const m = await open.createMerchant({ userId: USER, pricing: { feeBps: 0 } });
    const link = await open.createPaymentLink({ merchantId: m.id, label: 'Seam checkout', amount: amt('8'), currency: 'USDT' });
    const refusing = checkout({
      beforePaymentAdmit: async () => {
        throw new Error('relation "pay.halts" does not exist');
      },
    });
    const error = await refusing.openCheckoutSession({ linkToken: link.token, geoCountry: 'ID', method: 'crypto' }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(PayGuardRefusal);
    expect(error).toMatchObject({ code: 'pay.guard_unavailable', message: 'pay.guard_unavailable' });
    expect(await sql`SELECT id FROM pay.payments`).toHaveLength(0);
    expect(await sql`SELECT id FROM pay.checkout_sessions`).toHaveLength(0);

    const seen: string[] = [];
    const watching = checkout({ beforePaymentAdmit: async (ctx) => void seen.push(`${ctx.kind}:${ctx.merchantId}`) });
    await watching.openCheckoutSession({ linkToken: link.token, geoCountry: 'ID', method: 'crypto' });
    expect(seen[0]).toBe(`payment.create:${m.id}`);
  });

  it('RC-merchant-08: a prohibited category or a blank reserve opens no checkout session, and a restricted one takes no card payment', async () => {
    const checkout = () =>
      new PayService(sql, ledger, rails, {
        payoutDestinations: memoryPayoutDestinations(),
        guards: composeGuards(createCategoryGuards({ sql })),
        checkoutRails: [
          { railId: 'crypto-native', method: 'crypto' },
          { railId: 'card-sandbox', method: 'card' },
        ],
        publicCheckoutMovement: 'allow-sandbox',
        checkoutRiskBand: 'low',
        routingProfiles: REFERENCE_RAIL_ROUTING_PROFILES.map((p) =>
          p.railId === 'crypto-native'
            ? { ...p, successRate: '0.90' }
            : p.railId === 'card-sandbox'
              ? { ...p, successRate: '0.88' }
              : { ...p },
        ),
        linkDefaultTtlDays: 30,
        linkMaxTtlDays: 365,
        checkoutSessionTtlSeconds: 900,
        maxOpenSessionsPerLink: 25,
      });
    const pay = checkout();
    const m = await pay.createMerchant({ userId: USER, pricing: { feeBps: 0 } });
    const link = await pay.createPaymentLink({ merchantId: m.id, label: 'TEST category checkout', amount: amt('8'), currency: 'USDT' });
    // TEST DATA ONLY: two categories written straight to the table (the founder flow is proved in category.db.test.ts).
    await sql`
      INSERT INTO pay.business_categories (key, label, class, reserve_percent, reserve_hold_days, extra_documents, version, updated_by, approved_by)
      VALUES ('test-weapons', 'TEST Weapons', 'prohibited', NULL, NULL, '{}', 1, 'founder-a', 'founder-b'),
             ('test-travel', 'TEST Travel', 'restricted', 5, 90, '{}', 1, 'founder-a', 'founder-b')
    `;
    await sql`INSERT INTO pay.merchant_categories (merchant_id, category_key, table_version, chosen_by) VALUES (${m.id}, 'test-weapons', 2, ${USER})`;
    await expect(pay.openCheckoutSession({ linkToken: link.token, geoCountry: 'ID', method: 'crypto' })).rejects.toMatchObject({
      code: 'pay.category_prohibited',
    });
    await expect(
      pay.createPayment({ merchantId: m.id, amount: amt('5'), assetId: 'USDT', method: 'crypto', railAdapter: 'crypto-native' }),
    ).rejects.toMatchObject({ code: 'pay.category_prohibited' });
    expect(await sql`SELECT id FROM pay.payments`).toHaveLength(0);
    expect(await sql`SELECT id FROM pay.checkout_sessions`).toHaveLength(0);

    await sql`UPDATE pay.merchant_categories SET category_key = 'test-travel' WHERE merchant_id = ${m.id}`;
    await expect(pay.openCheckoutSession({ linkToken: link.token, geoCountry: 'US', method: 'card' })).rejects.toMatchObject({
      code: 'pay.category_rail_refused',
    });
    await expect(
      pay.createPayment({ merchantId: m.id, amount: amt('5'), assetId: 'USDT', method: 'card', railAdapter: 'card-sandbox' }),
    ).rejects.toMatchObject({ code: 'pay.category_rail_refused' });
    expect(await sql`SELECT id FROM pay.checkout_sessions`).toHaveLength(0);

    // A restricted category with blank reserve terms opens no session either, refused by name before any row.
    await sql`
      INSERT INTO pay.business_categories (key, label, class, reserve_percent, reserve_hold_days, extra_documents, version, updated_by, approved_by)
      VALUES ('test-games', 'TEST Games', 'restricted', NULL, NULL, '{}', 1, 'founder-a', 'founder-b')
    `;
    await sql`UPDATE pay.merchant_categories SET category_key = 'test-games' WHERE merchant_id = ${m.id}`;
    await expect(pay.openCheckoutSession({ linkToken: link.token, geoCountry: 'ID', method: 'crypto' })).rejects.toMatchObject({
      code: 'pay.reserve_terms_unset',
    });
    expect(await sql`SELECT id FROM pay.checkout_sessions`).toHaveLength(0);

    await sql`UPDATE pay.merchant_categories SET category_key = 'test-travel' WHERE merchant_id = ${m.id}`;
    await pay.openCheckoutSession({ linkToken: link.token, geoCountry: 'ID', method: 'crypto' });
    expect(await sql`SELECT rail_adapter FROM pay.payments`).toEqual([{ rail_adapter: 'crypto-native' }]);

    // A standard category (OWNER 108) takes a card payment, through the same admission guard.
    await sql`
      INSERT INTO pay.business_categories (key, label, class, reserve_percent, reserve_hold_days, extra_documents, version, updated_by, approved_by)
      VALUES ('test-shop', 'TEST Shop', 'standard', NULL, NULL, '{}', 1, 'founder-a', 'founder-b')
    `;
    await sql`UPDATE pay.merchant_categories SET category_key = 'test-shop' WHERE merchant_id = ${m.id}`;
    await pay.createPayment({ merchantId: m.id, amount: amt('5'), assetId: 'USDT', method: 'card', railAdapter: 'card-sandbox' });
    expect(await sql`SELECT rail_adapter FROM pay.payments ORDER BY created_at`).toEqual([
      { rail_adapter: 'crypto-native' },
      { rail_adapter: 'card-sandbox' },
    ]);
  });

  it('a refusing beforeSettlementRun freezes no settlement and moves no value', async () => {
    const open = service();
    const m = await open.createMerchant({ userId: USER, pricing: { feeBps: 0 } });
    await capturedCryptoPayment(open, m.id);
    const before = ledger.reconcile();
    const pay = service({
      beforeSettlementRun: async () => {
        throw new PayGuardRefusal('pay.guard_test_refused', 'refused');
      },
    });
    await expect(settle(pay, m.id, 'seam-settle-refused')).rejects.toMatchObject({ code: 'pay.guard_test_refused' });
    expect(await sql`SELECT id FROM pay.settlements`).toHaveLength(0);
    expect(ledger.reconcile()).toEqual(before);
  });

  it('a refusing beforePayoutAdmit records no admission; a refusing beforePayoutExecute posts no hold and sends nothing', async () => {
    const open = service();
    const m = await open.createMerchant({ userId: USER, pricing: { feeBps: 0 } });
    await capturedCryptoPayment(open, m.id);
    const settlement = await settle(open, m.id, 'seam-payout-refused');
    const request = { settlementId: settlement.id, railId: 'crypto-native', destination: DEST };

    const noAdmit = service({
      beforePayoutAdmit: async () => {
        throw new PayGuardRefusal('pay.guard_admit_refused', 'refused');
      },
    });
    await expect(noAdmit.payoutSettlement(request)).rejects.toMatchObject({ code: 'pay.guard_admit_refused' });
    expect(await sql`SELECT id FROM pay.payout_admissions`).toHaveLength(0);

    const noExecute = service({
      beforePayoutExecute: async () => {
        throw new PayGuardRefusal('pay.guard_execute_refused', 'refused');
      },
    });
    await expect(noExecute.payoutSettlement(request)).rejects.toMatchObject({ code: 'pay.guard_execute_refused' });
    expect(chain.outboundTransfers()).toHaveLength(0);
    const held = (await ledger.balances('user', USER)).filter((b) => b.account.kind === 'hold').reduce((a, b) => a + b.amount, 0n);
    expect(held).toBe(0n);

    // Lifting the refusal lets the same admitted payout complete: nothing was lost.
    const paid = await open.payoutSettlement(request);
    expect(paid.status).toBe('paid_out');
    expect(chain.outboundTransfers()).toHaveLength(1);
  });
});
