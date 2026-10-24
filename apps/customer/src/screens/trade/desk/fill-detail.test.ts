import { describe, expect, it } from 'vitest';
import { fillFeeRate, fillRebate, fillRole, fillZeroFee } from './fill-detail';

// TEST DATA written for these tests.
describe('fillRole', () => {
  it('passes maker and taker through and leaves anything else unknown', () => {
    expect(fillRole({ takerOrMaker: 'maker' })).toBe('maker');
    expect(fillRole({ takerOrMaker: 'taker' })).toBe('taker');
    expect(fillRole({ takerOrMaker: null })).toBeNull();
    expect(fillRole({ takerOrMaker: 'other' as never })).toBeNull();
  });
});

describe('fillRebate and fillZeroFee', () => {
  it('reads a rebate only from its own field, and a fee of exactly nothing as zero', () => {
    expect(fillRebate({ rebate: { cost: '0.001', currency: 'BTC', rate: '0.0005' } })).toEqual({
      cost: '0.001',
      currency: 'BTC',
      rate: '0.0005',
    });
    expect(fillRebate({})).toBeNull();
    expect(fillZeroFee({ fee: { cost: '0', currency: 'USDT', rate: '0' } })).toBe(true);
    expect(fillZeroFee({ fee: { cost: '0.000', currency: 'USDT', rate: null } })).toBe(true);
    expect(fillZeroFee({ fee: { cost: '0.0001', currency: 'USDT', rate: '0.001' } })).toBe(false);
    expect(fillZeroFee({ fee: null })).toBe(false);
  });
});

describe('fillFeeRate', () => {
  it('is the stated rate, or null when there is no fee or no stated rate', () => {
    expect(fillFeeRate({ fee: { cost: '0.01', currency: 'USDT', rate: '0.001' } })).toBe('0.001');
    expect(fillFeeRate({ fee: { cost: '0.01', currency: 'USDT', rate: null } })).toBeNull();
    expect(fillFeeRate({ fee: null })).toBeNull();
  });
});
