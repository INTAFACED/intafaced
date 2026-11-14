import { describe, expect, it } from 'vitest';
import { POINTS_OWNER_QUESTION, pointsProgrammeSchema, type EarningRule } from '@intafaced/contracts/campaigns-catalogue';
import { CampaignsError } from './codes.js';
import { evaluateEarning, pointsProgramme, refusePoints } from './points.js';

// CM-rewards-hub-04 and -05 (J-campaigns-15): the points programme's layout with no number, its refusals, and a points
// effect that refuses for itself only when the rules are evaluated.

const refusalOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return err instanceof CampaignsError ? { code: err.code, message: err.message } : { code: 'other', message: String(err) };
  }
  return null;
};

describe('the points programme', () => {
  it('reads as its full layout with every number blank and the owner question named', () => {
    const p = pointsProgrammeSchema.parse(pointsProgramme());
    expect(p.blocker).toEqual({ code: 'owner.decision', question: POINTS_OWNER_QUESTION });
    expect(p.wallet).toEqual({ available: null, pending: null, expiring: null });
    expect(p.members.count).toBeNull();
    expect(p.lifecycle).toEqual({ stages: ['draft', 'active', 'paused', 'ended'], current: null });
    expect(p.expiry.current).toBeNull();
    expect(p.expiry.modes.map((m) => m.mode)).toEqual(['never', 'rolling', 'calendar', 'inactivity']);
    expect(p.expiry.modes.every((m) => m.horizonSeconds === null)).toBe(true);
    expect(p.pending).toEqual([]);
    expect(p.catalogue.map((i) => i.id)).toEqual(['fee_saver', 'cash_voucher', 'drop_place']);
    expect(p.catalogue.every((i) => i.pricePoints === null && i.stock === null && i.perPersonLimit === null)).toBe(true);
    expect(p.conversion).toEqual({ rate: null, asset: null, minimumPoints: null });
  });

  it('refuses converting and redeeming by the owner question', () => {
    for (const action of ['convert', 'redeem'] as const) {
      const refused = refusalOf(() => refusePoints(action));
      expect(refused?.code).toBe('owner.decision');
      expect(refused?.message).toContain(POINTS_OWNER_QUESTION);
    }
  });
});

describe('evaluating earning rules on a TEST event', () => {
  const incentive: EarningRule = { name: 'Deposit reward', trigger: 'pay.deposit_credit.posted', minAmount: '10', formula: 'amount / 100' };
  const pointsRule: EarningRule = {
    name: 'Deposit points',
    trigger: 'pay.deposit_credit.posted',
    minAmount: null,
    formula: '5',
    effect: 'points',
  };
  const fill: EarningRule = { name: 'Fill reward', trigger: 'trade.fill.settled', minAmount: null, formula: 'fee' };

  it('refuses a points effect for that rule only; the other rules answer as before', () => {
    const results = evaluateEarning([incentive, pointsRule, fill], 'USDC', 'pay.deposit_credit.posted', { amount: '250' });
    expect(results).toEqual([
      { outcome: 'gives', rule: 'Deposit reward', effect: 'incentive', amount: '2.5', asset: 'USDC' },
      { outcome: 'refused', rule: 'Deposit points', effect: 'points', code: 'owner.decision', question: POINTS_OWNER_QUESTION },
      { outcome: 'nothing', rule: 'Fill reward', effect: 'incentive', reason: 'other_trigger' },
    ]);
  });

  it('says why an incentive gives nothing: under its condition, or worked out to zero', () => {
    expect(evaluateEarning([incentive], 'USDC', 'pay.deposit_credit.posted', { amount: '9.99' })[0]).toMatchObject({
      outcome: 'nothing',
      reason: 'below_condition',
    });
    expect(evaluateEarning([fill], 'USDC', 'trade.fill.settled', { amount: '1' })[0]).toMatchObject({ outcome: 'nothing', reason: 'zero' });
  });

  it('refuses a trigger outside the catalogue and a value the trigger does not have', () => {
    expect(refusalOf(() => evaluateEarning([incentive], 'USDC', 'wallet.made.up', {}))?.code).toBe('campaigns.trigger_unknown');
    expect(refusalOf(() => evaluateEarning([incentive], 'USDC', 'pay.deposit_credit.posted', { fee: '1' }))?.code).toBe(
      'campaigns.formula_invalid',
    );
    expect(refusalOf(() => evaluateEarning([incentive], 'USDC', 'pay.deposit_credit.posted', { amount: '1e3' }))?.code).toBe(
      'campaigns.formula_invalid',
    );
  });
});
