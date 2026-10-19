import { describe, expect, it } from 'vitest';
import { bpsToRatio, feeRate, gateSubmit, holdShort, marketSellOff, sizeFor } from './form-logic';

const ready = {
  signedIn: true,
  marketOpen: true,
  pending: false,
  side: 'buy',
  type: 'limit',
  checkedOk: true,
  live: 'ok',
  short: false,
  busy: false,
} as const;

describe('gateSubmit', () => {
  it('opens only when everything holds', () => {
    expect(gateSubmit(ready)).toEqual({ canSend: true, reason: null });
  });

  it('says which condition stopped it, in order', () => {
    expect(gateSubmit({ ...ready, signedIn: false }).reason).toBe('signedOut');
    expect(gateSubmit({ ...ready, marketOpen: false }).reason).toBe('closed');
    expect(gateSubmit({ ...ready, pending: true }).reason).toBe('pending');
    expect(gateSubmit({ ...ready, checkedOk: false }).reason).toBe('invalid');
    expect(gateSubmit({ ...ready, live: 'checking' }).reason).toBe('checking');
    expect(gateSubmit({ ...ready, live: 'blocked' }).reason).toBe('refused');
    expect(gateSubmit({ ...ready, live: 'error' }).reason).toBe('error');
    expect(gateSubmit({ ...ready, short: true }).reason).toBe('short');
    expect(gateSubmit({ ...ready, live: 'blocked' }).canSend).toBe(false);
  });

  it('is shut while busy even when nothing else is wrong', () => {
    expect(gateSubmit({ ...ready, busy: true })).toEqual({ canSend: false, reason: null });
  });

  it('keeps market sells off, with a true reason, and leaves limit sells on', () => {
    expect(marketSellOff('sell', 'market')).toBe(true);
    expect(marketSellOff('sell', 'limit')).toBe(false);
    expect(marketSellOff('buy', 'market')).toBe(false);
    expect(gateSubmit({ ...ready, side: 'sell', type: 'market' })).toEqual({ canSend: false, reason: 'marketSell' });
    // OCO is sell-only and a bracket buy-only: the other side of each tab never opens.
    expect(gateSubmit({ ...ready, side: 'buy', type: 'oco' })).toEqual({ canSend: false, reason: 'exitSide' });
    expect(gateSubmit({ ...ready, side: 'sell', type: 'bracket' })).toEqual({ canSend: false, reason: 'exitSide' });
    expect(gateSubmit({ ...ready, side: 'sell', type: 'oco' })).toEqual({ canSend: true, reason: null });
    expect(gateSubmit({ ...ready, side: 'buy', type: 'bracket' })).toEqual({ canSend: true, reason: null });
    expect(gateSubmit({ ...ready, side: 'sell', type: 'limit' }).canSend).toBe(true);
  });
});

describe('holdShort', () => {
  it('refuses a hold bigger than the balance, using the service’s exact hold', () => {
    expect(holdShort({ holdAsset: 'USDT', holdAmount: '9967.04' }, 'USDT', '9937.39399533')).toBe(true);
    expect(holdShort({ holdAsset: 'USDT', holdAmount: '9937.39399533' }, 'USDT', '9937.39399533')).toBe(false);
    expect(holdShort({ holdAsset: 'USDT', holdAmount: '6.4' }, 'USDT', '4100')).toBe(false);
  });

  it('does not guess: unknown balance, other asset or no hold is not short', () => {
    expect(holdShort({ holdAsset: 'USDT', holdAmount: '9999' }, 'USDT', null)).toBe(false);
    expect(holdShort({ holdAsset: 'BTC', holdAmount: '9999' }, 'USDT', '1')).toBe(false);
    expect(holdShort({ holdAsset: 'USDT', holdAmount: null }, 'USDT', '1')).toBe(false);
  });
});

describe('fee line', () => {
  it('reads the rate from the preview’s basis points, exactly', () => {
    expect(bpsToRatio(10)).toBe('0.001');
    expect(bpsToRatio(8)).toBe('0.0008');
    expect(feeRate({ feeBps: 10 })).toBe('0.001');
    expect(feeRate({ feeBps: null })).toBeNull();
    expect(feeRate(null)).toBeNull();
  });
});

describe('sizeFor (percent chips and Max)', () => {
  const base = {
    side: 'buy',
    type: 'limit',
    price: '65000',
    available: '1000',
    lotSize: '0.00001',
    protectionPrice: null,
    percent: 100,
  } as const;

  it('sizes a limit buy from the price and a market buy from the protection price', () => {
    expect(sizeFor(base)).toEqual({ amount: '0.01538', needsPrice: false });
    expect(sizeFor({ ...base, percent: 50 })).toEqual({ amount: '0.00769', needsPrice: false });
    expect(sizeFor({ ...base, type: 'market', price: '', protectionPrice: '65409.08' }).amount).toBe('0.01528');
  });

  it('asks for a price when a buy has none, and does nothing without a balance', () => {
    expect(sizeFor({ ...base, price: '' })).toEqual({ amount: null, needsPrice: true });
    expect(sizeFor({ ...base, available: null })).toEqual({ amount: null, needsPrice: false });
    expect(sizeFor({ ...base, available: '0.0001' }).amount).toBeNull();
  });

  it('a sell is the balance, cut by percent and down to the lot', () => {
    expect(sizeFor({ ...base, side: 'sell', price: '', available: '0.25', percent: 25 }).amount).toBe('0.0625');
  });
});
