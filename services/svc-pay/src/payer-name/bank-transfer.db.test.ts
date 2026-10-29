import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, formatAmount, merchantClearing, parseAmount as amt } from '@intafaced/ledger-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { PayService } from '../payment-service.js';
import { RailRegistry } from '../rails/registry.js';
import { CryptoNativeAdapter } from '../rails/crypto-native.js';
import { MemoryChain } from '../rails/chain-port.js';
import { BankPayoutAbsentAdapter } from '../rails/bank-payout.js';
import { BankTransferSandboxAdapter, bankTransferReference } from '../rails/bank-transfer-sandbox.js';
import { signPayload } from '../rails/webhook-signature.js';
import { REFERENCE_RAIL_ROUTING_PROFILES } from '../routing/decide.js';
import type { PayerNameMatchRule } from './match.js';

/**
 * A bank transfer at hosted checkout, end to end against Postgres (J-merchant-04 step 6, RC-merchant-09): the payer
 * gives the name on their bank account, the TEST bank reports the transfer and the name it came from, and the core
 * captures it only when the names pass the owner's rule. Otherwise the payment is held for review: still `created`,
 * nothing authorized or captured, nothing posted. All amounts are TEST.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(drizzleDir, file), 'utf8'));

const SECRET = 'svc-pay-test-secret-at-least-32-characters';

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_bank_transfer_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

async function refusal(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (error) {
    const err = error as { code?: string; detail?: unknown };
    return { code: err.code, detail: err.detail };
  }
  throw new Error('expected a refusal');
}

describe(
  'a bank transfer at hosted checkout is captured only when the name it came from passes (J-merchant-04 step 6)',
  { timeout: 30_000 },
  () => {
    let adminStop: () => Promise<void> = async () => undefined;
    let db: TestDatabase | undefined;
    let sql!: Sql;
    const ledger = new MemoryLedger();
    const chain = new MemoryChain();
    const crypto = new CryptoNativeAdapter({ chain, secret: SECRET, minConfirmations: 6, toleranceSeconds: 300 });
    const bank = new BankTransferSandboxAdapter({ secret: SECRET, toleranceSeconds: 300 });
    const rails = new RailRegistry([crypto, new BankPayoutAbsentAdapter(), bank]);

    const service = (rule: PayerNameMatchRule | null) =>
      new PayService(sql, ledger, rails, {
        checkoutRails: [
          { railId: 'crypto-native', method: 'crypto' },
          { railId: 'bank-transfer-sandbox', method: 'bank_transfer' },
        ],
        checkoutRiskBand: 'low',
        routingProfiles: REFERENCE_RAIL_ROUTING_PROFILES.map((p) => ({ ...p, successRate: '0.9' })),
        linkDefaultTtlDays: 30,
        linkMaxTtlDays: 365,
        checkoutSessionTtlSeconds: 900,
        maxOpenSessionsPerLink: 25,
        payerNameMatchRule: rule,
      });

    /** A fresh business and a TEST 30 EUR link. */
    async function eurLink(pay: PayService, amount = '30') {
      const m = await pay.createMerchant({ userId: randomUUID(), pricing: { feeBps: 0 } });
      return {
        merchantId: m.id,
        link: await pay.createPaymentLink({ merchantId: m.id, label: 'TEST invoice', amount: amt(amount), currency: 'EUR' }),
      };
    }

    /** The TEST bank reports a transfer, as its webhook does: booked at the bank, then applied by the core. */
    async function transfer(pay: PayService, body: { id: string; ref: string; amount: string; payerName?: string }) {
      const delivery = bank.signWebhook({ type: 'captured', assetId: 'EUR', ...body });
      bank.receive(bank.verifyWebhook(delivery));
      return pay.handleWebhook(bank.id, delivery);
    }

    const paymentOf = async (paymentId: string) =>
      (
        await sql<Array<{ status: string; method: string; rail_ref: string | null }>>`
      SELECT status, method, rail_ref FROM pay.payments WHERE id = ${paymentId}`
      )[0]!;
    const sessionPayment = async (sessionToken: string) => {
      const [row] = await sql<Array<{ payment_id: string }>>`
      SELECT payment_id FROM pay.checkout_sessions WHERE token_prefix = ${sessionToken.slice(0, 10)} ORDER BY created_at DESC LIMIT 1`;
      return row!.payment_id;
    };
    const clearing = async (merchantId: string) => formatAmount((await ledger.balance(merchantClearing(merchantId, 'EUR'))).amount);

    beforeAll(async () => {
      const opened = await openAdmin();
      adminStop = opened.stop;
      db = await createTestDatabase({ service: 'pay', url: opened.url, migrations });
      sql = db.sql;
    }, 180_000);

    afterAll(async () => {
      await db?.drop();
      await adminStop();
    });

    it('opens a bank transfer only with the name on the payer bank account, and writes nothing without it', async () => {
      const pay = service('exact_normalised');
      const { link } = await eurLink(pay);
      const before = (await sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM pay.payments`)[0]!.n;
      for (const payerName of [undefined, '', '   ', '!!!', 'x'.repeat(141)])
        expect(await refusal(() => pay.openCheckoutSession({ linkToken: link.token, geoCountry: 'DE', payerName }))).toMatchObject({
          code: 'pay.payer_name_required',
        });
      expect((await sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM pay.payments`)[0]!.n).toBe(before);

      const opened = await pay.openCheckoutSession({ linkToken: link.token, geoCountry: 'DE', payerName: '  Ada   Lovelace ' });
      const paymentId = await sessionPayment(opened.sessionToken);
      expect(opened.session.method).toBe('bank_transfer');
      expect(opened.session.instruction).toEqual({
        reference: bankTransferReference(paymentId),
        amount: formatAmount(amt('30')),
        currency: 'EUR',
      });
      expect((await sql`SELECT given_name FROM pay.payer_names WHERE payment_id = ${paymentId}`)[0]).toEqual({
        given_name: 'Ada Lovelace',
      });
    });

    it('holds a transfer from another name for review: nothing authorized, captured or posted, and no name in the events', async () => {
      const pay = service('exact_normalised');
      const { merchantId, link } = await eurLink(pay);
      const opened = await pay.openCheckoutSession({ linkToken: link.token, geoCountry: 'DE', payerName: 'Ada Lovelace' });
      const paymentId = await sessionPayment(opened.sessionToken);
      const ref = opened.session.instruction!.reference;

      const outcome = await transfer(pay, { id: 'tr-mismatch-1', ref, amount: '30', payerName: 'A LOVELACE' });
      expect(outcome).toMatchObject({ duplicate: false, applied: true, paymentId });
      expect(await paymentOf(paymentId)).toMatchObject({ status: 'created' });
      expect(await clearing(merchantId)).toBe(formatAmount(0n));
      expect(
        await sql`SELECT reason, rule, received_names, amount::text, currency, status FROM pay.payer_name_holds WHERE payment_id = ${paymentId}`,
      ).toEqual([
        {
          reason: 'pay.payer_name_mismatch',
          rule: 'exact_normalised',
          received_names: ['A LOVELACE'],
          amount: '30.000000000000000000',
          currency: 'EUR',
          status: 'held',
        },
      ]);
      const events = await sql<Array<{ event: string; payload: Record<string, unknown> }>>`
      SELECT event, payload FROM pay.payment_events WHERE payment_id = ${paymentId} ORDER BY seq`;
      expect(events.map((e) => e.event)).toEqual([
        'created',
        'rail.selected',
        'rail.authorize',
        'rail.pending',
        'rail.authorize',
        'payer_name.held',
        'webhook.captured',
      ]);
      expect(events.find((e) => e.event === 'payer_name.held')?.payload).toEqual({
        reason: 'pay.payer_name_mismatch',
        rule: 'exact_normalised',
        amount: '30',
        currency: 'EUR',
        transfers: 1,
      });
      expect(JSON.stringify(events)).not.toMatch(/lovelace/i);

      // The payer reads that it arrived and is being checked; nothing asks them to send more.
      expect(await pay.getCheckoutSession(opened.sessionToken)).toMatchObject({ status: 'open', heldForReview: true, progress: null });

      // The same delivery again changes nothing, and no other door takes the money in while the hold is open.
      expect(await transfer(pay, { id: 'tr-mismatch-1', ref, amount: '30', payerName: 'A LOVELACE' })).toMatchObject({ duplicate: true });
      expect(await refusal(() => pay.authorize(paymentId))).toMatchObject({
        code: 'pay.payer_name_held',
        detail: { reason: 'pay.payer_name_mismatch' },
      });
      // A later transfer from the right name to the same reference does not lift the hold: the review decides.
      expect(await transfer(pay, { id: 'tr-mismatch-2', ref, amount: '30', payerName: 'Ada Lovelace' })).toMatchObject({ applied: true });
      expect(await paymentOf(paymentId)).toMatchObject({ status: 'created' });
      expect(await clearing(merchantId)).toBe(formatAmount(0n));
      expect((await sql`SELECT count(*)::int AS n FROM pay.payer_name_holds WHERE payment_id = ${paymentId}`)[0]).toEqual({ n: 1 });
    });

    it('captures a transfer from the same name once, into the business clearing', async () => {
      const pay = service('exact_normalised');
      const { merchantId, link } = await eurLink(pay);
      const opened = await pay.openCheckoutSession({ linkToken: link.token, geoCountry: 'DE', payerName: 'Adá Lovelace' });
      const paymentId = await sessionPayment(opened.sessionToken);
      const ref = opened.session.instruction!.reference;

      await transfer(pay, { id: 'tr-match-1', ref, amount: '30', payerName: 'ADA LOVELACE' });
      expect(await paymentOf(paymentId)).toMatchObject({ status: 'captured' });
      expect(await clearing(merchantId)).toBe(formatAmount(amt('30')));
      expect(await transfer(pay, { id: 'tr-match-1', ref, amount: '30', payerName: 'ADA LOVELACE' })).toMatchObject({ duplicate: true });
      expect(await clearing(merchantId)).toBe(formatAmount(amt('30')));
      expect((await sql`SELECT count(*)::int AS n FROM pay.payer_name_holds WHERE payment_id = ${paymentId}`)[0]).toEqual({ n: 0 });
      expect(await pay.getCheckoutSession(opened.sessionToken)).toMatchObject({ status: 'completed' });
    });

    it('holds every transfer while the owner has set no rule, and one whose bank reported no name', async () => {
      const unset = service(null);
      const a = await eurLink(unset);
      const openedA = await unset.openCheckoutSession({ linkToken: a.link.token, geoCountry: 'DE', payerName: 'Ada Lovelace' });
      await transfer(unset, { id: 'tr-unset-1', ref: openedA.session.instruction!.reference, amount: '30', payerName: 'Ada Lovelace' });
      const paymentA = await sessionPayment(openedA.sessionToken);
      expect((await sql`SELECT reason, rule FROM pay.payer_name_holds WHERE payment_id = ${paymentA}`)[0]).toEqual({
        reason: 'pay.name_match_rule_unset',
        rule: null,
      });
      expect(await paymentOf(paymentA)).toMatchObject({ status: 'created' });

      const pay = service('exact_normalised');
      const b = await eurLink(pay);
      const openedB = await pay.openCheckoutSession({ linkToken: b.link.token, geoCountry: 'DE', payerName: 'Ada Lovelace' });
      await transfer(pay, { id: 'tr-noname-1', ref: openedB.session.instruction!.reference, amount: '30' });
      const paymentB = await sessionPayment(openedB.sessionToken);
      // Stored as SQL NULL, not as a name (the driver reads a NULL array element back as the text "NULL").
      expect(
        (
          await sql`SELECT reason, cardinality(received_names) AS n, received_names[1] IS NULL AS no_name
                      FROM pay.payer_name_holds WHERE payment_id = ${paymentB}`
        )[0],
      ).toEqual({ reason: 'pay.payer_name_missing', n: 1, no_name: true });
      expect(await clearing(b.merchantId)).toBe(formatAmount(0n));
    });

    it('holds a part paid from another name at once, before the rest arrives', async () => {
      const pay = service('exact_normalised');
      const { merchantId, link } = await eurLink(pay);
      const opened = await pay.openCheckoutSession({ linkToken: link.token, geoCountry: 'DE', payerName: 'Ada Lovelace' });
      const ref = opened.session.instruction!.reference;
      // The first part is from the right name: still pending, nothing taken.
      expect(await transfer(pay, { id: 'tr-part-1', ref, amount: '10', payerName: 'Ada Lovelace' })).toMatchObject({ applied: false });
      // The second part is from someone else: held, nothing taken, though together they cover it.
      await transfer(pay, { id: 'tr-part-2', ref, amount: '20', payerName: 'Charles Babbage' });
      const paymentId = await sessionPayment(opened.sessionToken);
      expect(await paymentOf(paymentId)).toMatchObject({ status: 'created' });
      // The hold records everything that arrived and whose accounts it came from.
      expect((await sql`SELECT reason, amount::text, received_names FROM pay.payer_name_holds WHERE payment_id = ${paymentId}`)[0]).toEqual(
        {
          reason: 'pay.payer_name_mismatch',
          amount: '30.000000000000000000',
          received_names: ['Ada Lovelace', 'Charles Babbage'],
        },
      );
      expect(await clearing(merchantId)).toBe(formatAmount(0n));
    });

    it('never counts a transfer from another name in with a later one from the right name, even when its own delivery failed', async () => {
      const pay = service('exact_normalised');
      const { merchantId, link } = await eurLink(pay);
      const opened = await pay.openCheckoutSession({ linkToken: link.token, geoCountry: 'DE', payerName: 'Ada Lovelace' });
      const ref = opened.session.instruction!.reference;
      // The bank books 20 from Mallory, but its delivery never reaches the core (it failed, or is still in flight).
      bank.receive(
        bank.verifyWebhook(
          bank.signWebhook({ type: 'captured', assetId: 'EUR', id: 'tr-race-1', ref, amount: '20', payerName: 'Mallory' }),
        ),
      );
      // Then 10 from the given name arrives and is delivered. Together they cover the payment: it is held, not taken in.
      expect(await transfer(pay, { id: 'tr-race-2', ref, amount: '10', payerName: 'Ada Lovelace' })).toMatchObject({ applied: true });
      const paymentId = await sessionPayment(opened.sessionToken);
      expect(await paymentOf(paymentId)).toMatchObject({ status: 'created' });
      expect(await clearing(merchantId)).toBe(formatAmount(0n));
      expect((await sql`SELECT reason FROM pay.payer_name_holds WHERE payment_id = ${paymentId}`)[0]).toEqual({
        reason: 'pay.payer_name_mismatch',
      });
      // Mallory's delivery arriving late is handled as held, and still takes nothing in.
      expect(await transfer(pay, { id: 'tr-race-1', ref, amount: '20', payerName: 'Mallory' })).toMatchObject({ applied: true });
      expect(await paymentOf(paymentId)).toMatchObject({ status: 'created' });
    });

    it('stops showing the payer a check once the bank fails the payment it held', async () => {
      const pay = service('exact_normalised');
      const { link } = await eurLink(pay);
      const opened = await pay.openCheckoutSession({ linkToken: link.token, geoCountry: 'DE', payerName: 'Ada Lovelace' });
      const ref = opened.session.instruction!.reference;
      await transfer(pay, { id: 'tr-failed-1', ref, amount: '30', payerName: 'Mallory' });
      expect(await pay.getCheckoutSession(opened.sessionToken)).toMatchObject({ heldForReview: true });
      await pay.handleWebhook(bank.id, bank.signWebhook({ type: 'failed', id: 'tr-failed-2', ref }));
      expect(await paymentOf(await sessionPayment(opened.sessionToken))).toMatchObject({ status: 'failed' });
      expect((await pay.getCheckoutSession(opened.sessionToken)).heldForReview).toBeUndefined();
    });

    it('checks the name on the rail, not the method string: a payment opened by API on the TEST bank with no name given is held', async () => {
      const pay = service('exact_normalised');
      const { merchantId } = await eurLink(pay);
      const created = await pay.createPayment({
        merchantId,
        amount: amt('30'),
        assetId: 'EUR',
        method: 'transfer',
        railAdapter: 'bank-transfer-sandbox',
      });
      const pending = await pay.authorize(created.id);
      expect(pending.status).toBe('created');
      await transfer(pay, { id: 'tr-api-1', ref: pending.railRef!, amount: '30', payerName: 'Ada Lovelace' });
      expect(await paymentOf(created.id)).toMatchObject({ status: 'created' });
      expect((await sql`SELECT reason FROM pay.payer_name_holds WHERE payment_id = ${created.id}`)[0]).toEqual({
        reason: 'pay.payer_name_missing',
      });
      expect(await clearing(merchantId)).toBe(formatAmount(0n));
    });

    it('a business that never saved its methods: a USDT link opens on crypto and a EUR link on bank transfer, without a method named', async () => {
      const pay = service('exact_normalised');
      const m = await pay.createMerchant({ userId: randomUUID(), pricing: { feeBps: 0 } });
      const usdt = await pay.createPaymentLink({ merchantId: m.id, label: 'TEST USDT', amount: amt('7'), currency: 'USDT' });
      expect((await pay.openCheckoutSession({ linkToken: usdt.token, geoCountry: 'DE' })).session.method).toBe('crypto');
      const eur = await pay.createPaymentLink({ merchantId: m.id, label: 'TEST EUR', amount: amt('7'), currency: 'EUR' });
      expect(await refusal(() => pay.openCheckoutSession({ linkToken: eur.token, geoCountry: 'DE' }))).toMatchObject({
        code: 'pay.payer_name_required',
      });
      expect((await pay.openCheckoutSession({ linkToken: eur.token, geoCountry: 'DE', payerName: 'Ada Lovelace' })).session.method).toBe(
        'bank_transfer',
      );
    });

    /**
     * A TEST category in the owner's table, chosen by this business, as the founders' two-person edit and the business's
     * choice write them (J-merchant-02 #7 adds a restricted one on the stack). A restricted one has its reserve set.
     */
    const chooseTestCategory = async (merchantId: string, cls: 'permissionless' | 'restricted') => {
      const key = `test-${cls}-${randomUUID().slice(0, 8)}`;
      const reserve = cls === 'restricted' ? { percent: '5', holdDays: 90 } : null;
      const after = { key, label: 'TEST category', class: cls, reserve };
      await sql.begin(async (tx) => {
        await tx`
          INSERT INTO pay.business_categories (key, label, class, reserve_percent, reserve_hold_days, version, updated_by, approved_by)
          VALUES (${key}, 'TEST category', ${cls}, ${reserve?.percent ?? null}, ${reserve?.holdDays ?? null}, 1, 'founder-a', 'founder-b')`;
        await tx`
          INSERT INTO pay.business_category_events (key, actor_id, approver_id, before, after, reason)
          VALUES (${key}, 'founder-a', 'founder-b', NULL, ${tx.json(after)}, 'TEST category')`;
        const [{ version }] = await tx<Array<{ version: string }>>`SELECT count(*)::text AS version FROM pay.business_category_events`;
        await tx`
          INSERT INTO pay.merchant_categories (merchant_id, category_key, table_version, chosen_by)
          VALUES (${merchantId}, ${key}, ${version}, ${merchantId})`;
        await tx`
          INSERT INTO pay.merchant_category_events (merchant_id, category_key, table_version, actor_id)
          VALUES (${merchantId}, ${key}, ${version}, ${merchantId})`;
      });
    };

    it('a business whose category takes crypto only and that never saved its methods opens a USDT link on crypto and refuses a EUR one', async () => {
      const pay = service('exact_normalised');
      const m = await pay.createMerchant({ userId: randomUUID(), pricing: { feeBps: 0 } });
      // A permissionless category takes crypto-native only.
      await chooseTestCategory(m.id, 'permissionless');
      const usdt = await pay.createPaymentLink({ merchantId: m.id, label: 'TEST USDT', amount: amt('7'), currency: 'USDT' });
      const opened = await pay.openCheckoutSession({ linkToken: usdt.token, geoCountry: 'DE' });
      expect(opened.session.method).toBe('crypto');
      expect((await paymentOf(await sessionPayment(opened.sessionToken))).method).toBe('crypto');

      // A EUR link has no method the category leaves for euros, so it refuses by name rather than open a crypto payment;
      // a bank transfer the payer names refuses by the category's name. Neither writes anything.
      const eur = await pay.createPaymentLink({ merchantId: m.id, label: 'TEST EUR', amount: amt('7'), currency: 'EUR' });
      const before = (await sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM pay.payments`)[0]!.n;
      expect(
        await refusal(() =>
          pay.openCheckoutSession({ linkToken: eur.token, geoCountry: 'DE', method: 'bank_transfer', payerName: 'Ada Lovelace' }),
        ),
      ).toMatchObject({ code: 'pay.category_rail_refused', detail: { allowed: ['crypto-native'] } });
      expect(await refusal(() => pay.openCheckoutSession({ linkToken: eur.token, geoCountry: 'DE' }))).toMatchObject({
        code: 'pay.checkout_no_method',
      });
      expect((await sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM pay.payments`)[0]!.n).toBe(before);
    });

    it('a restricted category drops only card rails: a fiat link still opens on a bank transfer, a crypto one on crypto', async () => {
      const pay = service('exact_normalised');
      const m = await pay.createMerchant({ userId: randomUUID(), pricing: { feeBps: 0 } });
      await chooseTestCategory(m.id, 'restricted');
      const usdt = await pay.createPaymentLink({ merchantId: m.id, label: 'TEST USDT', amount: amt('7'), currency: 'USDT' });
      expect((await pay.openCheckoutSession({ linkToken: usdt.token, geoCountry: 'DE' })).session.method).toBe('crypto');
      // J-merchant-04 #6: the EUR link asks for the bank account's name, so the payment is a bank transfer.
      const eur = await pay.createPaymentLink({ merchantId: m.id, label: 'TEST EUR', amount: amt('7'), currency: 'EUR' });
      expect(await refusal(() => pay.openCheckoutSession({ linkToken: eur.token, geoCountry: 'DE' }))).toMatchObject({
        code: 'pay.payer_name_required',
      });
      const opened = await pay.openCheckoutSession({ linkToken: eur.token, geoCountry: 'DE', payerName: 'Ada Lovelace' });
      expect(opened.session.method).toBe('bank_transfer');
      expect((await paymentOf(await sessionPayment(opened.sessionToken))).method).toBe('bank_transfer');
    });

    it('refuses a forged delivery before it reaches the bank or the payment', async () => {
      const pay = service('exact_normalised');
      const { link } = await eurLink(pay);
      const opened = await pay.openCheckoutSession({ linkToken: link.token, geoCountry: 'DE', payerName: 'Ada Lovelace' });
      const body = JSON.stringify({
        id: 'tr-forged',
        type: 'captured',
        ref: opened.session.instruction!.reference,
        amount: '30',
        assetId: 'EUR',
      });
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const forged = {
        headers: {
          'x-bank-signature': signPayload('not-the-secret-at-least-32-characters!!', timestamp, body),
          'x-bank-timestamp': timestamp,
        },
        body,
      };
      expect(bank.receive(bank.verifyWebhook(forged))).toBe(false);
      expect(await refusal(() => pay.handleWebhook(bank.id, forged))).toMatchObject({ code: 'pay.webhook_invalid' });
    });
  },
);
