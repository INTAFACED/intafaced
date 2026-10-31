import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Principal } from '@intafaced/auth';
import { type Context } from '@intafaced/contracts';
import { MemoryLedger, formatAmount, merchantClearing, merchantProceeds, parseAmount as amt } from '@intafaced/ledger-client';
import { PayService } from '../payment-service.js';
import { truncatePayForTest } from '../payment-events-test-reset.js';
import { memoryPayoutDestinations } from '../merchant-payout-destination.js';
import { RailRegistry } from '../rails/registry.js';
import { CardSandboxAdapter } from '../rails/card-sandbox.js';
import { CryptoNativeAdapter } from '../rails/crypto-native.js';
import { BankPayoutAbsentAdapter } from '../rails/bank-payout.js';
import { MemoryChain } from '../rails/chain-port.js';
import { REFERENCE_RAIL_ROUTING_PROFILES } from '../routing/decide.js';
import { SubMerchantService } from '../submerchants.js';
import { createFounderAuthority } from '../founder-authority.js';
import { createPayNamespaces } from '../namespaces/index.js';
import { createMetricsRuntime, MetricsProjector } from './index.js';

/**
 * J-merchant-07 #1: `merchantMetrics.settlementAssets` lists every asset a business can settle in (svc-pay's own
 * `PAY_SETTLEMENT_ASSETS`), each with its two ledger figures. A new business reads a true zero per asset; a blank list
 * refuses by name; a ledger that cannot be read refuses, and never reads as zero. Postgres is real, as in the other
 * svc-pay db suites: `TEST_DATABASE_URL`, or a Testcontainer when it is unset.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const SECRET = 'svc-pay-settlement-assets-test-secret-32';
const DAY_MS = 86_400_000;

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_settle_assets_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

const principal = (userId: string): Principal => ({
  userId,
  sub: userId,
  sid: randomUUID(),
  scopes: ['pay:read', 'pay:write'],
  mfa: true,
  tier: 'full',
  expiresAt: new Date(Date.now() + 60_000),
});
const ctxOf = (p: Principal): Context => ({
  principal: p,
  service: null,
  region: 'DE',
  requestId: randomUUID(),
  forwardedPrincipal: { raw: 'test-principal', signature: 'test-signature', region: 'DE' },
});

type Row = { assetCode: string; clearing: string; available: string };
type Caller = { merchantMetrics: { settlementAssets: (i: unknown) => Promise<{ merchantId: string; asOf: string; assets: Row[] }> } };

describe('merchantMetrics.settlementAssets', { timeout: 30_000 }, () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let ledger: MemoryLedger;
  let chain: MemoryChain;
  let pay: PayService;

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    sql = db.sql;
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  beforeEach(async () => {
    await truncatePayForTest(
      sql,
      'pay',
      `TRUNCATE pay.metrics_merchant_day_link, pay.metrics_merchant_day_status, pay.metrics_merchant_day, pay.metrics_dirty,
         pay.checkout_sessions, pay.payment_links, pay.settlements, pay.payment_events, pay.payments, pay.payment_profiles,
         pay.merchant_permission_events, pay.merchants RESTART IDENTITY CASCADE`,
    );
    ledger = new MemoryLedger();
    chain = new MemoryChain();
    const rails = new RailRegistry([
      new CardSandboxAdapter({ secret: SECRET, toleranceSeconds: 300 }),
      new CryptoNativeAdapter({ chain, secret: SECRET, minConfirmations: 6, toleranceSeconds: 300 }),
      new BankPayoutAbsentAdapter(),
    ]);
    pay = new PayService(sql, ledger, rails, {
      checkoutRiskBand: 'low',
      payoutDestinations: memoryPayoutDestinations(),
      routingProfiles: REFERENCE_RAIL_ROUTING_PROFILES.map((p) => ({ ...p, successRate: '0.90' })),
      linkDefaultTtlDays: 30,
      linkMaxTtlDays: 365,
      checkoutSessionTtlSeconds: 900,
      maxOpenSessionsPerLink: 25,
    });
  });

  /** The router a merchant's session reaches, over a runtime with this list (or none). */
  function callerFor(userId: string, settlementAssets: readonly string[] | null | undefined, balances?: PayService): Caller {
    const metrics = createMetricsRuntime(
      { sql, pay: balances ?? pay, trees: new SubMerchantService(sql), rails: { health: () => [] } },
      settlementAssets === undefined ? {} : { settlementAssets },
    );
    const founderAuthority = createFounderAuthority({ identityUrl: 'https://identity.invalid', serviceSecret: 's'.repeat(32) });
    return createPayNamespaces({ founderAuthority, metrics }).createCaller(ctxOf(principal(userId))) as unknown as Caller;
  }
  const failure = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      const err = e as { code: string; message: string; cause?: { code?: string } };
      return { code: err.code, cause: err.cause?.code };
    }
    throw new Error('expected a refusal');
  };
  const newMerchant = (userId: string) => pay.createMerchant({ userId, pricing: { feeBps: 250 }, status: 'active', kybStatus: 'approved' });

  it('a new business reads a zero row per enabled asset, the ledger’s own answer, in the owner’s order', async () => {
    const user = randomUUID();
    const m = await newMerchant(user);
    const read = await callerFor(user, ['USDT', 'EUR']).merchantMetrics.settlementAssets({ merchantId: m.id });
    expect(read.merchantId).toBe(m.id);
    expect(Number.isNaN(Date.parse(read.asOf))).toBe(false);
    expect(read.assets).toEqual([
      { assetCode: 'USDT', clearing: '0', available: '0' },
      { assetCode: 'EUR', clearing: '0', available: '0' },
    ]);
    // The snapshot still lists only what is held: the zero rows come from the settlement-asset list, not from it.
    const metrics = createMetricsRuntime({ sql, pay, trees: null, rails: { health: () => [] } }, { settlementAssets: ['USDT'] });
    expect((await metrics.reader.merchantSnapshot(m.id, { kind: 'preset', preset: 'today' })).balances).toEqual([]);
  });

  it('a held asset reads its ledger figures and an enabled asset with nothing posted reads zero; an asset outside the list is not shown', async () => {
    const user = randomUUID();
    const m = await newMerchant(user);
    // A captured USDT card payment (clearing) settled into available, and a captured BTC crypto payment (not enabled).
    const card = await pay.createPayment({
      merchantId: m.id,
      amount: amt('40'),
      assetId: 'USDT',
      method: 'card',
      railAdapter: 'card-sandbox',
      instrument: { kind: 'card', token: 'tok_ok' },
    });
    await pay.authorize(card.id);
    await pay.capture(card.id);
    const second = await pay.createPayment({
      merchantId: m.id,
      amount: amt('2.5'),
      assetId: 'USDT',
      method: 'card',
      railAdapter: 'card-sandbox',
      instrument: { kind: 'card', token: 'tok_ok' },
    });
    await pay.authorize(second.id);
    await pay.capture(second.id);
    const btc = await pay.createPayment({
      merchantId: m.id,
      amount: amt('3'),
      assetId: 'BTC',
      method: 'crypto',
      railAdapter: 'crypto-native',
    });
    chain.credit({
      address: await chain.acceptanceAddress(btc.id, 'BTC'),
      assetId: 'BTC',
      amount: amt('3'),
      from: '0xbuyer',
      confirmations: 12,
    });
    await pay.authorize(btc.id);
    await pay.capture(btc.id);
    await pay.settleWindow({
      merchantId: m.id,
      window: new Date().toISOString().slice(0, 10),
      assetId: 'USDT',
      from: new Date(Date.now() - DAY_MS),
      to: new Date(Date.now() + DAY_MS),
    });
    await new MetricsProjector(sql).drain();

    const read = await callerFor(user, ['USDT', 'ETH']).merchantMetrics.settlementAssets({ merchantId: m.id });
    const usdt = read.assets.find((a) => a.assetCode === 'USDT')!;
    // The ledger's own figures, not a copy: whatever settlement left in clearing and what it made available.
    expect(usdt.clearing).toBe(formatAmount((await ledger.balance(merchantClearing(m.id, 'USDT'))).amount));
    expect(usdt.available).toBe(formatAmount((await ledger.balance(merchantProceeds(m.id, 'USDT'))).amount));
    expect(amt(usdt.available)).toBeGreaterThan(0n);
    expect(read.assets).toEqual([usdt, { assetCode: 'ETH', clearing: '0', available: '0' }]);
    expect(read.assets.map((a) => a.assetCode)).not.toContain('BTC');
  });

  it('a blank list refuses pay.settlement_assets_unset, never a guessed list', async () => {
    const user = randomUUID();
    const m = await newMerchant(user);
    for (const unset of [null, undefined, []] as const) {
      const refused = await failure(callerFor(user, unset).merchantMetrics.settlementAssets({ merchantId: m.id }));
      expect(refused).toEqual({ code: 'PRECONDITION_FAILED', cause: 'pay.settlement_assets_unset' });
    }
  });

  it('an unreadable balance refuses pay.metrics_balance_unavailable and is never a zero', async () => {
    const user = randomUUID();
    const m = await newMerchant(user);
    const down = Object.create(pay) as PayService;
    // Clearing reads; available does not. No half-filled row may come back.
    down.merchantBalance = vi.fn(async () => {
      throw new Error('ledger unreachable');
    });
    const refused = await failure(callerFor(user, ['USDT', 'EUR'], down).merchantMetrics.settlementAssets({ merchantId: m.id }));
    expect(refused).toEqual({ code: 'SERVICE_UNAVAILABLE', cause: 'pay.metrics_balance_unavailable' });
    // The same read with the ledger back answers its zeros.
    const back = await callerFor(user, ['USDT', 'EUR']).merchantMetrics.settlementAssets({ merchantId: m.id });
    expect(back.assets).toEqual([
      { assetCode: 'USDT', clearing: '0', available: '0' },
      { assetCode: 'EUR', clearing: '0', available: '0' },
    ]);
  });

  it('another business, or no business, gets the one not-found answer', async () => {
    const owner = randomUUID();
    const stranger = randomUUID();
    const m = await newMerchant(owner);
    await newMerchant(stranger);
    const theirs = await failure(callerFor(stranger, ['USDT']).merchantMetrics.settlementAssets({ merchantId: m.id }));
    const missing = await failure(callerFor(stranger, ['USDT']).merchantMetrics.settlementAssets({ merchantId: randomUUID() }));
    expect(theirs).toEqual(missing);
    expect(theirs.code).toBe('NOT_FOUND');
  });
});
