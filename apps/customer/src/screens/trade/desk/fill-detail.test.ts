import { describe, expect, it } from 'vitest';
import { fillFeeRate, fillRole } from './fill-detail';

// TEST DATA written for these tests.
describe('fillRole', () => {
  it('passes maker and taker through and leaves anything else unknown', () => {
    expect(fillRole({ takerOrMaker: 'maker' })).toBe('maker');
    expect(fillRole({ takerOrMaker: 'taker' })).toBe('taker');
    expect(fillRole({ takerOrMaker: null })).toBeNull();
    expect(fillRole({ takerOrMaker: 'other' as never })).toBeNull();
  });
});

describe('fillFeeRate', () => {
  it('is the stated rate, or null when there is no fee or no stated rate', () => {
    expect(fillFeeRate({ fee: { cost: '0.01', currency: 'USDT', rate: '0.001' } })).toBe('0.001');
    expect(fillFeeRate({ fee: { cost: '0.01', currency: 'USDT', rate: null } })).toBeNull();
    expect(fillFeeRate({ fee: null })).toBeNull();
  });
});
