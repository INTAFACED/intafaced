import { describe, expect, it } from 'vitest';
import { RAIL_NO_REASON, railDetail, railName } from './rails';

describe('rail names and reasons', () => {
  it('names the known rails and leaves an unknown id as the service sent it', () => {
    expect(railName('crypto-native')).toBe('Crypto transfers (TEST sandbox)');
    expect(railName('card-sandbox')).toBe('Cards (TEST sandbox)');
    expect(railName('bank-payout')).toBe('Bank payouts');
    expect(railName('sepa')).toBe('sepa');
  });

  it('a down rail always says why: its own reason, else that it gave none', () => {
    expect(railDetail({ ok: false, detail: 'sandbox acquirer marked down' })).toBe('sandbox acquirer marked down');
    expect(railDetail({ ok: false, detail: null })).toBe(RAIL_NO_REASON);
    expect(railDetail({ ok: false, detail: '   ' })).toBe('The rail did not report a reason.');
  });

  it('an up rail with nothing to add stays a dash', () => {
    expect(railDetail({ ok: true, detail: null })).toBe('—');
  });
});
