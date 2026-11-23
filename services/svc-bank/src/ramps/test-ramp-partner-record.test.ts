import { describe, expect, it } from 'vitest';
import { rampPartnerBook } from './ramp-partner-book.js';
import { answerTestRampPartnerRecord, TEST_RAMP_PARTNER_RECORD_ID } from './test-ramp-partner-record.js';

const at = (s: number) => new Date(Date.UTC(2026, 10, 22, 0, 0, s));
const account = { venueId: TEST_RAMP_PARTNER_RECORD_ID, owner: 'u-1', subAccount: null };

describe("the TEST ramp partner's own report, in the outside-record read's shape (J-bank-28 #3)", () => {
  it('names itself with its label on GET /venue, and refuses another method', () => {
    const book = rampPartnerBook('TEST ramp', () => at(0));
    expect(answerTestRampPartnerRecord({ book, method: 'GET', path: '/venue', body: null })).toEqual([
      200,
      { label: 'TEST', venue: { id: TEST_RAMP_PARTNER_RECORD_ID, displayName: 'TEST ramp' } },
    ]);
    expect(answerTestRampPartnerRecord({ book, method: 'POST', path: '/venue', body: null })[0]).toBe(405);
  });

  it("answers the partner's own report for a reader naming it, the same view the desk reads", () => {
    const book = rampPartnerBook('TEST ramp', () => at(30));
    book.opened('paid', at(600));
    book.paid('paid');
    book.opened('ran-out', at(10));
    const [status, body] = answerTestRampPartnerRecord({ book, method: 'POST', path: '/report', body: { account } });
    expect(status).toBe(200);
    expect(body).toMatchObject({
      label: 'TEST',
      value: {
        label: 'TEST ramp',
        health: 'operational',
        orders: expect.arrayContaining([
          { state: 'paid', count: 1 },
          { state: 'expired', count: 1 },
          { state: 'opened', count: 0 },
        ]),
        quoteExpiries: { count: 1, latest: [{ orderId: 'ran-out', expiredAt: at(10).toISOString() }] },
      },
    });
  });

  it('refuses a read that names another partner, no reader, a sub-account, or the wrong method', () => {
    const book = rampPartnerBook('TEST ramp', () => at(0));
    const ask = (b: unknown, m = 'POST') => answerTestRampPartnerRecord({ book, method: m, path: '/report', body: b })[0];
    expect(ask({ account: { ...account, venueId: 'test-partner-bank' } })).toBe(400);
    expect(ask({ account: { ...account, owner: '' } })).toBe(400);
    expect(ask({ account: { ...account, subAccount: 'x' } })).toBe(400);
    expect(ask(null)).toBe(400);
    expect(ask({ account }, 'GET')).toBe(405);
    expect(answerTestRampPartnerRecord({ book, method: 'POST', path: '/balances', body: { account } })[0]).toBe(404);
  });

  it("the age door moves one order's clock at the partner, and refuses one it never opened", () => {
    const book = rampPartnerBook('TEST ramp', () => at(0));
    book.opened('o', at(600));
    expect(answerTestRampPartnerRecord({ book, method: 'POST', path: '/age', body: { orderId: 'o', seconds: 601 } })[0]).toBe(200);
    expect(answerTestRampPartnerRecord({ book, method: 'POST', path: '/age', body: { orderId: 'missing', seconds: 1 } })[0]).toBe(404);
    expect(answerTestRampPartnerRecord({ book, method: 'POST', path: '/age', body: { orderId: 'o' } })[0]).toBe(400);
    expect(book.report().orders).toMatchObject({ opened: 0, expired: 1 });
  });
});
