import { describe, expect, it } from 'vitest';
import { lateScore, policyOf } from './late-policy.js';

const DUE = new Date('2026-11-02T12:00:00.000Z');
const at = (hoursAfterDue: number) => new Date(DUE.getTime() + hoursAfterDue * 3_600_000);
const policy = { graceHours: '2', deductionPerDay: '0.1' };

describe('late policy (ENGINE GR-5)', () => {
  it('takes nothing off with no policy, no due date, an on-time hand-in or one inside the grace', () => {
    expect(lateScore('8', '10', at(30), DUE, null)).toEqual({ score: '8', entered: null });
    expect(lateScore('8', '10', at(30), null, policy)).toEqual({ score: '8', entered: null });
    expect(lateScore('8', '10', at(-1), DUE, policy)).toEqual({ score: '8', entered: null });
    expect(lateScore('8', '10', at(2), DUE, policy)).toEqual({ score: '8', entered: null });
  });

  it('takes the deduction for each started day past the grace and keeps the entered grade beside it', () => {
    // One minute past the grace is one started day: 0.1 of 10 points.
    expect(lateScore('8', '10', new Date(at(2).getTime() + 60_000), DUE, policy)).toEqual({ score: '7', entered: '8' });
    // 2 h grace + 24 h + 1 h: two started days.
    expect(lateScore('8', '10', at(27), DUE, policy)).toEqual({ score: '6', entered: '8' });
  });

  it('never goes below 0 and never takes more than all of the points', () => {
    expect(lateScore('3', '10', at(24 * 30), DUE, policy)).toEqual({ score: '0', entered: '3' });
    expect(lateScore('10', '10', at(24 * 30), DUE, { graceHours: '0', deductionPerDay: '1' })).toEqual({ score: '0', entered: '10' });
  });

  it('rounds the deduction up to the hundredth, so the score is cut, never raised', () => {
    // 0.0333 of 7.5 points is 0.24975: 0.25 comes off.
    expect(lateScore('7.5', '7.5', at(1), DUE, { graceHours: '0', deductionPerDay: '0.0333' })).toEqual({ score: '7.25', entered: '7.5' });
    // A deduction that changes nothing at hundredths keeps the score as entered.
    expect(lateScore('0', '10', at(5), DUE, policy)).toEqual({ score: '0', entered: null });
  });

  it('reads stored numerics back as the contract strings, and a cleared row as no policy', () => {
    expect(policyOf({ grace_hours: '24.00', deduction_per_day: '0.1000' })).toEqual({ graceHours: '24', deductionPerDay: '0.1' });
    expect(policyOf({ grace_hours: '1.50', deduction_per_day: '1.0000' })).toEqual({ graceHours: '1.5', deductionPerDay: '1' });
    expect(policyOf({ grace_hours: null, deduction_per_day: null })).toBeNull();
    expect(policyOf(undefined)).toBeNull();
  });
});
