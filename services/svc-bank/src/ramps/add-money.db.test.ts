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
      const again = await bank.addMoney.approved(request.requestId);
      expect(again.request).toEqual(first.request);
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
  });
});
