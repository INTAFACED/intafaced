import { describe, expect, it } from 'vitest';
import { checkMaintenanceDraft, parseOffsets } from './maintenance-model';

describe('maintenance desk model', () => {
  it('reads reminder offsets as whole minutes, distinct and largest first; blank is none', () => {
    expect(parseOffsets('')).toEqual([]);
    expect(parseOffsets('10, 30 10')).toEqual([30, 10]);
    expect(parseOffsets('0')).toBeNull();
    expect(parseOffsets('1.5')).toBeNull();
    expect(parseOffsets('43201')).toBeNull();
    expect(parseOffsets(Array.from({ length: 11 }, (_, i) => i + 1).join(','))).toBeNull();
  });

  it('a window names its start and a later planned end', () => {
    const base = { title: 'TEST', body: 'TEST', components: [], reminderOffsets: [] };
    expect(checkMaintenanceDraft({ ...base, startsAt: '2026-10-23T12:00:00Z', endsAt: '2026-10-23T13:00:00Z' })).toEqual({ ok: true });
    expect(checkMaintenanceDraft({ ...base, startsAt: '', endsAt: '2026-10-23T13:00:00Z' }).ok).toBe(false);
    expect(checkMaintenanceDraft({ ...base, startsAt: '2026-10-23T12:00:00Z', endsAt: '2026-10-23T12:00:00Z' }).ok).toBe(false);
  });
});
