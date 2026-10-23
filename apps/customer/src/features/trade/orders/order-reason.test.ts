import { describe, expect, it } from 'vitest';
import { orderReason } from './order-reason';

describe('why an order ended', () => {
  it('says nothing for an open or filled order', () => {
    expect(orderReason({ status: 'open', rejectCode: null })).toEqual({ kind: 'none' });
    expect(orderReason({ status: 'closed', rejectCode: 'ioc_remainder' })).toEqual({ kind: 'none' });
  });

  it('names a known engine reason, keeps any other code, and says when none was recorded', () => {
    expect(orderReason({ status: 'canceled', rejectCode: 'ioc_remainder' })).toEqual({ kind: 'known', key: 'reasonIoc' });
    expect(orderReason({ status: 'expired', rejectCode: 'expired' })).toEqual({ kind: 'known', key: 'reasonExpired' });
    expect(orderReason({ status: 'rejected', rejectCode: 'trade.price_band' })).toEqual({ kind: 'code', code: 'trade.price_band' });
    expect(orderReason({ status: 'canceled', rejectCode: null })).toEqual({ kind: 'not-recorded' });
    expect(orderReason({ status: 'rejected' })).toEqual({ kind: 'not-recorded' });
    expect(orderReason({ status: 'canceled', rejectCode: 'toString' })).toEqual({ kind: 'code', code: 'toString' });
  });
});
