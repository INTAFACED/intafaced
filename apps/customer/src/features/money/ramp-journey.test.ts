import { describe, expect, it } from 'vitest';
import {
  buildOfframpInput,
  cashOutBlock,
  CLIENT_STEP_UP,
  destinationProblem,
  offrampAmountProblem,
  offrampMatches,
  rampGate,
  rampStatusKey,
  RAMP_STEPS,
} from './ramp-journey';

describe('ramp provider gate', () => {
  it('only a real rail is live', () => {
    expect(rampGate(null)).toBe('none');
    expect(rampGate({ id: 'none', simulated: false })).toBe('none');
    expect(rampGate({ id: 'ramp-sim', simulated: true })).toBe('simulated');
    expect(rampGate({ id: 'rail-x', simulated: false })).toBe('live');
  });
  it('has the four steps of a journey in order', () => {
    expect([...RAMP_STEPS]).toEqual(['amount', 'quote', 'review', 'status']);
  });
});

describe('cash-out entry checks', () => {
  it('requires a destination without spaces', () => {
    expect(destinationProblem('')).toBe('empty');
    expect(destinationProblem('0xabc def')).toBe('spaces');
    expect(destinationProblem('x'.repeat(257))).toBe('long');
    expect(destinationProblem('0x52908400098527886E0F7030069857D2E4169EE7')).toBeNull();
  });
  it('compares the amount to the exact balance without rounding', () => {
    expect(offrampAmountProblem('1.000000000000000001', '1')).toBe('exceeds');
    expect(offrampAmountProblem('1', '1')).toBeNull();
    expect(offrampAmountProblem('0', '1')).toBe('zero');
    expect(offrampAmountProblem('abc', '1')).toBe('invalid');
    expect(offrampAmountProblem('5', null)).toBeNull();
  });
});

describe('cash-out identity', () => {
  const id = '0b9d6f1c-1d0f-4c9d-8a2a-5f5c8f7a1e11';
  const input = buildOfframpInput(id, { assetId: 'USDT', amount: '12.50', destinationRef: ' 0xabc ' });
  it('uses one request id as the cash-out id and the client reference', () => {
    expect(input).toEqual({ offrampId: id, clientRef: id, assetId: 'USDT', amount: '12.50', kind: 'crypto', destinationRef: '0xabc' });
  });
  it('accepts only the cash-out that was asked for', () => {
    const row = { id, assetId: 'USDT', amount: '12.5', destinationRef: '0xabc', status: 'pending' };
    expect(offrampMatches(row, input)).toBe(true);
    expect(offrampMatches({ ...row, amount: '12.51' }, input)).toBe(false);
    expect(offrampMatches({ ...row, destinationRef: '0xdef' }, input)).toBe(false);
    expect(offrampMatches({ ...row, id: '11111111-1111-4111-8111-111111111111' }, input)).toBe(false);
    expect(offrampMatches(undefined, input)).toBe(false);
  });
});

describe('status words', () => {
  it('maps known words and leaves the rest unknown', () => {
    expect(rampStatusKey('Pending')).toBe('pending');
    expect(rampStatusKey('settled')).toBe('done');
    expect(rampStatusKey('rejected')).toBe('failed');
    expect(rampStatusKey('weird')).toBe('unknown');
  });
});

describe('cash-out block', () => {
  it('names the first thing in the way, and step-up last', () => {
    expect(cashOutBlock('live', true, 2)).toBe('loading');
    expect(cashOutBlock('none', false, 2)).toBe('none');
    expect(cashOutBlock('simulated', false, 2)).toBe('simulated');
    expect(cashOutBlock('live', false, 0)).toBe('noAssets');
    expect(cashOutBlock('live', false, 2, false)).toBe('stepUp');
    expect(cashOutBlock('live', false, 2, true)).toBeNull();
  });
  it('stays blocked until a client step-up exists', () => {
    expect(CLIENT_STEP_UP).toBe(false);
    expect(cashOutBlock('live', false, 2)).toBe('stepUp');
  });
});
