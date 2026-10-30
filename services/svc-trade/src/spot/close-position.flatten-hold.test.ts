import { describe, expect, it } from 'vitest';
import { formatAmount, LedgerError } from '@intafaced/ledger-client';
import { closeHoldFailureAction, sumBuyFillNotional } from './close-position.js';

describe('S03 flatten hold', () => {
  it('two buy fills at different prices hold the sum of price times quantity', () => {
    const hold = sumBuyFillNotional([
      { price: '100', qty: '1' },
      { price: '120', qty: '1' },
    ]);
    expect(formatAmount(hold)).toBe('220');
    const firstPriceTimesTotalQty = sumBuyFillNotional([{ price: '100', qty: '2' }]);
    expect(formatAmount(hold)).not.toBe(formatAmount(firstPriceTimesTotalQty));
  });

  it('an unknown ledger reply keeps the close row; a definite shortfall deletes the intent', () => {
    expect(closeHoldFailureAction(new Error('connect timeout'))).toBe('keep_recovery');
    expect(closeHoldFailureAction(new LedgerError('short', 'ledger.insufficient_funds'))).toBe('delete_intent');
    expect(closeHoldFailureAction({ code: 'ledger.insufficient_funds' })).toBe('keep_recovery');
  });

  it('a caller-binding refusal is definite here too, as in the order hold', () => {
    expect(closeHoldFailureAction(new LedgerError('unbound', 'ledger.caller_unbound'))).toBe('delete_intent');
    expect(closeHoldFailureAction(new LedgerError('forbidden', 'ledger.caller_forbidden'))).toBe('delete_intent');
    expect(closeHoldFailureAction(new LedgerError('lost reply', 'ledger.timeout'))).toBe('keep_recovery');
    expect(closeHoldFailureAction(Object.assign(new Error('never sent'), { cause: { code: 'ECONNREFUSED' } }))).toBe('keep_recovery');
  });
});
