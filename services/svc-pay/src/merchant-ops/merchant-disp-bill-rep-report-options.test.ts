import { describe, expect, it } from 'vitest';
import { EXPORT_KINDS, resolveExportColumns } from './exports.js';
import { MerchantOpsError } from './errors.js';
import { assertTimeZone, reportOptions, zonedFilters, zonedMidnight } from './merchant-disp-bill-rep-report-options.js';
import type { MerchantCaller } from './roles.js';

const caller = (role: MerchantCaller['role']): MerchantCaller => ({
  merchantId: 'm',
  userId: 'u',
  role,
  viaApiKey: false,
  interactive: true,
});
const NOW = new Date('2026-12-10T00:00:00Z');

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(MerchantOpsError);
    return (e as MerchantOpsError).code;
  }
  throw new Error('expected a refusal');
}

describe('M-rep-01 zoned report periods', () => {
  it('Asia/Makassar: a payment at 23:30 UTC on 1 Dec falls in the report for 2 Dec (reporting-recon-008)', () => {
    const f = zonedFilters({}, { fromDay: '2026-12-02', toDay: '2026-12-02', timeZone: 'Asia/Makassar' }, NOW);
    expect(f).toEqual({ from: '2026-12-01T16:00:00.000Z', to: '2026-12-02T16:00:00.000Z' });
    const payment = Date.parse('2026-12-01T23:30:00Z');
    expect(payment >= Date.parse(f.from!) && payment < Date.parse(f.to!)).toBe(true);
  });

  it('handles a DST day correctly (America/New_York, 1 Nov 2026 is 25 hours)', () => {
    const f = zonedFilters({}, { fromDay: '2026-11-01', toDay: '2026-11-01', timeZone: 'America/New_York' }, NOW);
    expect(f.from).toBe('2026-11-01T04:00:00.000Z');
    expect(f.to).toBe('2026-11-02T05:00:00.000Z');
  });

  it('UTC is identity and keeps other filters', () => {
    expect(zonedFilters({ assetId: 'USDT' }, { fromDay: '2026-12-01', toDay: '2026-12-03', timeZone: 'UTC' }, NOW)).toEqual({
      assetId: 'USDT',
      from: '2026-12-01T00:00:00.000Z',
      to: '2026-12-04T00:00:00.000Z',
    });
  });

  it('refuses an unknown zone, a reversed period, an impossible date, a future period, and mixing with raw from/to', () => {
    expect(code(() => assertTimeZone('Mars/Olympus'))).toBe('pay.export_time_zone_unknown');
    expect(code(() => zonedFilters({}, { fromDay: '2026-12-03', toDay: '2026-12-01', timeZone: 'UTC' }, NOW))).toBe(
      'pay.export_filter_invalid',
    );
    expect(code(() => zonedMidnight('2026-02-30', 'UTC'))).toBe('pay.export_filter_invalid');
    expect(code(() => zonedFilters({}, { fromDay: '2026-12-11', toDay: '2026-12-12', timeZone: 'UTC' }, NOW))).toBe(
      'pay.export_period_future',
    );
    expect(
      code(() => zonedFilters({ from: '2026-12-01T00:00:00Z' }, { fromDay: '2026-12-01', toDay: '2026-12-01', timeZone: 'UTC' }, NOW)),
    ).toBe('pay.export_filter_invalid');
  });
});

describe('M-rep-01 report options', () => {
  it('lists every kind with its date basis and exactly the columns the role may pick', () => {
    for (const role of ['owner', 'admin', 'finance', 'developer', 'viewer'] as const) {
      const o = reportOptions(caller(role));
      expect(o.formats).toEqual(['csv']);
      expect(o.kinds.map((k) => k.kind)).toEqual([...EXPORT_KINDS]);
      for (const k of o.kinds) expect(k.columns).toEqual(resolveExportColumns(k.kind, role, undefined));
    }
    const viewerFees = reportOptions(caller('viewer')).kinds.find((k) => k.kind === 'fees')!;
    expect(viewerFees.columns).not.toContain('fee_bps');
    expect(reportOptions(caller('owner')).kinds.find((k) => k.kind === 'payments')!.dateBasis).toBe('created');
  });
});
