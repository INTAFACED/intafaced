import { describe, expect, it } from 'vitest';
import { RAIL_NO_REASON, railDetail, railName } from './rails';

describe('rail names and reasons', () => {
  it('never labels a rail TEST or live: the founder read has no mode', () => {
    for (const id of ['crypto-native', 'card-sandbox', 'bank-payout']) expect(railName(id)).not.toMatch(/TEST|live/i);
  });

  it('names the known rails and leaves an unknown id as the service sent it', () => {
    expect(railName('crypto-native')).toBe('Crypto transfers');
    expect(railName('card-sandbox')).toBe('Cards');
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
