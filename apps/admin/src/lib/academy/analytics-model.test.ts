import { describe, expect, it } from 'vitest';
import { ACTIVITY_DAYS, activityWindow, cellText, stateText, type AcademyReportTask } from './analytics-model';

describe('Academy numbers on the console', () => {
  it('reads the last whole UTC days, today last', () => {
    expect(activityWindow(new Date('2026-11-12T23:59:00Z'))).toEqual({ from: '2026-10-30', to: '2026-11-12' });
    expect(ACTIVITY_DAYS).toBe(14);
  });

  it('shows a day the service did not record as "not recorded", and a recorded zero as 0', () => {
    expect(cellText({ value: null, reason: 'metric_not_recorded' })).toBe('not recorded');
    expect(cellText({ value: 0, reason: null })).toBe('0');
  });

  it('names a finished file past its retention Expired', () => {
    const task = { state: 'done', expired: false } as AcademyReportTask;
    expect(stateText(task)).toBe('Finished');
    expect(stateText({ ...task, expired: true })).toBe('Expired');
    expect(stateText({ ...task, state: 'queued' })).toBe('Requested');
  });
});
