/**
 * Add money (BK-xfer-04, BK-xfer-05, J-bank-02) through the mounted router: the ways to pay with their quotes or the reason
 * there is none, and the requests, kept whether the rail opens or refuses them. The partner and the rate source here are
 * labelled TEST fixtures. Nothing on these doors posts to the ledger. Uses TEST_DATABASE_URL. Does not start Docker.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, parseAmount } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { memoryLedgerHistory } from '../analytics/ledger-history.js';
import { createBankServices, type BankServices } from '../bank-service.js';
import { createBankRouter } from '../router.js';
import type { OnrampPaymentPort, OnrampQuoteSource } from './customer-ports.js';
import type { PayFiatRampPort } from './pay-fiat-adapter.js';
import { CRYPTO_LEDGER_PROGRAMME, NO_RAMP_PROGRAMME } from './rails.js';
import { onrampSim } from './onramp-sim.js';
import { PAYIN_SIM_RAIL, payinSim } from './payin-sim.js';
import { TEST_PURCHASE_HOLD_DAYS, testPartner as testPartnerBank } from '../partner/test-partner.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { walletDeliveryMessage } from './add-money.js';
import { destinationSanctions, memorySanctions } from './sanctions-list.js';

const SECRET = 'bank-add-money-edge-secret-long-enough';
const ADA = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const IBAN = 'GB82WEST12345698765432';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(drizzle, file), 'utf8'));

const livePay: PayFiatRampPort = {
  listFiatRails: () => [{ railId: 'TEST-fiat-rail', mode: 'live', capabilities: ['onramp'] }],
};

/** TEST rate source: a fee and an estimate for bank transfer, no estimate for card, nothing at all for wallet. */
function testQuotes(): OnrampQuoteSource {
  return {
    async quote({ method }) {
      if (method === 'wallet_pay') return null;
      return {
        payAmount: '20.50',
        fee: method === 'card' ? '0.50' : '0',
        rate: '1',
        payCurrency: 'EUR',
        expiresAt: new Date(Date.now() + 10 * 60_000),
        deliveryEstimate: method === 'card' ? null : 'TEST 1 business day',
      };
    },
  };
}

/** TEST partner: bank details for a bank transfer, a hosted page for everything else. */
function testPartner(): OnrampPaymentPort & { opened: string[] } {
  const opened: string[] = [];
  return {
    opened,
    async open({ onrampId, method }) {
      opened.push(onrampId);
      return method === 'bank_transfer'
        ? { partnerRail: 'TEST-bank', bank: { reference: 'TEST-REF-1', accountName: 'TEST Account', accountRef: IBAN } }
        : { partnerRail: 'TEST-hosted', hostedUrl: `https://pay.example.test/${onrampId}` };
    },
  };
}

const codeOf = (err: unknown) => (err as { cause?: { code?: string } }).cause?.code;

describe('add money (J-bank-02)', () => {
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let ledger: MemoryLedger;
  const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-bank' });

  beforeAll(async () => {
    const raw = process.env.TEST_DATABASE_URL?.trim();
    if (!raw) throw new Error('TEST_DATABASE_URL is unset. This suite does not start Docker.');
    const url = new URL(raw);
    if (!url.pathname.replace(/^\//, '').endsWith('_test')) url.pathname = '/intafaced_test';
    db = await createTestDatabase({ service: 'bank', url: url.toString(), migrations });
    sql = db.sql;
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
  });

  beforeEach(async () => {
    await sql`TRUNCATE bank.add_money_requests, bank.customer_onramps, bank.ramp_onramp_quotes RESTART IDENTITY CASCADE`;
    ledger = new MemoryLedger();
  });

  type Options = NonNullable<Parameters<typeof createBankServices>[3]>;
  function as(userId: string, ramps: Options['ramps'] = {}, extra: Omit<Options, 'ramps'> = {}) {
    const bank = createBankServices(sql, ledger, memoryLedgerHistory(ledger), { ...extra, ramps });
    const raw = encodePrincipal({
      sub: userId,
      userId,
      sid: randomUUID(),
      scopes: ['bank:read', 'bank:write'],
      tier: 'full',
      mfa: true,
      expiresAt: new Date(Date.now() + 60_000),
    } as Principal);
    return createBankRouter(bank).createCaller(
      edgeContext({
        headers: {
          'x-intafaced-principal': raw,
          'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
          'x-intafaced-region': 'DE',
        },
        id: `req-${randomUUID()}`,
      }),
    );
  }

  const ask = { assetId: 'USDT', amount: '20', country: 'de' };
  const nothingPosted = () => expect(ledger.journal()).toHaveLength(0);

  describe('the ways to pay', () => {
    it('with no partner, every way names the rail it needs and the reason, and writes no quote', async () => {
      const { methods } = await as(ADA).addMoney.methods(ask);
      expect(methods).toEqual([
        { method: 'bank_transfer', rail: 'rail.bank', quote: null, blocker: 'bank.fiat_ramp_socket', standIn: null, payStandIn: null },
        { method: 'pay_by_bank', rail: 'rail.bank', quote: null, blocker: 'bank.fiat_ramp_socket', standIn: null, payStandIn: null },
        { method: 'card', rail: 'rail.card', quote: null, blocker: 'bank.fiat_ramp_socket', standIn: null, payStandIn: null },
        { method: 'wallet_pay', rail: 'rail.card', quote: null, blocker: 'bank.fiat_ramp_socket', standIn: null, payStandIn: null },
      ]);
      expect(await sql`SELECT 1 FROM bank.ramp_onramp_quotes`).toHaveLength(0);
    });

    it('with a rate source, each way has its own quote; a blank estimate stays blank and a missing quote says why', async () => {
      const { methods } = await as(ADA, {
        programme: CRYPTO_LEDGER_PROGRAMME,
        payFiat: livePay,
        onrampQuotes: testQuotes(),
      }).addMoney.methods(ask);
      const by = Object.fromEntries(methods.map((m) => [m.method, m]));
      expect(by.bank_transfer!.quote).toMatchObject({
        fee: '0',
        payAmount: '20.5',
        payCurrency: 'EUR',
        deliveryEstimate: 'TEST 1 business day',
      });
      expect(by.card!.quote).toMatchObject({ fee: '0.5', deliveryEstimate: null });
      expect(by.wallet_pay).toEqual({
        method: 'wallet_pay',
        rail: 'rail.card',
        quote: null,
        blocker: 'bank.onramp_rate_unset',
        standIn: null,
        payStandIn: null,
      });
    });

    it('a bad amount or country refuses the whole read rather than reading as a rail problem', async () => {
      for (const input of [
        { ...ask, amount: '0' },
        { ...ask, country: 'DEU' },
      ]) {
        expect(
          await as(ADA)
            .addMoney.methods(input)
            .catch((e: unknown) => e),
        ).toBeInstanceOf(Error);
      }
    });
  });

  describe('the TEST rate stand-in of the local stack (J-bank-02 #4)', () => {
    let clock = Date.now();
    const standIn = onrampSim(
      {
        label: 'TEST add-money stand-in',
        quoteValidSeconds: 30,
        quotes: [
          {
            country: 'NL',
            method: 'bank_transfer',
            asset: 'USDT',
            payCurrency: 'EUR',
            rate: '2',
            fee: '1',
            deliveryEstimate: 'TEST 1 day',
          },
        ],
      },
      () => new Date(clock),
    );
    const nl = { assetId: 'USDT', amount: '20', country: 'nl' };

    it('prices only what it lists, labelled TEST, and leaves every other way to pay refused as before', async () => {
      clock = Date.now();
      const { methods } = await as(ADA, { onrampStandIn: standIn }).addMoney.methods(nl);
      const by = Object.fromEntries(methods.map((m) => [m.method, m]));
      expect(by.bank_transfer).toMatchObject({
        quote: { payAmount: '41', fee: '1', rate: '2', payCurrency: 'EUR', deliveryEstimate: 'TEST 1 day', simulated: true },
        blocker: null,
        standIn: 'TEST add-money stand-in',
      });
      expect(by.card).toEqual({
        method: 'card',
        rail: 'rail.card',
        quote: null,
        blocker: 'bank.fiat_ramp_socket',
        standIn: null,
        payStandIn: null,
      });
      const de = await as(ADA, { onrampStandIn: standIn }).addMoney.methods(ask);
      expect(de.methods.every((m) => m.quote === null && m.blocker === 'bank.fiat_ramp_socket' && m.standIn === null)).toBe(true);
    });

    it('a quote accepted after it ran out is refused, keeps nothing and posts nothing', async () => {
      clock = Date.now();
      const ada = as(ADA, { onrampStandIn: standIn });
      const { methods } = await ada.addMoney.methods(nl);
      const quoteId = methods.find((m) => m.method === 'bank_transfer')!.quote!.quoteId;
      // The person waits on the review past the stand-in's 30 seconds.
      await sql`UPDATE bank.ramp_onramp_quotes SET expires_at = now() - interval '1 second' WHERE id = ${quoteId}::uuid`;
      const requestId = randomUUID();
      const err = await ada.addMoney.start({ requestId, ...nl, method: 'bank_transfer', quoteId }).catch((e: unknown) => e);
      expect(codeOf(err)).toBe('bank.onramp_quote_expired');
      expect(await ada.addMoney.requests({ limit: 10 })).toEqual([]);
      nothingPosted();
    });

    it('a quote accepted in time still ends with no partner to pay: refused with the rail, kept once, nothing posted', async () => {
      clock = Date.now();
      const ada = as(ADA, { onrampStandIn: standIn });
      const { methods } = await ada.addMoney.methods(nl);
      const quoteId = methods.find((m) => m.method === 'bank_transfer')!.quote!.quoteId;
      const row = await ada.addMoney.start({ requestId: randomUUID(), ...nl, method: 'bank_transfer', quoteId });
      expect(row).toMatchObject({ status: 'refused', rail: 'rail.bank', refusalCode: 'bank.fiat_ramp_socket', onramp: null });
      nothingPosted();
    });
  });

  describe('a request', () => {
    it('with no partner is refused with the rail and kept once, and posts nothing', async () => {
      const ada = as(ADA);
      const requestId = randomUUID();
      const first = await ada.addMoney.start({ requestId, ...ask, method: 'bank_transfer' });
      expect(first).toMatchObject({
        requestId,
        assetId: 'USDT',
        amount: '20',
        country: 'DE',
        method: 'bank_transfer',
        rail: 'rail.bank',
        status: 'refused',
        refusalCode: 'bank.fiat_ramp_socket',
        onramp: null,
      });
      // The same request again is the same row.
      expect(await ada.addMoney.start({ requestId, ...ask, amount: '20.000', method: 'bank_transfer' })).toEqual(first);
      expect(await ada.addMoney.requests({ limit: 10 })).toEqual([first]);
      nothingPosted();
    });

    it('opens with the partner: bank details for a bank transfer, a hosted page for pay by bank, once each', async () => {
      const partner = testPartner();
      const ada = as(ADA, { programme: CRYPTO_LEDGER_PROGRAMME, payFiat: livePay, onrampQuotes: testQuotes(), onrampPayments: partner });
      const transfer = await ada.addMoney.start({ requestId: randomUUID(), ...ask, method: 'bank_transfer' });
      expect(transfer).toMatchObject({ status: 'opened', refusalCode: null, rail: 'rail.bank' });
      expect(transfer.onramp).toMatchObject({
        status: 'pending_payment',
        payAmount: '20.5',
        hostedUrl: null,
        bankInstructions: { reference: 'TEST-REF-1', accountName: 'TEST Account', accountRef: IBAN },
      });

      const requestId = randomUUID();
      const { methods } = await ada.addMoney.methods(ask);
      const quoteId = methods.find((m) => m.method === 'pay_by_bank')!.quote!.quoteId;
      const redirect = await ada.addMoney.start({ requestId, ...ask, method: 'pay_by_bank', quoteId });
      // The same accepted quote, written in capitals, is still the same request.
      expect(await ada.addMoney.start({ requestId, ...ask, method: 'pay_by_bank', quoteId: quoteId.toUpperCase() })).toEqual(redirect);
      expect(redirect.onramp).toMatchObject({ hostedUrl: `https://pay.example.test/${requestId}`, bankInstructions: null });
      await ada.addMoney.start({ requestId, ...ask, method: 'pay_by_bank' });
      expect(partner.opened.filter((id) => id === requestId)).toHaveLength(1);
      expect((await ada.addMoney.requests({ limit: 10 })).map((r) => r.method)).toEqual(['pay_by_bank', 'bank_transfer']);
      nothingPosted();
    });

    it('an accepted quote that has expired is refused and keeps nothing', async () => {
      const ada = as(ADA, {
        programme: CRYPTO_LEDGER_PROGRAMME,
        payFiat: livePay,
        onrampQuotes: testQuotes(),
        onrampPayments: testPartner(),
      });
      const { methods } = await ada.addMoney.methods(ask);
      const quote = methods.find((m) => m.method === 'bank_transfer')!.quote!;
      await sql`UPDATE bank.ramp_onramp_quotes SET expires_at = now() - interval '1 second' WHERE id = ${quote.quoteId}::uuid`;
      const err = await ada.addMoney
        .start({ requestId: randomUUID(), ...ask, method: 'bank_transfer', quoteId: quote.quoteId })
        .catch((e: unknown) => e);
      expect(codeOf(err)).toBe('bank.onramp_quote_expired');
      expect(await ada.addMoney.requests({ limit: 10 })).toEqual([]);
      nothingPosted();
    });

    it("the same id on other terms, or by someone else, is a conflict, and requests are only ever the caller's own", async () => {
      const requestId = randomUUID();
      await as(ADA).addMoney.start({ requestId, ...ask, method: 'card' });
      for (const [who, input] of [
        [ADA, { requestId, ...ask, amount: '21', method: 'card' }],
        [ADA, { requestId, ...ask, method: 'wallet_pay' }],
        [BOB, { requestId, ...ask, method: 'card' }],
      ] as const) {
        expect(
          codeOf(
            await as(who)
              .addMoney.start(input)
              .catch((e: unknown) => e),
          ),
        ).toBe('bank.ramp_conflict');
      }
      expect(await as(BOB).addMoney.requests({ limit: 10 })).toEqual([]);
      expect(await as(ADA).addMoney.requests({ limit: 10 })).toHaveLength(1);
    });

    it("an accepted quote must be the caller's own and on the request's terms; otherwise nothing is kept or opened", async () => {
      const partner = testPartner();
      const ada = as(ADA, { programme: CRYPTO_LEDGER_PROGRAMME, payFiat: livePay, onrampQuotes: testQuotes(), onrampPayments: partner });
      const { methods } = await ada.addMoney.methods({ ...ask, amount: '1' });
      const quoteId = methods.find((m) => m.method === 'bank_transfer')!.quote!.quoteId;
      for (const input of [
        { ...ask, amount: '20' },
        { ...ask, amount: '1', assetId: 'USDC' },
        { ...ask, amount: '1', country: 'FR' },
      ]) {
        const err = await ada.addMoney
          .start({ requestId: randomUUID(), ...input, method: 'bank_transfer', quoteId })
          .catch((e: unknown) => e);
        expect(codeOf(err)).toBe('bank.ramp_conflict');
      }
      const bob = as(BOB, { programme: CRYPTO_LEDGER_PROGRAMME, payFiat: livePay, onrampQuotes: testQuotes(), onrampPayments: partner });
      const stolen = await bob.addMoney
        .start({ requestId: randomUUID(), ...ask, amount: '1', method: 'bank_transfer', quoteId })
        .catch((e: unknown) => e);
      expect(codeOf(stolen)).toBe('bank.onramp_quote_missing');
      expect(await sql`SELECT 1 FROM bank.add_money_requests`).toHaveLength(0);
      expect(partner.opened).toEqual([]);
      nothingPosted();
    });

    it('a zero amount is refused at the door, with or without a quote', async () => {
      const ada = as(ADA);
      for (const amount of ['0', '0.000']) {
        const err = await ada.addMoney
          .start({ requestId: randomUUID(), ...ask, amount, method: 'bank_transfer', quoteId: randomUUID() })
          .catch((e: unknown) => e);
        expect((err as { code?: string }).code).toBe('BAD_REQUEST');
      }
      expect(await sql`SELECT 1 FROM bank.add_money_requests`).toHaveLength(0);
    });

    it('is kept before the partner is called: a failed call leaves it opening in the list, and the same id opens it once', async () => {
      const partner = testPartner();
      let down = true;
      const flaky: OnrampPaymentPort = {
        async open(input) {
          if (down) throw new Error('partner unreachable');
          return partner.open(input);
        },
      };
      const ada = as(ADA, { programme: CRYPTO_LEDGER_PROGRAMME, payFiat: livePay, onrampQuotes: testQuotes(), onrampPayments: flaky });
      const requestId = randomUUID();
      await expect(ada.addMoney.start({ requestId, ...ask, method: 'bank_transfer' })).rejects.toThrow();
      expect(await ada.addMoney.requests({ limit: 10 })).toMatchObject([{ requestId, status: 'opening', refusalCode: null, onramp: null }]);

      down = false;
      const opened = await ada.addMoney.start({ requestId, ...ask, method: 'bank_transfer' });
      expect(opened).toMatchObject({ requestId, status: 'opened', onramp: { onrampId: requestId } });
      expect(await ada.addMoney.start({ requestId, ...ask, method: 'bank_transfer' })).toEqual(opened);
      expect(partner.opened).toEqual([requestId]);
      nothingPosted();
    });

    it('an instruction the partner already opened is picked up on retry, even after its quote expired', async () => {
      const partner = testPartner();
      const ada = as(ADA, { programme: CRYPTO_LEDGER_PROGRAMME, payFiat: livePay, onrampQuotes: testQuotes(), onrampPayments: partner });
      const requestId = randomUUID();
      await ada.addMoney.start({ requestId, ...ask, method: 'pay_by_bank' });
      // The crash this guards: the partner opened it and the request was never marked.
      await sql`UPDATE bank.add_money_requests SET status = 'opening', onramp_id = NULL WHERE id = ${requestId}::uuid`;
      await sql`UPDATE bank.ramp_onramp_quotes SET expires_at = now() - interval '1 second'`;
      const again = await ada.addMoney.start({ requestId, ...ask, method: 'pay_by_bank' });
      expect(again).toMatchObject({
        status: 'opened',
        onramp: { onrampId: requestId, hostedUrl: `https://pay.example.test/${requestId}` },
      });
      expect(partner.opened).toEqual([requestId]);
    });

    it('a request still opening whose quote ran out before any instruction is refused with the expiry', async () => {
      const partner = testPartner();
      let down = true;
      const flaky: OnrampPaymentPort = {
        async open(input) {
          if (down) throw new Error('partner unreachable');
          return partner.open(input);
        },
      };
      const ada = as(ADA, { programme: CRYPTO_LEDGER_PROGRAMME, payFiat: livePay, onrampQuotes: testQuotes(), onrampPayments: flaky });
      const requestId = randomUUID();
      await expect(ada.addMoney.start({ requestId, ...ask, method: 'card' })).rejects.toThrow();
      await sql`UPDATE bank.ramp_onramp_quotes SET expires_at = now() - interval '1 second'`;
      down = false;
      expect(await ada.addMoney.start({ requestId, ...ask, method: 'card' })).toMatchObject({
        status: 'refused',
        refusalCode: 'bank.onramp_quote_expired',
        onramp: null,
      });
      expect(partner.opened).toEqual([]);
    });

    it('a partner that answers with a broken instruction leaves the request opening, never refused as "no partner"', async () => {
      const broken: OnrampPaymentPort = { open: async () => ({ partnerRail: 'TEST-hosted', hostedUrl: 'http://not-https.example.test' }) };
      const ada = as(ADA, { programme: CRYPTO_LEDGER_PROGRAMME, payFiat: livePay, onrampQuotes: testQuotes(), onrampPayments: broken });
      const requestId = randomUUID();
      const err = await ada.addMoney.start({ requestId, ...ask, method: 'card' }).catch((e: unknown) => e);
      expect(codeOf(err)).toBe('bank.onramp_instruction_missing');
      expect(await ada.addMoney.requests({ limit: 10 })).toMatchObject([{ requestId, status: 'opening', refusalCode: null }]);
    });

    it('a programme with no ramp keeps the refusal even when a rate source exists', async () => {
      const ada = as(ADA, { programme: NO_RAMP_PROGRAMME, payFiat: livePay, onrampQuotes: testQuotes(), onrampPayments: testPartner() });
      const row = await ada.addMoney.start({ requestId: randomUUID(), ...ask, method: 'pay_by_bank' });
      expect(row).toMatchObject({ status: 'refused', rail: 'rail.bank', refusalCode: 'bank.fiat_ramp_socket' });
    });
  });
  describe('paid through the TEST pay-in stand-in of the local stack (J-bank-02 #3, #5)', () => {
    const rates = onrampSim({
      label: 'TEST add-money stand-in',
      quoteValidSeconds: 600,
      quotes: [
        { country: 'NL', method: 'pay_by_bank', asset: 'USDT', payCurrency: 'EUR', rate: '2', fee: '1', deliveryEstimate: null },
        { country: 'NL', method: 'bank_transfer', asset: 'USDT', payCurrency: 'EUR', rate: '2', fee: '1', deliveryEstimate: null },
      ],
    });
    const partner = payinSim(
      { label: 'TEST pay-in stand-in', methods: ['pay_by_bank'] },
      new URL('http://127.0.0.1:14999'),
      new URL('http://127.0.0.1:3210/bank/ramps/new'),
    );
    const nl = { assetId: 'USDT', amount: '12.345678', country: 'NL' };

    /** The customer's router and the bank's own services (the partner's job door and page call these), on one ledger. */
    function wired(userId: string) {
      const bank: BankServices = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
        ramps: { onrampStandIn: rates },
        onrampPartner: partner,
      });
      return { caller: as(userId, { onrampStandIn: rates }, { onrampPartner: partner }), bank };
    }

    async function opened(userId: string) {
      const { caller, bank } = wired(userId);
      const { methods } = await caller.addMoney.methods(nl);
      const quote = methods.find((m) => m.method === 'pay_by_bank')!.quote!;
      const request = await caller.addMoney.start({ requestId: randomUUID(), ...nl, method: 'pay_by_bank', quoteId: quote.quoteId });
      return { caller, bank, quote, request };
    }

    /** The person's available USDT on the ledger, in units. */
    const available = async (userId: string) =>
      (await ledger.balances('user', userId)).find((b) => b.account.kind === 'available' && b.account.assetId === 'USDT')?.amount ?? 0n;

    it('labels the way it opens, and opens it with the page the partner answered, posting nothing', async () => {
      const { caller, quote, request } = await opened(ADA);
      const { methods } = await caller.addMoney.methods(nl);
      const by = Object.fromEntries(methods.map((m) => [m.method, m]));
      expect(by.pay_by_bank).toMatchObject({ standIn: 'TEST add-money stand-in', payStandIn: 'TEST pay-in stand-in' });
      expect(by.bank_transfer).toMatchObject({ payStandIn: null });
      expect(quote).toMatchObject({ amount: '12.345678', payAmount: '25.691356', payCurrency: 'EUR' });
      expect(request).toMatchObject({
        status: 'opened',
        pendingAt: null,
        creditedAt: null,
        creditedAmount: null,
        onramp: {
          partnerRail: PAYIN_SIM_RAIL,
          hostedUrl: `http://127.0.0.1:14999/test/payin-sim/pay/${request.requestId}`,
          amount: '12.345678',
          payAmount: '25.691356',
        },
      });
      expect(request.openedAt).not.toBeNull();
      nothingPosted();
    });

    it('a bank transfer it does not open still ends with no partner: refused with the rail, nothing posted', async () => {
      const { caller } = wired(ADA);
      const { methods } = await caller.addMoney.methods(nl);
      const quoteId = methods.find((m) => m.method === 'bank_transfer')!.quote!.quoteId;
      const row = await caller.addMoney.start({ requestId: randomUUID(), ...nl, method: 'bank_transfer', quoteId });
      expect(row).toMatchObject({ status: 'refused', refusalCode: 'bank.fiat_ramp_socket', onramp: null });
      nothingPosted();
    });

    it('approved on the page is pending and sends the payer back; approving again changes nothing', async () => {
      const { caller, bank, request } = await opened(ADA);
      const first = await bank.addMoney.approved(request.requestId);
      expect(first.returnUrl).toBe(`http://127.0.0.1:3210/bank/ramps/new?request=${request.requestId}`);
      expect(first.request).toMatchObject({ status: 'pending', creditedAt: null });
      expect(first.approvedNow).toBe(true);
      const again = await bank.addMoney.approved(request.requestId);
      expect(again.request).toEqual(first.request);
      expect(again.approvedNow).toBe(false);
      // The customer's own read says the same (the router shows the customer's fields only).
      const { onramp: _approvedOnramp, ...approvedView } = first.request;
      expect(await caller.addMoney.request({ requestId: request.requestId })).toMatchObject(approvedView);
      nothingPosted();
    });

    it('paid credits the quote receive amount exactly, once, through the deposit recipe from its rail', async () => {
      const { caller, bank, quote, request } = await opened(ADA);
      await bank.addMoney.approved(request.requestId);
      const paid = { requestId: request.requestId, paidAmount: quote.payAmount, payCurrency: 'EUR' };
      const first = await bank.addMoney.paid(paid);
      expect(first).toMatchObject({ status: 'credited', creditedAmount: quote.amount });
      for (const at of [first.createdAt, first.openedAt, first.pendingAt, first.creditedAt]) expect(at).not.toBeNull();
      // Credited once: the partner saying paid again, or from another replica, posts nothing more.
      const [second, third] = await Promise.all([bank.addMoney.paid(paid), bank.addMoney.paid(paid)]);
      expect(second).toEqual(first);
      expect(third).toEqual(first);
      const journal = ledger.journal();
      expect(journal).toHaveLength(1);
      expect(journal[0]).toMatchObject({
        idempotencyKey: `deposit:${PAYIN_SIM_RAIL}:add-money:${request.requestId}`,
        reason: 'deposit.credited',
      });
      // Invariant: the person gained the quote's receive amount to the last unit, and the book still replays to itself.
      expect(await available(ADA)).toBe(parseAmount(quote.amount));
      expect(journal[0]!.entries).toHaveLength(2);
      expect(ledger.reconcile()).toEqual({ ok: true });
      const { onramp: _creditedOnramp, ...creditedView } = first;
      expect(await caller.addMoney.request({ requestId: request.requestId })).toMatchObject(creditedView);
    });

    describe("to the person's own wallet (J-dex-protocol-05 #4)", () => {
      // Well-known public development keys (the first two accounts of common local EVM chains). They hold nothing; TEST only.
      const KEY = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
      const WALLET = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
      const STRANGER_KEY = '59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
      const TX = `0x${'ab'.repeat(32)}`;
      const clearList = memorySanctions([{ network: '*', address: '0x00000000000000000000000000000000005a1c7d' }]);

      /** What a wallet's `personal_sign` returns: the EIP-191 digest signed, as `r || s || v` with v 27/28. */
      function personalSign(message: string, keyHex: string): string {
        const encoder = new TextEncoder();
        const body = encoder.encode(message);
        const prefix = encoder.encode(`\x19Ethereum Signed Message:\n${body.length}`);
        const joined = new Uint8Array(prefix.length + body.length);
        joined.set(prefix);
        joined.set(body, prefix.length);
        const recovered = secp256k1.sign(keccak_256(joined), Buffer.from(keyHex, 'hex'), { prehash: false, format: 'recovered' });
        const out = new Uint8Array(65);
        out.set(recovered.subarray(1), 0);
        out[64] = recovered[0]! + 27;
        return `0x${Buffer.from(out).toString('hex')}`;
      }

      function wiredTo(userId: string, payments?: OnrampPaymentPort, sanctions = clearList) {
        const ramps = { onrampStandIn: rates, sanctions, ...(payments ? { onrampPayments: payments } : {}) };
        const bank: BankServices = createBankServices(sql, ledger, memoryLedgerHistory(ledger), { ramps, onrampPartner: partner });
        return { bank, caller: as(userId, ramps, { onrampPartner: partner }) };
      }

      async function toWallet(userId: string, payments?: OnrampPaymentPort) {
        const { bank, caller } = wiredTo(userId, payments);
        const { methods } = await caller.addMoney.methods(nl);
        const quote = methods.find((m) => m.method === 'pay_by_bank')!.quote!;
        const requestId = randomUUID();
        const walletSignature = personalSign(walletDeliveryMessage(requestId, WALLET), KEY);
        const request = await caller.addMoney.start({
          requestId,
          ...nl,
          method: 'pay_by_bank',
          quoteId: quote.quoteId,
          walletAddress: WALLET,
          walletSignature,
        });
        return { caller, bank, quote, request };
      }

      it('the message names the request and the wallet in lower case and says nothing moves', () => {
        expect(walletDeliveryMessage('AAAAAAAA-0000-4000-8000-000000000000', WALLET)).toBe(
          [
            'INTAFACED buy to wallet',
            'Request: aaaaaaaa-0000-4000-8000-000000000000',
            `Wallet: ${WALLET.toLowerCase()}`,
            'Signing this proves you control this wallet, so a purchase can be delivered to it. It moves no funds and approves nothing else.',
          ].join('\n'),
        );
      });

      it('a wallet the person has not signed for, or signed for another request, is refused before anything is kept', async () => {
        const { caller } = wiredTo(ADA);
        const requestId = randomUUID();
        const base = { requestId, ...nl, method: 'pay_by_bank' as const, walletAddress: WALLET };
        for (const walletSignature of [
          undefined,
          personalSign(walletDeliveryMessage(requestId, WALLET), STRANGER_KEY),
          personalSign(walletDeliveryMessage(randomUUID(), WALLET), KEY),
        ]) {
          const refused = await caller.addMoney
            .start({ ...base, ...(walletSignature ? { walletSignature } : {}) })
            .catch((e: unknown) => e);
          expect(codeOf(refused)).toBe('bank.wallet_delivery_unproven');
        }
        expect(await sql`SELECT 1 FROM bank.add_money_requests`).toHaveLength(0);
        expect(await sql`SELECT 1 FROM bank.customer_onramps`).toHaveLength(0);
        nothingPosted();
      });

      it('a wallet the sanctions list names, or any while the list is unset, is refused before anything is kept', async () => {
        const listed = memorySanctions([{ network: '*', address: WALLET }]);
        const codes: unknown[] = [];
        for (const sanctions of [listed, destinationSanctions(() => undefined)]) {
          const { caller } = wiredTo(ADA, undefined, sanctions);
          const requestId = randomUUID();
          const walletSignature = personalSign(walletDeliveryMessage(requestId, WALLET), KEY);
          const refused = await caller.addMoney
            .start({ requestId, ...nl, method: 'pay_by_bank', walletAddress: WALLET, walletSignature })
            .catch((e: unknown) => e);
          codes.push(codeOf(refused));
        }
        expect(codes).toEqual(['bank.destination_sanctions_listed', 'bank.destination_sanctions_unset']);
        expect(await sql`SELECT 1 FROM bank.add_money_requests`).toHaveLength(0);
        nothingPosted();
      });

      it('tells the partner the wallet, keeps it in lower case, and the TEST page names it; nothing is posted', async () => {
        const told: (string | undefined)[] = [];
        const spy: OnrampPaymentPort = {
          ...partner.payments,
          open: async (input) => {
            told.push(input.walletAddress);
            return partner.payments.open(input);
          },
        };
        const { bank, request } = await toWallet(ADA, spy);
        expect(told).toEqual([WALLET.toLowerCase()]);
        expect(request).toMatchObject({ status: 'opened', walletAddress: WALLET.toLowerCase(), deliveredAt: null, deliveryTx: null });
        const page = await bank.addMoney.opened(request.requestId);
        expect(page.request.walletAddress).toBe(WALLET.toLowerCase());
        nothingPosted();
      });

      it('paid with its on-chain transfer is delivered once, crediting nothing anywhere here', async () => {
        const { caller, bank, quote, request } = await toWallet(ADA);
        await bank.addMoney.approved(request.requestId);
        const paid = {
          requestId: request.requestId,
          paidAmount: quote.payAmount,
          payCurrency: 'EUR',
          deliveryTx: TX.toUpperCase().replace('0X', '0x'),
        };
        const first = await bank.addMoney.paid(paid);
        expect(first).toMatchObject({ status: 'delivered', deliveryTx: TX, creditedAt: null, creditedAmount: null, creditedBy: null });
        expect(first.deliveredAt).not.toBeNull();
        const [second, third] = await Promise.all([bank.addMoney.paid(paid), bank.addMoney.paid(paid)]);
        expect(second).toEqual(first);
        expect(third).toEqual(first);
        // Invariant: the ledger posts nothing and the person holds nothing here; the purchase is in their wallet.
        nothingPosted();
        expect(await available(ADA)).toBe(0n);
        const { onramp: _o, ...seen } = first;
        expect(await caller.addMoney.request({ requestId: request.requestId })).toMatchObject(seen);
      });

      it('paid without the transfer, or with no hash, is refused and changes nothing', async () => {
        const { caller, bank, quote, request } = await toWallet(ADA);
        const base = { requestId: request.requestId, paidAmount: quote.payAmount, payCurrency: 'EUR' };
        for (const bad of [base, { ...base, deliveryTx: '0x1234' }]) {
          expect(((await bank.addMoney.paid(bad).catch((e: unknown) => e)) as { code?: string }).code).toBe('bank.onramp_delivery_missing');
        }
        expect(await caller.addMoney.request({ requestId: request.requestId })).toMatchObject({ status: 'opened', deliveredAt: null });
        nothingPosted();
      });

      it('another transfer for a delivered purchase, or a transfer for a balance request, is a conflict', async () => {
        const { bank, quote, request } = await toWallet(ADA);
        const paid = { requestId: request.requestId, paidAmount: quote.payAmount, payCurrency: 'EUR', deliveryTx: TX };
        await bank.addMoney.paid(paid);
        const other = await bank.addMoney.paid({ ...paid, deliveryTx: `0x${'cd'.repeat(32)}` }).catch((e: unknown) => e);
        expect((other as { code?: string }).code).toBe('bank.ramp_conflict');
        const balance = await opened(BOB);
        const wrong = await balance.bank.addMoney
          .paid({ requestId: balance.request.requestId, paidAmount: balance.quote.payAmount, payCurrency: 'EUR', deliveryTx: TX })
          .catch((e: unknown) => e);
        expect((wrong as { code?: string }).code).toBe('bank.ramp_conflict');
        expect((await balance.caller.addMoney.request({ requestId: balance.request.requestId })).status).toBe('opened');
        nothingPosted();
      });

      it('a delivered purchase is never returned here, and the same id for a balance is a conflict', async () => {
        const { caller, bank, quote, request } = await toWallet(ADA);
        await bank.addMoney.paid({ requestId: request.requestId, paidAmount: quote.payAmount, payCurrency: 'EUR', deliveryTx: TX });
        const back = await bank.addMoney.returned({ requestId: request.requestId }).catch((e: unknown) => e);
        expect((back as { code?: string }).code).toBe('bank.ramp_conflict');
        const again = await caller.addMoney.start({ requestId: request.requestId, ...nl, method: 'pay_by_bank' }).catch((e: unknown) => e);
        expect(codeOf(again)).toBe('bank.ramp_conflict');
        nothingPosted();
      });

      it('refuses a wallet that is not an address before keeping anything', async () => {
        const { caller } = wiredTo(ADA);
        const bad = await caller.addMoney
          .start({ requestId: randomUUID(), ...nl, method: 'pay_by_bank', walletAddress: `0x${'0'.repeat(40)}` })
          .catch((e: unknown) => e);
        expect(codeOf(bad)).toBe('bank.ramp_invalid_destination');
        expect(await sql`SELECT 1 FROM bank.add_money_requests`).toHaveLength(0);
      });
    });

    it('a crash after the credit and before the row said so catches up on the next paid, crediting nothing twice', async () => {
      const { bank, quote, request } = await opened(ADA);
      const paid = { requestId: request.requestId, paidAmount: quote.payAmount, payCurrency: 'EUR' };
      await bank.addMoney.paid(paid);
      // As if the process died between the ledger post and the row's update.
      await sql`
        UPDATE bank.add_money_requests SET status = 'opened', credited_at = NULL, credited_amount = NULL, ledger_tx_id = NULL
         WHERE id = ${request.requestId}::uuid
      `;
      const again = await bank.addMoney.paid(paid);
      expect(again).toMatchObject({ status: 'credited', creditedAmount: quote.amount });
      expect(ledger.journal()).toHaveLength(1);
      expect(await available(ADA)).toBe(parseAmount(quote.amount));
    });

    it('paid in another amount or currency than the payment opened credits nothing', async () => {
      const { bank, quote, request } = await opened(ADA);
      for (const wrong of [
        { paidAmount: '25.691355', payCurrency: 'EUR' },
        { paidAmount: quote.payAmount, payCurrency: 'GBP' },
      ]) {
        const err = await bank.addMoney.paid({ requestId: request.requestId, ...wrong }).catch((e: unknown) => e);
        expect((err as { code?: string }).code).toBe('bank.onramp_paid_mismatch');
      }
      nothingPosted();
      expect((await bank.addMoney.opened(request.requestId)).request).toMatchObject({ status: 'opened' });
    });

    it('a refused request, an unknown id, or a request someone else asks for is never approved, credited or shown', async () => {
      const { caller, bank } = wired(ADA);
      const refused = await caller.addMoney.start({
        requestId: randomUUID(),
        assetId: 'USDT',
        amount: '20',
        country: 'DE',
        method: 'card',
      });
      expect(refused.status).toBe('refused');
      for (const call of [
        () => bank.addMoney.approved(refused.requestId),
        () => bank.addMoney.paid({ requestId: refused.requestId, paidAmount: '1', payCurrency: 'EUR' }),
      ]) {
        expect(((await call().catch((e: unknown) => e)) as { code?: string }).code).toBe('bank.ramp_conflict');
      }
      const missing = await bank.addMoney.approved(randomUUID()).catch((e: unknown) => e);
      expect((missing as { code?: string }).code).toBe('bank.add_money_request_missing');
      const { request } = await opened(ADA);
      expect(
        codeOf(
          await as(BOB)
            .addMoney.request({ requestId: request.requestId })
            .catch((e: unknown) => e),
        ),
      ).toBe('bank.add_money_request_missing');
      nothingPosted();
    });

    it('a bank transfer it gives bank details for opens with its own TEST reference and account, posting nothing (J-bank-02 #2)', async () => {
      const transfers = payinSim(
        {
          label: 'TEST pay-in stand-in',
          methods: ['pay_by_bank'],
          bankTransfer: { accountName: 'TEST pay-in stand-in account', accountRef: 'NL91 ABNA 0417 1643 00' },
        },
        new URL('http://127.0.0.1:14999'),
        new URL('http://127.0.0.1:3210/bank/ramps/new'),
      );
      const caller = as(ADA, { onrampStandIn: rates }, { onrampPartner: transfers });
      const { methods } = await caller.addMoney.methods(nl);
      const offered = methods.find((m) => m.method === 'bank_transfer')!;
      expect(offered.payStandIn).toBe('TEST pay-in stand-in');
      const requestId = randomUUID();
      const row = await caller.addMoney.start({ requestId, ...nl, method: 'bank_transfer', quoteId: offered.quote!.quoteId });
      expect(row).toMatchObject({
        status: 'opened',
        onramp: {
          partnerRail: PAYIN_SIM_RAIL,
          hostedUrl: null,
          bankInstructions: {
            reference: `TEST-${requestId.replace(/-/g, '').slice(0, 12).toUpperCase()}`,
            accountName: 'TEST pay-in stand-in account',
            accountRef: 'NL91ABNA0417164300',
          },
        },
      });
      // Asking again is the same request with the same reference: nothing opened twice.
      const again = await caller.addMoney.start({ requestId, ...nl, method: 'bank_transfer', quoteId: offered.quote!.quoteId });
      expect(again.onramp).toEqual(row.onramp);
      nothingPosted();
    });

    it('a payment the custodial layer credited on the ledger is never taken back here: refused, and the ledger posts nothing more', async () => {
      const { bank, quote, request } = await opened(ADA);
      await bank.addMoney.paid({ requestId: request.requestId, paidAmount: quote.payAmount, payCurrency: 'EUR' });
      const err = await bank.addMoney.returned({ requestId: request.requestId }).catch((e: unknown) => e);
      expect((err as { code?: string }).code).toBe('bank.ramp_conflict');
      expect(ledger.journal().map((tx) => tx.reason)).toEqual(['deposit.credited']);
      expect(await available(ADA)).toBe(parseAmount(quote.amount));
      expect((await bank.addMoney.opened(request.requestId)).request).toMatchObject({ status: 'credited', returnedAt: null });
    });

    it('a request not credited, refused or unknown is never returned, and nothing moves', async () => {
      const { caller, bank, request } = await opened(ADA);
      const refused = await caller.addMoney.start({
        requestId: randomUUID(),
        assetId: 'USDT',
        amount: '20',
        country: 'DE',
        method: 'card',
      });
      for (const id of [request.requestId, refused.requestId]) {
        expect(((await bank.addMoney.returned({ requestId: id }).catch((e: unknown) => e)) as { code?: string }).code).toBe(
          'bank.ramp_conflict',
        );
      }
      expect(((await bank.addMoney.returned({ requestId: randomUUID() }).catch((e: unknown) => e)) as { code?: string }).code).toBe(
        'bank.add_money_request_missing',
      );
      expect((await bank.addMoney.opened(request.requestId)).request).toMatchObject({ status: 'opened', returnedAt: null });
      nothingPosted();
    });

    it('with no pay-in partner wired, approving and paid refuse by name and nothing moves', async () => {
      const { request, quote } = await opened(ADA);
      const plain = createBankServices(sql, ledger, memoryLedgerHistory(ledger), { ramps: { onrampStandIn: rates } });
      for (const call of [
        () => plain.addMoney.approved(request.requestId),
        () => plain.addMoney.paid({ requestId: request.requestId, paidAmount: quote.payAmount, payCurrency: 'EUR' }),
      ]) {
        expect(((await call().catch((e: unknown) => e)) as { code?: string }).code).toBe('bank.fiat_ramp_socket');
      }
      nothingPosted();
    });

    describe('for a person whose money the partner holds (J-wallet-01 #3; OWNER 226)', () => {
      /** The same TEST partner bank behind the customer's router and the bank's own services, with ADA held at it. */
      function atPartner() {
        const tp = testPartnerBank();
        tp.set(ADA, { custody: 'off' });
        const extra = { onrampPartner: partner, testPartner: tp };
        const bank: BankServices = createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
          ramps: { onrampStandIn: rates },
          ...extra,
        });
        return { tp, bank, caller: as(ADA, { onrampStandIn: rates }, extra) };
      }

      it('paid is credited by the partner once, held back until its release time, and the ledger posts nothing', async () => {
        const { tp, bank, caller } = atPartner();
        tp.fund(ADA, { fundId: 'fund-ada-50', assetId: 'USDT', amount: parseAmount('50') });
        const { methods } = await caller.addMoney.methods(nl);
        const quote = methods.find((m) => m.method === 'pay_by_bank')!.quote!;
        const request = await caller.addMoney.start({ requestId: randomUUID(), ...nl, method: 'pay_by_bank', quoteId: quote.quoteId });
        await bank.addMoney.approved(request.requestId);
        const paid = { requestId: request.requestId, paidAmount: quote.payAmount, payCurrency: 'EUR' };
        const before = Date.now();
        const first = await bank.addMoney.paid(paid);
        expect(first).toMatchObject({ status: 'credited', creditedAmount: quote.amount, creditedBy: 'partner' });
        const [second, third] = await Promise.all([bank.addMoney.paid(paid), bank.addMoney.paid(paid)]);
        expect(second).toEqual(first);
        expect(third).toEqual(first);
        nothingPosted();
        // Invariant: the partner's balance gained the receive amount exactly, once, and it holds all of it back.
        const main = { userId: ADA, assetId: 'USDT', spaceId: null };
        expect((await tp.bank.balance(main)).amount).toBe(parseAmount('50') + parseAmount(quote.amount));
        const holds = await caller.partnerHolds();
        if (!holds.held) throw new Error('ADA is held at the partner');
        expect(holds).toMatchObject({ label: 'TEST partner bank', reported: true, released: [] });
        expect(holds.holds).toHaveLength(1);
        expect(holds.holds[0]).toMatchObject({ assetId: 'USDT', amount: quote.amount, paidBy: 'bank_pull' });
        const release = Date.parse(holds.holds[0]!.releaseAt);
        expect(release).toBeGreaterThanOrEqual(before + TEST_PURCHASE_HOLD_DAYS.bank_pull * 86_400_000);
        expect(holds.balances).toEqual([
          expect.objectContaining({ assetId: 'USDT', balance: '62.345678', heldBack: quote.amount, withdrawable: '50' }),
        ]);
      });

      it('a crash after the partner credited and before the row said so catches up, credited once', async () => {
        const { tp, bank, caller } = atPartner();
        const { methods } = await caller.addMoney.methods(nl);
        const quote = methods.find((m) => m.method === 'pay_by_bank')!.quote!;
        const request = await caller.addMoney.start({ requestId: randomUUID(), ...nl, method: 'pay_by_bank', quoteId: quote.quoteId });
        const paid = { requestId: request.requestId, paidAmount: quote.payAmount, payCurrency: 'EUR' };
        await bank.addMoney.paid(paid);
        await sql`
          UPDATE bank.add_money_requests
             SET status = 'opened', credited_at = NULL, credited_amount = NULL, partner_pay_in_ref = NULL
           WHERE id = ${request.requestId}::uuid
        `;
        expect(await bank.addMoney.paid(paid)).toMatchObject({ status: 'credited', creditedBy: 'partner' });
        expect((await tp.bank.balance({ userId: ADA, assetId: 'USDT', spaceId: null })).amount).toBe(parseAmount(quote.amount));
        nothingPosted();
      });

      it('the partner down credits nothing and leaves the request as it was, for its next paid', async () => {
        const { tp, bank, caller } = atPartner();
        const { methods } = await caller.addMoney.methods(nl);
        const quote = methods.find((m) => m.method === 'pay_by_bank')!.quote!;
        const request = await caller.addMoney.start({ requestId: randomUUID(), ...nl, method: 'pay_by_bank', quoteId: quote.quoteId });
        tp.set(ADA, { down: true });
        const paid = { requestId: request.requestId, paidAmount: quote.payAmount, payCurrency: 'EUR' };
        expect(((await bank.addMoney.paid(paid).catch((e: unknown) => e)) as { code?: string }).code).toBe('bank.partner_unavailable');
        expect(await caller.addMoney.request({ requestId: request.requestId })).toMatchObject({ status: 'opened', creditedBy: null });
        tp.set(ADA, { down: false });
        expect(await bank.addMoney.paid(paid)).toMatchObject({ status: 'credited', creditedBy: 'partner' });
        nothingPosted();
      });

      it('returned is taken back at the partner once, its hold goes, and the ledger posts nothing (J-bank-02 #7)', async () => {
        const { tp, bank, caller } = atPartner();
        tp.fund(ADA, { fundId: 'fund-ada-50r', assetId: 'USDT', amount: parseAmount('50') });
        const { methods } = await caller.addMoney.methods(nl);
        const quote = methods.find((m) => m.method === 'pay_by_bank')!.quote!;
        const request = await caller.addMoney.start({ requestId: randomUUID(), ...nl, method: 'pay_by_bank', quoteId: quote.quoteId });
        await bank.addMoney.paid({ requestId: request.requestId, paidAmount: quote.payAmount, payCurrency: 'EUR' });
        const first = await bank.addMoney.returned({ requestId: request.requestId });
        expect(first).toMatchObject({ status: 'returned', creditedBy: 'partner', creditedAmount: quote.amount });
        const [second, third] = await Promise.all([
          bank.addMoney.returned({ requestId: request.requestId }),
          bank.addMoney.returned({ requestId: request.requestId }),
        ]);
        expect(second).toEqual(first);
        expect(third).toEqual(first);
        nothingPosted();
        // Invariant: the partner's balance is back to what it held before the purchase, and it holds nothing back of it.
        expect((await tp.bank.balance({ userId: ADA, assetId: 'USDT', spaceId: null })).amount).toBe(parseAmount('50'));
        const holds = await caller.partnerHolds();
        if (!holds.held) throw new Error('ADA is held at the partner');
        expect(holds.holds).toEqual([]);
      });

      it('a crash after the partner took it back and before the row said so catches up, taken back once', async () => {
        const { tp, bank, caller } = atPartner();
        tp.fund(ADA, { fundId: 'fund-ada-50c', assetId: 'USDT', amount: parseAmount('50') });
        const { methods } = await caller.addMoney.methods(nl);
        const quote = methods.find((m) => m.method === 'pay_by_bank')!.quote!;
        const request = await caller.addMoney.start({ requestId: randomUUID(), ...nl, method: 'pay_by_bank', quoteId: quote.quoteId });
        await bank.addMoney.paid({ requestId: request.requestId, paidAmount: quote.payAmount, payCurrency: 'EUR' });
        await bank.addMoney.returned({ requestId: request.requestId });
        await sql`
          UPDATE bank.add_money_requests SET status = 'credited', returned_at = NULL, return_ref = NULL
           WHERE id = ${request.requestId}::uuid
        `;
        expect(await bank.addMoney.returned({ requestId: request.requestId })).toMatchObject({ status: 'returned' });
        expect((await tp.bank.balance({ userId: ADA, assetId: 'USDT', spaceId: null })).amount).toBe(parseAmount('50'));
        nothingPosted();
      });

      it('the partner down takes nothing back and leaves it credited, for its next returned', async () => {
        const { tp, bank, caller } = atPartner();
        const { methods } = await caller.addMoney.methods(nl);
        const quote = methods.find((m) => m.method === 'pay_by_bank')!.quote!;
        const request = await caller.addMoney.start({ requestId: randomUUID(), ...nl, method: 'pay_by_bank', quoteId: quote.quoteId });
        await bank.addMoney.paid({ requestId: request.requestId, paidAmount: quote.payAmount, payCurrency: 'EUR' });
        tp.set(ADA, { down: true });
        expect(((await bank.addMoney.returned({ requestId: request.requestId }).catch((e: unknown) => e)) as { code?: string }).code).toBe(
          'bank.partner_unavailable',
        );
        expect(await caller.addMoney.request({ requestId: request.requestId })).toMatchObject({ status: 'credited', returnedAt: null });
        tp.set(ADA, { down: false });
        // Back up, the partner's next returned takes it back once.
        expect(await bank.addMoney.returned({ requestId: request.requestId })).toMatchObject({ status: 'returned' });
        nothingPosted();
      });

      it('holds not reported read "not reported", never nothing held, and what can be withdrawn is not known', async () => {
        const { tp, caller } = atPartner();
        tp.fund(ADA, { fundId: 'fund-ada-10', assetId: 'USDT', amount: parseAmount('10') });
        tp.set(ADA, { purchaseHolds: 'not_reported' });
        const holds = await caller.partnerHolds();
        expect(holds).toMatchObject({ held: true, reported: false, asOf: null, holds: [], released: [] });
        if (!holds.held) throw new Error('ADA is held at the partner');
        expect(holds.balances).toEqual([expect.objectContaining({ assetId: 'USDT', balance: '10', heldBack: null, withdrawable: null })]);
      });

      it('a person the partner holds no money for has no partner holds', async () => {
        const { caller } = atPartner();
        expect(await as(BOB, { onrampStandIn: rates }, {}).partnerHolds()).toEqual({ held: false });
        expect((await caller.partnerHolds()).held).toBe(true);
      });
    });
  });
});
