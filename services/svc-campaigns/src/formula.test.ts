import { describe, expect, it } from 'vitest';
import { CampaignsError } from './codes.js';
import { evaluateFormula, parseFormula } from './formula.js';

const NAMES = ['amount', 'fee', 'qty'] as const;
const d = (text: string) => {
  const [w, f = ''] = text.split('.');
  return BigInt(w!) * 10n ** 18n + BigInt(f.padEnd(18, '0'));
};

const refusal = (source: string) => {
  try {
    parseFormula(source, NAMES);
  } catch (err) {
    expect(err).toBeInstanceOf(CampaignsError);
    expect((err as CampaignsError).code).toBe('campaigns.formula_invalid');
    return (err as CampaignsError).message;
  }
  throw new Error(`expected ${source} to refuse`);
};

describe('the incentive formula grammar', () => {
  it('works out sums, products, brackets, min and max in decimals, rounding a quotient down', () => {
    const values = { amount: d('250.5'), fee: d('0.25'), qty: d('2') };
    const run = (source: string) => evaluateFormula(parseFormula(source, NAMES), values);
    expect(run('1')).toBe(d('1'));
    expect(run('amount * 0.01')).toBe(d('2.505'));
    expect(run('min(amount * 0.01, 2)')).toBe(d('2'));
    expect(run('max(fee, 0.5) + 1')).toBe(d('1.5'));
    expect(run('(amount - 50.5) / 3')).toBe(66666666666666666666n);
    expect(run('2 + 3 * 4')).toBe(d('14'));
  });

  it('never gives less than zero, and a division by zero gives zero', () => {
    const values = { amount: d('1'), fee: 0n, qty: 0n };
    expect(evaluateFormula(parseFormula('amount - 5', NAMES), values)).toBe(0n);
    expect(evaluateFormula(parseFormula('amount / qty', NAMES), values)).toBe(0n);
  });

  it('refuses anything outside the grammar, naming where', () => {
    expect(refusal('amount * * 2')).toMatch(/not in the formula grammar: expected a number, a name or \( but found "\*" at position 10/);
    expect(refusal('balance * 2')).toMatch(/"balance" is not a name this trigger has/);
    expect(refusal('amount; drop')).toMatch(/";" at position 7/);
    expect(refusal('min(amount)')).toMatch(/expected ","/);
    expect(refusal('(amount')).toMatch(/expected "\)"/);
    expect(refusal('1.1234567890123456789')).toMatch(/more than 18 places/);
    expect(refusal('-1')).toMatch(/found "-"/);
    expect(refusal('1'.repeat(30))).toMatch(/larger than an amount can be/);
    expect(refusal(Array.from({ length: 31 }, () => '1').join('+'))).toMatch(/longer than 60 parts/);
  });
});
