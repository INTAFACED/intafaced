import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import {
  MemoryLedger,
  formatAmount,
  houseFees,
  merchantClearing,
  merchantFeeReceivableAccount,
  partnerFeeReceivableAccount,
  parseAmount as amt,
  type PostRequest,
} from '@intafaced/ledger-client';
import { HDKey } from 'viem/accounts';
import { keccak256, toBytes } from 'viem';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { memoryPayoutDestinations } from '../merchant-payout-destination.js';
import { PayService } from '../payment-service.js';
import { truncatePayForTest } from '../payment-events-test-reset.js';
import { BankTransferSandboxAdapter } from '../rails/bank-transfer-sandbox.js';
import { MemoryChain } from '../rails/chain-port.js';
import { CryptoNativeAdapter } from '../rails/crypto-native.js';
import { RailRegistry } from '../rails/registry.js';
import { REFERENCE_RAIL_ROUTING_PROFILES } from '../routing/decide.js';
import type { MerchantCaller } from '../merchant-ops/roles.js';
import { readExtendedPublicKey, receivingAddress } from './keys.js';
import { outsideFundsOf } from './outside-funds.js';
import { ReceivingWallets } from './wallet.js';

/**
 * J-merchant-04 on the launch money model (OWNER 226): with the custodial layer off, a payer's crypto at hosted checkout
 * goes straight to an address of the business's own wallet, a bank transfer goes to the acquiring partner, and our
 * ledger records only our own fee on the payment, once, under the payment's key. TEST keys, TEST amounts, a TEST fee.
 */
const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const SECRET = 'svc-pay-own-wallet-secret-at-least-32-chars';
const OWNER = '11111111-1111-4111-8111-111111111111';
/** TEST fee, never a real value: 2.5%. */
const FEE_BPS = 250;
/** A TEST wallet's account key (m/44'/60'/0'), from a public seed: it holds nothing anywhere. */
const ACCOUNT = HDKey.fromMasterSeed(toBytes(keccak256(toBytes('intafaced TEST merchant receiving wallet')))).derive("m/44'/60'/0'");
const XPUB = ACCOUNT.publicExtendedKey;
const PROFILES = REFERENCE_RAIL_ROUTING_PROFILES.map((p) =>
  p.railId === 'crypto-native' || p.railId === 'bank-transfer-sandbox' ? { ...p, successRate: '0.9' } : { ...p },
);

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_own_wallet_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

describe('launch money model: hosted checkout pays the business, our ledger records only our fee', { timeout: 30_000 }, () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let ledger: MemoryLedger;
  let chain: MemoryChain;
  let bank: BankTransferSandboxAdapter;
  let posts: PostRequest[];

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    sql = db.sql;
  }, 120_000);

  beforeEach(async () => {
    await truncatePayForTest(
      sql,
      'pay',
      `TRUNCATE pay.merchant_receive_addresses, pay.merchant_receiving_wallets, pay.checkout_sessions, pay.payment_links,
                pay.settlements, pay.payment_events, pay.payments, pay.payment_profiles, pay.merchants RESTART IDENTITY CASCADE`,
    );
    ledger = new MemoryLedger();
    posts = [];
    const realPost = ledger.post.bind(ledger);
    ledger.post = async (request: PostRequest) => {
      posts.push(request);
      return realPost(request);
    };
    chain = new MemoryChain();
    bank = new BankTransferSandboxAdapter({ secret: SECRET, toleranceSeconds: 300 });
  });

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  const service = (over: { custodyLayer?: 'on' | 'off'; defaultFeeBps?: number | null } = {}) =>
    new PayService(
      sql,
      ledger,
      new RailRegistry([new CryptoNativeAdapter({ chain, secret: SECRET, minConfirmations: 6, toleranceSeconds: 300 }), bank]),
      {
        custodyLayer: over.custodyLayer ?? 'off',
        defaultFeeBps: over.defaultFeeBps ?? null,
        payoutDestinations: memoryPayoutDestinations(),
        checkoutRails: [
          { railId: 'crypto-native', method: 'crypto' },
          { railId: 'bank-transfer-sandbox', method: 'bank_transfer' },
        ],
        checkoutRiskBand: 'low',
        routingProfiles: PROFILES,
        payerNameMatchRule: 'exact_normalised',
        checkoutSessionTtlSeconds: 900,
        maxOpenSessionsPerLink: 25,
        linkDefaultTtlDays: 30,
        linkMaxTtlDays: 365,
      },
    );

  const ownerOf = (merchantId: string): MerchantCaller => ({
    merchantId,
    userId: OWNER,
    role: 'owner',
    viaApiKey: false,
    interactive: true,
  });

  /** A business on a TEST fee, or, with `blankFee`, one whose own price was never set (a pricing row with no fee). */
  async function business(pay: PayService, options: { blankFee?: boolean } = {}) {
    const m = await pay.createMerchant({ userId: OWNER, pricing: { feeBps: FEE_BPS } });
    if (options.blankFee) await sql`UPDATE pay.merchants SET pricing = '{}'::jsonb WHERE id = ${m.id}`;
    return m;
  }

  async function setWallet(merchantId: string, key = XPUB) {
    return new ReceivingWallets(sql).save(ownerOf(merchantId), {
      requestId: crypto.randomUUID(),
      expectedVersion: (await new ReceivingWallets(sql).get(ownerOf(merchantId))).version,
      family: 'evm',
      extendedPublicKey: key,
    });
  }

  /** The payment a hosted checkout session opened, as svc-pay holds it. */
  const paymentOf = async (sessionToken: string) =>
    (
      await sql<Array<{ id: string; custody: string; status: string }>>`
        SELECT p.id, p.custody, p.status::text AS status
          FROM pay.checkout_sessions s JOIN pay.payments p ON p.id = s.payment_id
         WHERE s.token_prefix = ${sessionToken.slice(0, 10)} ORDER BY s.created_at DESC LIMIT 1`
    )[0]!;

  it('a business with no receiving wallet cannot take crypto: refused before anything is written', async () => {
    const pay = service();
    const m = await business(pay);
    const link = await pay.createPaymentLink({ merchantId: m.id, label: 'TEST no wallet', amount: amt('25'), currency: 'USDT' });
    await expect(pay.openCheckoutSession({ linkToken: link.token, geoCountry: 'DE', method: 'crypto' })).rejects.toMatchObject({
      code: 'pay.receiving_wallet_unset',
    });
    expect(await sql`SELECT id FROM pay.payments`).toHaveLength(0);
    expect(await sql`SELECT id FROM pay.checkout_sessions`).toHaveLength(0);
  });

  it('a blank fee refuses with a typed error before the payer is shown where to pay', async () => {
    const pay = service({ defaultFeeBps: null });
    const m = await business(pay, { blankFee: true });
    await setWallet(m.id);
    const link = await pay.createPaymentLink({ merchantId: m.id, label: 'TEST no fee', amount: amt('25'), currency: 'USDT' });
    await expect(pay.openCheckoutSession({ linkToken: link.token, geoCountry: 'DE', method: 'crypto' })).rejects.toMatchObject({
      code: 'pay.fee_bps_unset',
    });
    expect(await sql`SELECT id FROM pay.payments`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM pay.merchant_receive_addresses`).toHaveLength(0);
  });

  it('a private key is refused and never stored; a key that does not read is refused', async () => {
    const pay = service();
    const m = await business(pay);
    await expect(setWallet(m.id, ACCOUNT.privateExtendedKey)).rejects.toMatchObject({ code: 'pay.receiving_wallet_private_key' });
    await expect(setWallet(m.id, `${XPUB.slice(0, -1)}${XPUB.endsWith('a') ? 'b' : 'a'}`)).rejects.toMatchObject({
      code: 'pay.receiving_wallet_invalid',
    });
    expect(await sql`SELECT 1 FROM pay.merchant_receiving_wallets`).toHaveLength(0);
  });

  it('pays in two transfers to the business’s own address; our ledger records only our fee, once, under the payment', async () => {
    const pay = service();
    const m = await business(pay);
    const saved = await setWallet(m.id);
    expect(saved.wallet.firstAddress).toBe(receivingAddress(readExtendedPublicKey(XPUB), 0));

    const link = await pay.createPaymentLink({ merchantId: m.id, label: 'TEST invoice', amount: amt('100'), currency: 'USDT' });
    const { session, sessionToken } = await pay.openCheckoutSession({ linkToken: link.token, geoCountry: 'DE', method: 'crypto' });
    const address = session.instruction!.reference;
    // The address the payer is shown is the business's own, at the next index of its key: nobody here holds its key.
    expect(address).toBe(receivingAddress(readExtendedPublicKey(XPUB), 0));
    const payment = await paymentOf(sessionToken);
    expect(payment.custody).toBe('merchant_wallet');
    // A second payment gets the next address of the same wallet, never the same one.
    const second = await pay.openCheckoutSession({ linkToken: link.token, geoCountry: 'DE', method: 'crypto' });
    expect(second.session.instruction!.reference).toBe(receivingAddress(readExtendedPublicKey(XPUB), 1));

    // TEST 60 of TEST 100 arrives and is final: not paid, nothing posted, and the chain's figures say so.
    chain.creditAnother({ address, assetId: 'USDT', amount: amt('60'), confirmations: 12, txHash: '0xpart1' });
    expect((await pay.authorize(payment.id)).status).toBe('created');
    expect(posts).toHaveLength(0);
    let funds = await outsideFundsOf(sql, ownerOf(m.id));
    expect(funds.rows).toEqual([
      expect.objectContaining({ assetId: 'USDT', holder: 'own_wallet', source: 'chain', clearing: '0', available: '60', payments: 1 }),
    ]);

    // The rest is sent and is still confirming: clearing, as the chain reports it.
    chain.creditAnother({ address, assetId: 'USDT', amount: amt('40'), confirmations: 2, txHash: '0xpart2' });
    expect((await pay.authorize(payment.id)).status).toBe('created');
    funds = await outsideFundsOf(sql, ownerOf(m.id));
    expect(funds.rows[0]).toMatchObject({ clearing: '40', available: '60' });

    // Final: the payment completes once, and only our fee is booked: 2.5% of 100, owed by the business.
    chain.setConfirmations(address, 12, '0xpart2');
    expect((await pay.authorize(payment.id)).status).toBe('authorized');
    expect((await pay.capture(payment.id)).status).toBe('captured');
    expect((await pay.capture(payment.id)).status).toBe('captured');
    expect(posts.map((p) => p.idempotencyKey)).toEqual([`merchant-fee:earned:pay:${payment.id}`]);
    expect(posts[0]!.reason).toBe('merchant_fee.earned');
    expect(formatAmount((await ledger.balance(houseFees('pay', 'USDT'))).amount)).toBe('2.5');
    expect(formatAmount((await ledger.balance(merchantFeeReceivableAccount('pay', m.id, 'USDT'))).amount)).toBe('-2.5');
    // The payer's money never entered our book.
    expect(formatAmount((await ledger.balance(merchantClearing(m.id, 'USDT'))).amount)).toBe('0');
    funds = await outsideFundsOf(sql, ownerOf(m.id));
    expect(funds.rows[0]).toMatchObject({ clearing: '0', available: '100', payments: 1 });

    // Nothing here settles or refunds it: the money is in the business's own wallet.
    await expect(
      pay.settleWindow({ merchantId: m.id, window: 'w-test', assetId: 'USDT', from: new Date(0), to: new Date(Date.now() + 60_000) }),
    ).rejects.toMatchObject({ code: 'pay.nothing_to_settle' });
    expect(posts.filter((p) => p.idempotencyKey.startsWith('settlement:'))).toHaveLength(0);
    await expect(pay.refund(payment.id, amt('10'), { refundId: 'r-test' })).rejects.toMatchObject({
      code: 'pay.payment_not_in_our_custody',
    });
    expect(posts).toHaveLength(1);
  });

  it('with the custodial layer on, the same checkout is the custodial one, unchanged', async () => {
    const pay = service({ custodyLayer: 'on' });
    const m = await business(pay);
    const link = await pay.createPaymentLink({ merchantId: m.id, label: 'TEST custodial', amount: amt('25'), currency: 'USDT' });
    const { session, sessionToken } = await pay.openCheckoutSession({ linkToken: link.token, geoCountry: 'DE', method: 'crypto' });
    const payment = await paymentOf(sessionToken);
    expect(payment.custody).toBe('platform');
    expect(session.instruction!.reference).toBe(await chain.acceptanceAddress(payment.id, 'USDT'));
  });

  it('a bank transfer goes to the partner: our fee is owed by the partner, once, and the payer’s money is not booked', async () => {
    const pay = service();
    const m = await business(pay);
    const link = await pay.createPaymentLink({ merchantId: m.id, label: 'TEST bank', amount: amt('30'), currency: 'EUR' });
    const { session, sessionToken } = await pay.openCheckoutSession({
      linkToken: link.token,
      geoCountry: 'DE',
      method: 'bank_transfer',
      payerName: 'Grace Hopper',
    });
    const ref = session.instruction!.reference;
    const payment = await paymentOf(sessionToken);
    expect(payment.custody).toBe('partner');
    // The TEST partner bank books the transfer and reports it, signed, as its webhook does; a resend changes nothing.
    const delivery = bank.signWebhook({ type: 'captured', assetId: 'EUR', id: 'bt-test-1', ref, amount: '30', payerName: 'Grace Hopper' });
    bank.receive(bank.verifyWebhook(delivery));
    await pay.handleWebhook(bank.id, delivery);
    await pay.handleWebhook(bank.id, delivery);
    expect((await paymentOf(sessionToken)).status).toBe('captured');
    expect(posts.map((p) => p.idempotencyKey)).toEqual([`partner-fee:earned:bank-transfer-sandbox:${payment.id}`]);
    expect(formatAmount((await ledger.balance(partnerFeeReceivableAccount('bank-transfer-sandbox', 'EUR'))).amount)).toBe('-0.75');
    expect(formatAmount((await ledger.balance(merchantClearing(m.id, 'EUR'))).amount)).toBe('0');
    const funds = await outsideFundsOf(sql, ownerOf(m.id));
    expect(funds.rows).toEqual([expect.objectContaining({ assetId: 'EUR', holder: 'partner', source: 'partner', available: '30' })]);
  });
});
