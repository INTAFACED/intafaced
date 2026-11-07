import { describe, expect, it } from 'vitest';
import { maintenanceOf, maintenanceWhen } from './market-maintenance';

const NOW = Date.parse('2026-11-06T09:00:00.000Z');

describe('market maintenance (J-cex-spot-14 #5)', () => {
  it('reads a scheduled or running window; none and unavailable show nothing', () => {
    expect(maintenanceOf({ status: 'scheduled', startsAt: '2026-11-06T10:00:00.000Z', endsAt: null })).toEqual({
      status: 'scheduled',
      startsAt: Date.parse('2026-11-06T10:00:00.000Z'),
      endsAt: null,
    });
    expect(maintenanceOf({ status: 'none' })).toBeNull();
    expect(maintenanceOf({ status: 'unavailable' })).toBeNull();
    expect(maintenanceOf(null)).toBeNull();
  });

  it('an hour away reads 1 hour (a page drawn a little later still does); under an hour reads minutes', () => {
    const at = (iso: string) => ({ status: 'scheduled' as const, startsAt: Date.parse(iso), endsAt: null });
    expect(maintenanceWhen(at('2026-11-06T10:00:00.000Z'), NOW)).toEqual({ kind: 'hours', n: 1 });
    expect(maintenanceWhen(at('2026-11-06T10:00:00.000Z'), NOW + 30_000)).toEqual({ kind: 'hours', n: 1 });
    expect(maintenanceWhen(at('2026-11-06T09:20:00.000Z'), NOW)).toEqual({ kind: 'minutes', n: 20 });
    expect(maintenanceWhen(at('2026-11-06T12:00:00.000Z'), NOW)).toEqual({ kind: 'hours', n: 3 });
    expect(maintenanceWhen({ status: 'in_progress', startsAt: NOW, endsAt: null }, NOW)).toEqual({ kind: 'now' });
  });
});
