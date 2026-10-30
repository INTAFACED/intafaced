import { describe, expect, it } from 'vitest';
import { dayRange, last30Days } from './statement-centre-model';

describe('statement centre dates', () => {
  it('offers the last 30 UTC days, today included', () => {
    expect(last30Days(new Date('2026-10-30T23:59:00.000Z'))).toEqual({ from: '2026-10-01', to: '2026-10-30' });
    expect(last30Days(new Date('2026-03-01T00:00:01.000Z'))).toEqual({ from: '2026-01-31', to: '2026-03-01' });
  });
  it('turns two days into the whole of both in UTC', () => {
    expect(dayRange('2026-10-01', '2026-10-30')).toEqual({ from: '2026-10-01T00:00:00.000Z', to: '2026-10-30T23:59:59.999Z' });
    expect(dayRange('2026-10-05', '2026-10-05')).toEqual({ from: '2026-10-05T00:00:00.000Z', to: '2026-10-05T23:59:59.999Z' });
  });
  it('has no range for a missing, unreal or backwards day', () => {
    expect(dayRange('', '2026-10-30')).toBeNull();
    expect(dayRange('2026-02-30', '2026-03-01')).toBeNull();
    expect(dayRange('2026-10-30', '2026-10-01')).toBeNull();
  });
});
