import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { BankError } from '../errors.js';
import type { AddMoneyRequestView, AddMoneyService } from './add-money.js';
import { PayinSimRefusedError, onrampPartnerFor, parsePayinSim, payinSim } from './payin-sim.js';
import { registerPayinSimPage } from './payin-sim-page.js';

const CATALOGUE = JSON.stringify({ label: 'TEST pay-in stand-in', methods: ['pay_by_bank'] });
const PAGE = 'http://127.0.0.1:14999';
const BACK = 'http://127.0.0.1:3210/bank/ramps/new';
const ID = '33333333-3333-4333-8333-333333333333';
const config = { catalogueJson: CATALOGUE, pageUrl: PAGE, returnUrl: BACK };

describe('the add-money pay-in stand-in', () => {
  it('is off by default', () => {
    expect(onrampPartnerFor('none', config, { APP_ENV: 'dev' })).toBeNull();
  });

  it('opens a TEST page on its own address for the ways to pay it lists, and none for the rest', async () => {
    const partner = onrampPartnerFor('payin-sim', config, { APP_ENV: 'test' })!;
    expect(partner).toMatchObject({ label: 'TEST pay-in stand-in', rail: 'payin-sim' });
    expect(partner.payments.loopbackPages).toBe(true);
    expect(partner.covers('pay_by_bank')).toBe(true);
    expect(partner.covers('card')).toBe(false);
    const input = { onrampId: ID, quoteId: ID, userId: 'u', assetId: 'USDT', amount: '20' };
    expect(await partner.payments.open({ ...input, method: 'pay_by_bank' })).toEqual({
      partnerRail: 'payin-sim',
      hostedUrl: `${PAGE}/test/payin-sim/pay/${ID}`,
    });
    expect(await partner.payments.open({ ...input, method: 'card' })).toBeNull();
    expect(await partner.payments.open({ ...input, method: 'bank_transfer' })).toBeNull();
    expect(partner.returnUrl(ID)).toBe(`${BACK}?request=${ID}`);
  });

  it('refuses to start outside dev or test, or under NODE_ENV=production', () => {
    for (const env of [{}, { APP_ENV: 'production' }, { APP_ENV: 'staging' }, { APP_ENV: 'dev', NODE_ENV: 'production' }]) {
      expect(() => onrampPartnerFor('payin-sim', config, env)).toThrow(PayinSimRefusedError);
    }
  });

  it('refuses to start over a blank, unlabelled, duplicated or out-of-shape catalogue', () => {
    for (const bad of [
      undefined,
      ' ',
      '{',
      JSON.stringify({ label: 'Live partner', methods: ['pay_by_bank'] }),
      JSON.stringify({ label: 'TEST', methods: [] }),
      JSON.stringify({ label: 'TEST', methods: ['pay_by_bank', 'pay_by_bank'] }),
      // A bank transfer is instructions, not a page: the stand-in opens none.
      JSON.stringify({ label: 'TEST', methods: ['bank_transfer'] }),
      JSON.stringify({ label: 'TEST', methods: ['pay_by_bank'], extra: true }),
    ]) {
      expect(parsePayinSim(bad)).toBeNull();
      expect(() => onrampPartnerFor('payin-sim', { ...config, catalogueJson: bad }, { APP_ENV: 'dev' })).toThrow(PayinSimRefusedError);
    }
  });

  it('refuses to start without loopback page and return addresses', () => {
    for (const urls of [
      { pageUrl: undefined },
      { returnUrl: '' },
      { pageUrl: 'https://pay.example.com' },
      { returnUrl: 'http://app.example.com/bank/ramps/new' },
      { returnUrl: `${BACK}?next=elsewhere` },
      { pageUrl: 'ftp://127.0.0.1:14999' },
      { pageUrl: 'not a url' },
    ]) {
      expect(() => onrampPartnerFor('payin-sim', { ...config, ...urls }, { APP_ENV: 'dev' })).toThrow(PayinSimRefusedError);
    }
  });
});

describe("the pay-in stand-in's page", () => {
  const partner = payinSim(parsePayinSim(CATALOGUE)!, new URL(PAGE), new URL(BACK));
  const view = (status: AddMoneyRequestView['status']): AddMoneyRequestView => ({
    requestId: ID,
    assetId: 'USDT',
    amount: '20',
    method: 'pay_by_bank',
    country: 'NL',
    rail: 'rail.bank',
    status,
    refusalCode: null,
    onramp: {
      onrampId: ID,
      quoteId: ID,
      userId: 'u',
      assetId: 'USDT',
      amount: '20',
      method: 'pay_by_bank',
      payAmount: '41',
      fee: '1',
      rate: '2',
      payCurrency: 'EUR',
      status: 'pending_payment',
      simulated: true,
      partnerRail: 'payin-sim',
      hostedUrl: `${PAGE}/test/payin-sim/pay/${ID}`,
      bankInstructions: null,
      createdAt: '2026-11-04T10:00:00.000Z',
    },
    createdAt: '2026-11-04T10:00:00.000Z',
    openedAt: '2026-11-04T10:00:01.000Z',
    pendingAt: status === 'pending' ? '2026-11-04T10:00:02.000Z' : null,
    creditedAt: null,
    creditedAmount: null,
  });

  function mounted(status: AddMoneyRequestView['status'], approvedCalls: string[] = []) {
    const app = Fastify();
    const addMoney: Pick<AddMoneyService, 'opened' | 'approved'> = {
      opened: async (id) => {
        if (id !== ID) throw new BankError('No add-money request has that id', 'bank.add_money_request_missing');
        return { request: view(status), returnUrl: partner.returnUrl(id) };
      },
      approved: async (id) => {
        approvedCalls.push(id);
        return { request: view('pending'), returnUrl: partner.returnUrl(id) };
      },
    };
    registerPayinSimPage(app, addMoney, partner);
    return app;
  }

  it('shows the payment it opened, labelled TEST, with an approve button and a way back', async () => {
    const res = await mounted('opened').inject({ method: 'GET', url: `/test/payin-sim/pay/${ID}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    expect(res.headers['content-security-policy']).toContain("form-action 'self' http://127.0.0.1:3210");
    expect(res.body).toContain('TEST pay-in stand-in');
    expect(res.body).toContain('Pay 41 EUR to add 20 USDT');
    expect(res.body).toContain(`action="/test/payin-sim/pay/${ID}/approve"`);
    expect(res.body).toContain(`href="${BACK}?request=${ID}"`);
  });

  it('an approved payment shows no approve button', async () => {
    const res = await mounted('pending').inject({ method: 'GET', url: `/test/payin-sim/pay/${ID}` });
    expect(res.body).toContain('already approved');
    expect(res.body).not.toContain('/approve');
  });

  it("approving records it and sends the payer back to the app's request, from the browser's own form", async () => {
    const calls: string[] = [];
    const res = await mounted('opened', calls).inject({
      method: 'POST',
      url: `/test/payin-sim/pay/${ID}/approve`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: '',
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe(`${BACK}?request=${ID}`);
    expect(calls).toEqual([ID]);
  });

  it('refuses an id that is not a payment, and one it never opened', async () => {
    const app = mounted('opened');
    expect((await app.inject({ method: 'GET', url: '/test/payin-sim/pay/not-an-id' })).statusCode).toBe(400);
    const missing = await app.inject({ method: 'GET', url: '/test/payin-sim/pay/44444444-4444-4444-8444-444444444444' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: 'bank.add_money_request_missing' });
  });
});
