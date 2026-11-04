import { describe, expect, it } from 'vitest';
import { tradeAccess } from './TradeAccess';

describe('tradeAccess: what the Trade door says about trading', () => {
  it('asks an unverified account to verify', () => {
    expect(tradeAccess({ tier: 'none', records: [] })).toEqual({ kind: 'verify' });
    expect(tradeAccess({ tier: 'none', records: [{ status: 'rejected' }] })).toEqual({ kind: 'verify' });
  });
  it('says a request is pending while its newest record waits', () => {
    expect(tradeAccess({ tier: 'none', records: [{ status: 'pending' }] })).toEqual({ kind: 'pending' });
  });
  it('reads verified from basic up, the level the spot desk takes orders from, whatever the newest record says', () => {
    expect(tradeAccess({ tier: 'basic', records: [] })).toEqual({ kind: 'verified', level: 'basic' });
    expect(tradeAccess({ tier: 'full', records: [{ status: 'approved' }] })).toEqual({ kind: 'verified', level: 'full' });
    expect(tradeAccess({ tier: 'basic', records: [{ status: 'pending' }] })).toEqual({ kind: 'verified', level: 'basic' });
    expect(tradeAccess({ tier: 'institutional', records: [] })).toEqual({ kind: 'verified', level: 'institutional' });
  });
  it('never guesses when the level was not read', () => {
    expect(tradeAccess(null)).toEqual({ kind: 'unread' });
  });
});
