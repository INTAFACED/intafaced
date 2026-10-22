import { describe, expect, it } from 'vitest';
import { termsVerdict, type SendQuote } from './send-terms';

// TEST figures only.
const quote = (over: Partial<SendQuote> = {}): SendQuote => ({
  assetId: 'USDT',
  amount: '25',
  perTransferLimit: '1000',
  dailyLimit: '5000',
  spentToday: '100',
  fee: '0',
  feeBlocker: null,
  withinPerTransfer: true,
  withinDaily: true,
  ...over,
});

describe('termsVerdict', () => {
  it('shows the fee, the per-payment limit and what is left of today before and after this payment', () => {
    expect(termsVerdict({ kind: 'ready', quote: quote() }, '25')).toEqual({
      kind: 'ok',
      fee: '0',
      perTransfer: '1000',
      left: '4900',
      leftAfter: '4875',
    });
  });

  it('reads nothing for a blank amount, and waits while a check is on its way', () => {
    expect(termsVerdict({ kind: 'idle' }, null)).toEqual({ kind: 'none' });
    expect(termsVerdict({ kind: 'checking' }, '25')).toEqual({ kind: 'checking' });
  });

  it('never applies an answer given for another amount', () => {
    expect(termsVerdict({ kind: 'ready', quote: quote({ amount: '25' }) }, '26')).toEqual({ kind: 'checking' });
    expect(termsVerdict({ kind: 'ready', quote: quote({ amount: '25.0' }) }, '25').kind).toBe('ok');
  });

  it('refuses a fee that cannot be collected first, then over the per-payment limit, then over today', () => {
    expect(termsVerdict({ kind: 'ready', quote: quote({ withinPerTransfer: false, withinDaily: false }) }, '25')).toEqual({
      kind: 'overPayment',
      limit: '1000',
    });
    expect(termsVerdict({ kind: 'ready', quote: quote({ withinDaily: false, spentToday: '4990' }) }, '25')).toEqual({
      kind: 'overDaily',
      left: '10',
    });
    expect(termsVerdict({ kind: 'ready', quote: quote({ withinDaily: false, spentToday: '6000' }) }, '25')).toEqual({
      kind: 'overDaily',
      left: '0',
    });
    const unwired = { fee: '1', feeBlocker: 'bank.personal_transfer_fee_unwired' };
    expect(termsVerdict({ kind: 'ready', quote: quote(unwired) }, '25')).toEqual({ kind: 'feeUnwired' });
    expect(termsVerdict({ kind: 'ready', quote: quote({ ...unwired, withinPerTransfer: false, withinDaily: false }) }, '25')).toEqual({
      kind: 'feeUnwired',
    });
  });

  it('passes on the unset and unavailable answers as they are', () => {
    expect(termsVerdict({ kind: 'unset' }, '25')).toEqual({ kind: 'unset' });
    expect(termsVerdict({ kind: 'unavailable' }, '25')).toEqual({ kind: 'unavailable' });
  });
});
