import { describe, expect, it } from 'vitest';
import { formatClock, minutesToMs, planSlices } from './plan';

describe('planSlices (mirrors svc-trade algo/schedule.ts)', () => {
  it('splits equally and lets the last slice take the remainder', () => {
    const plan = planSlices({ totalQty: '1', durationMs: 600_000, sliceIntervalMs: 180_000, lotSize: '0.00001' });
    expect(plan).toEqual({ ok: true, slices: 3, perSlice: '0.33333', lastSlice: '0.33333', planned: '0.99999', leftOut: '0.00001' });
  });
  it('shows what the lot size leaves out instead of inventing it', () => {
    const even = planSlices({ totalQty: '1', durationMs: 400_000, sliceIntervalMs: 100_000, lotSize: '0.05' });
    expect(even).toEqual({ ok: true, slices: 4, perSlice: '0.25', lastSlice: '0.25', planned: '1', leftOut: '0' });
    const lost = planSlices({ totalQty: '1', durationMs: 300_000, sliceIntervalMs: 100_000, lotSize: '0.3' });
    expect(lost).toEqual({ ok: true, slices: 3, perSlice: '0.3', lastSlice: '0.3', planned: '0.9', leftOut: '0.1' });
  });
  it('refuses a total below one lot, a bad schedule and a day-plus run', () => {
    expect(planSlices({ totalQty: '0.0001', durationMs: 60_000, sliceIntervalMs: 60_000, lotSize: '0.001' })).toEqual({
      ok: false,
      why: 'belowLot',
    });
    expect(planSlices({ totalQty: '1', durationMs: 60_000, sliceIntervalMs: 120_000, lotSize: '0.001' })).toEqual({
      ok: false,
      why: 'schedule',
    });
    expect(planSlices({ totalQty: '1', durationMs: 90_000_000, sliceIntervalMs: 60_000, lotSize: '0.001' })).toEqual({
      ok: false,
      why: 'tooLong',
    });
    expect(planSlices({ totalQty: '', durationMs: 60_000, sliceIntervalMs: 60_000, lotSize: '0.001' })).toEqual({ ok: false, why: 'qty' });
  });
});
describe('time helpers', () => {
  it('reads minutes exactly', () => {
    expect(minutesToMs('10')).toBe(600_000);
    expect(minutesToMs('0.5')).toBe(30_000);
    expect(minutesToMs('0')).toBeNull();
    expect(minutesToMs('abc')).toBeNull();
  });
  it('writes a duration in words', () => {
    expect(formatClock(5_400_000)).toBe('1 h 30 min');
    expect(formatClock(45_000)).toBe('45 s');
  });
});
