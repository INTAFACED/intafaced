import { describe, expect, it } from 'vitest';
import { parseFeeTable, parsePlans, planView } from './plans.js';

const TABLE = JSON.stringify({
  defaultPlanId: 'standard',
  plans: [
    { id: 'standard', name: 'TEST Standard', tier: 'standard', price: '0', assetId: 'USDT', period: 'month' },
    { id: 'plus', name: 'TEST Plus', tier: 'plus', price: '4.990', assetId: 'USDT', period: 'month' },
  ],
});

describe('the owner plan and fee tables (BK-acct-04, J-bank-16 #6)', () => {
  it('reads the plans and puts a person who never subscribed on the default plan; a paid plan names its blocker', () => {
    const view = planView(parsePlans(TABLE));
    expect(view.current).toMatchObject({ id: 'standard', price: '0', period: 'month' });
    expect(view.plans.map((p) => [p.id, p.price, p.blocker])).toEqual([
      ['standard', '0', null],
      ['plus', '4.99', 'bank.plan_fee_unwired'],
    ]);
  });

  it('refuses bank.plans_unset when the table is blank or not in shape, and invents no plan', () => {
    for (const raw of [
      undefined,
      '',
      '  ',
      '{',
      '{"plans":[]}',
      JSON.stringify({ defaultPlanId: 'gone', plans: JSON.parse(TABLE).plans }),
    ]) {
      expect(parsePlans(raw)).toBeNull();
      expect(() => planView(parsePlans(raw))).toThrow(expect.objectContaining({ code: 'bank.plans_unset' }));
    }
    const priced = JSON.parse(TABLE);
    priced.plans[1].price = 4.99;
    expect(parsePlans(JSON.stringify(priced))).toBeNull();
  });

  it('reads a blank fee table as none published, and refuses a line not in shape', () => {
    expect(parseFeeTable(undefined)).toBeNull();
    expect(parseFeeTable('')).toBeNull();
    expect(parseFeeTable(JSON.stringify({ lines: [{ id: 'card-order', label: 'Card order', fee: '5', assetId: 'USDT' }] }))).toEqual([
      { id: 'card-order', label: 'Card order', fee: '5', assetId: 'USDT' },
    ]);
    expect(parseFeeTable(JSON.stringify({ lines: [{ id: 'card-order', label: 'Card order', fee: 5, assetId: 'USDT' }] }))).toBeNull();
  });
});
