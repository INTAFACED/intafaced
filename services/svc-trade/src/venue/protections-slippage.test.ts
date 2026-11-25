import { describe, expect, it } from 'vitest';
import { CLOSE_SLIPPAGE_PERCENT } from '@intafaced/contracts/trade-venue-door';
import { formatAmount, parseAmount } from '@intafaced/ledger-client/money';
import { worstPrice } from './protections.js';

const a = parseAmount;

describe("a fired engine stop's worst price", () => {
  it('is 10% past the trigger, the owner’s one value the desk’s Close uses too', () => {
    expect(CLOSE_SLIPPAGE_PERCENT).toBe(10n);
    // A long's stop sells at no less than trigger × 0.90; a short's buys at no more than trigger × 1.10.
    expect(formatAmount(worstPrice('sell', a('60000'), a('1')))).toBe('54000');
    expect(formatAmount(worstPrice('buy', a('60000'), a('1')))).toBe('66000');
  });

  it('sits on the tick, against the position: a sell rounds down, a buy up', () => {
    expect(formatAmount(worstPrice('sell', a('60007'), a('5')))).toBe('54005');
    expect(formatAmount(worstPrice('buy', a('60007'), a('5')))).toBe('66010');
    expect(formatAmount(worstPrice('sell', a('2900'), a('0.1')))).toBe('2610');
    expect(formatAmount(worstPrice('buy', a('2900.3'), a('0.1')))).toBe('3190.4');
  });
});
