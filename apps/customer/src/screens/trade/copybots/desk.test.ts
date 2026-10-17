import { describe, expect, it } from 'vitest';
import { bpsText, deskState, ratioPercent } from './desk';

describe('deskState', () => {
  it('is closed with a plain reason for each missing approval', () => {
    const state = deskState({
      feeSharePublished: false,
      jurisdictionPublished: false,
      leaderShareBps: null,
      autoMirrorPlace: { published: false },
    });
    expect(state?.open).toBe(false);
    expect(state?.reasons).toHaveLength(3);
    expect(state?.reasons.join(' ')).not.toMatch(/DIRECTION|D26|residual/i);
  });
  it('is open only when both approvals exist', () => {
    expect(deskState({ feeSharePublished: true, jurisdictionPublished: true, leaderShareBps: '1000' })?.open).toBe(true);
    expect(deskState({ feeSharePublished: true, jurisdictionPublished: false, leaderShareBps: '1000' })?.open).toBe(false);
  });
  it('knows nothing before the first read', () => expect(deskState(null)).toBeNull());
});
describe('bpsText', () => {
  it('writes basis points as a percent', () => {
    expect(bpsText('1000')).toBe('10%');
    expect(bpsText('250')).toBe('2.5%');
    expect(bpsText('5')).toBe('0.05%');
    expect(bpsText(null)).toBeNull();
    expect(bpsText('1.5')).toBeNull();
  });
});
describe('ratioPercent', () => {
  it('writes a fee ratio as a percent without rounding', () => {
    expect(ratioPercent('0.001')).toBe('0.1%');
    expect(ratioPercent('0.0025')).toBe('0.25%');
    expect(ratioPercent('0')).toBe('0%');
    expect(ratioPercent('x')).toBeNull();
  });
});
