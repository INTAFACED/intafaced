import { describe, expect, it } from 'vitest';
import { chartDataClassPayloadHash, chartScalarClientRequestId } from './charts-owner-values-hash';

describe('chart data class approval hash', () => {
  // Golden vectors shared with services/svc-trade/src/admin/chart-owner-values.router.test.ts. svc-trade recomputes
  // this hash when the change is applied; a founder who approves these values is approving exactly these bytes.
  it('matches the golden value svc-trade computes for the same change', () => {
    expect(
      chartDataClassPayloadHash({
        symbol: 'BTC/USDT',
        dataClass: 'real_time',
        expectedVersion: '0',
        reason: 'list BTC for the charts pilot',
      }),
    ).toBe('sha256:d51ed1f6e5d8fc7ea6c05ea66c3ebd4f92df8647963ae67d3b53710de74a6e67');
  });

  it('hashes a blank data class (null) as JSON null', () => {
    expect(
      chartDataClassPayloadHash({
        symbol: 'BTC/USDT',
        dataClass: null,
        expectedVersion: '1',
        reason: 'clear it for the test',
      }),
    ).toBe('sha256:425ca410d5d0d8800019b806451338b0943c8c0e5709faa19de50e937c0ceaf8');
  });

  it('changes when any part of the change changes', () => {
    const base = { symbol: 'BTC/USDT', dataClass: 'real_time' as const, expectedVersion: '0', reason: 'list BTC for the charts pilot' };
    const h = chartDataClassPayloadHash(base);
    expect(chartDataClassPayloadHash({ ...base, dataClass: 'delayed' })).not.toBe(h);
    expect(chartDataClassPayloadHash({ ...base, symbol: 'ETH/USDT' })).not.toBe(h);
    expect(chartDataClassPayloadHash({ ...base, expectedVersion: '1' })).not.toBe(h);
    expect(chartDataClassPayloadHash({ ...base, reason: 'another reason here' })).not.toBe(h);
  });
});

describe('chart scalar client request id', () => {
  it('is a business key: the same write names the same key, and a different value names another', () => {
    const a = chartScalarClientRequestId('compareCap', '0', 3, 'set the compare cap');
    expect(chartScalarClientRequestId('compareCap', '0', 3, 'set the compare cap')).toBe(a);
    expect(chartScalarClientRequestId('compareCap', '0', 4, 'set the compare cap')).not.toBe(a);
    expect(a.startsWith('chart-owner:compareCap:v0:')).toBe(true);
    expect(a.length).toBeLessThanOrEqual(128);
  });

  it('a blank value (clear) has its own key, and never a random one', () => {
    const clear = chartScalarClientRequestId('drawingCap', '2', null, 'clear the drawing cap');
    expect(clear).toBe(chartScalarClientRequestId('drawingCap', '2', null, 'clear the drawing cap'));
    expect(clear).not.toBe(chartScalarClientRequestId('drawingCap', '2', 50, 'clear the drawing cap'));
  });
});
