import { describe, expect, it } from 'vitest';
import { byFamily, deviceName, type Device } from './devices';

const row = (over: Partial<Device>): Device => ({
  id: '00000000-0000-4000-8000-000000000001',
  familyId: '00000000-0000-4000-8000-0000000000a1',
  createdAt: '2026-10-01T00:00:00.000Z',
  lastUsedAt: '2026-10-02T00:00:00.000Z',
  device: null,
  userAgent: null,
  country: null,
  isCurrent: false,
  ...over,
});

describe('devices', () => {
  it('names a device from the browser string, and falls back to the stored name or nothing', () => {
    expect(deviceName({ device: null, userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120 Safari/537' })).toBe('Chrome on Windows');
    expect(deviceName({ device: null, userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120 Edg/120' })).toBe('Edge on Windows');
    expect(deviceName({ device: null, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17) Safari/604' })).toBe('Safari on iOS');
    expect(deviceName({ device: ' Work laptop ', userAgent: null })).toBe('Work laptop');
    expect(deviceName({ device: null, userAgent: null })).toBeNull();
  });

  it('shows one row per sign-in, this device first, then newest activity first', () => {
    const a = row({
      id: '00000000-0000-4000-8000-000000000002',
      familyId: '00000000-0000-4000-8000-0000000000a2',
      lastUsedAt: '2026-10-05T00:00:00.000Z',
    });
    const b = row({ familyId: '00000000-0000-4000-8000-0000000000a3', lastUsedAt: '2026-10-09T00:00:00.000Z' });
    const mine = row({ familyId: '00000000-0000-4000-8000-0000000000a4', lastUsedAt: '2026-10-01T00:00:00.000Z', isCurrent: true });
    const dup = row({ id: '00000000-0000-4000-8000-000000000009', familyId: a.familyId, lastUsedAt: '2026-10-04T00:00:00.000Z' });
    expect(byFamily([a, dup, b, mine]).map((d) => d.familyId)).toEqual([mine.familyId, b.familyId, a.familyId]);
  });
});
