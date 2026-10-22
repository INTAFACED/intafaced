import { describe, expect, it } from 'vitest';
import {
  STATUS_SAMPLING_UNSET,
  statusComponentDefineInputSchema,
  statusComponentSchema,
  statusComponentsListSchema,
  statusFromReading,
  statusPageErrorCodeSchema,
  statusReadingSchema,
  statusTopLevel,
  statusUptimeSeriesSchema,
} from './status-page.js';

const uuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const reading = { status: 'operational', observedAt: '2026-10-22T03:00:00Z', source: 'svc-pay' } as const;
const component = {
  componentId: uuid,
  groupId: null,
  name: 'Payments',
  source: { kind: 'service', service: 'svc-pay' },
  status: 'operational',
  reading,
};

describe('status page contracts (SP-status-01)', () => {
  it('declares the new codes', () => {
    expect(statusPageErrorCodeSchema.options).toHaveLength(4);
  });
  it('top level follows ST-2', () => {
    expect(statusTopLevel([])).toBe('none');
    expect(statusTopLevel(['operational', 'degraded_performance'])).toBe('degraded_performance');
    expect(statusTopLevel(['operational', 'no_data'])).toBe('no_data');
    expect(statusTopLevel(['no_data', 'no_data'])).toBe('no_data');
    expect(statusTopLevel(['under_maintenance', 'operational'])).toBe('operational');
    expect(statusTopLevel(['under_maintenance'])).toBe('under_maintenance');
    expect(statusTopLevel(['major_outage', 'partial_outage', 'no_data'])).toBe('major_outage');
  });
  it('missing, stale, future or unset-staleness readings are no_data', () => {
    const now = new Date('2026-10-22T03:05:00Z');
    expect(statusFromReading(null, now, 600)).toBe('no_data');
    expect(statusFromReading(reading, now, null)).toBe('no_data');
    expect(statusFromReading(reading, now, 60)).toBe('no_data');
    expect(statusFromReading({ ...reading, observedAt: '2026-10-22T04:00:00Z' }, now, 600)).toBe('no_data');
    expect(statusFromReading(reading, now, 600)).toBe('operational');
  });
  it('a published reading cannot claim no_data; a component without a reading must be no_data', () => {
    expect(statusReadingSchema.safeParse({ ...reading, status: 'no_data' }).success).toBe(false);
    expect(statusComponentSchema.safeParse({ ...component, reading: null }).success).toBe(false);
    expect(statusComponentSchema.safeParse({ ...component, reading: null, status: 'no_data' }).success).toBe(true);
  });
  it('list refuses a top level that does not follow ST-2', () => {
    const page = { topLevel: 'operational', groups: [], components: [component], readAt: reading.observedAt };
    expect(statusComponentsListSchema.safeParse(page).success).toBe(true);
    expect(statusComponentsListSchema.safeParse({ ...page, topLevel: 'operational', components: [] }).success).toBe(false);
    expect(statusComponentsListSchema.safeParse({ ...page, components: [], topLevel: 'none' }).success).toBe(true);
  });
  it('uptime only from samples, in basis points', () => {
    expect(statusUptimeSeriesSchema.safeParse({ status: 'sampling_unset', code: STATUS_SAMPLING_UNSET }).success).toBe(true);
    const bucket = { start: reading.observedAt, samples: 10, operational: 9, uptimeBps: 9000 };
    const ok = { status: 'sampled', componentId: uuid, buckets: [bucket] };
    expect(statusUptimeSeriesSchema.safeParse(ok).success).toBe(true);
    for (const b of [
      { ...bucket, samples: 0 },
      { ...bucket, uptimeBps: 99.5 },
      { ...bucket, operational: 11 },
      { ...bucket, samples: 0, operational: 0, uptimeBps: 0 },
    ])
      expect(statusUptimeSeriesSchema.safeParse({ ...ok, buckets: [b] }).success).toBe(false);
  });
  it('define carries a revision and a valid source', () => {
    const input = { componentId: null, expectedRevision: 0, groupId: null, name: 'Edge', source: { kind: 'third_party', label: 'CDN' } };
    expect(statusComponentDefineInputSchema.safeParse(input).success).toBe(true);
    expect(statusComponentDefineInputSchema.safeParse({ ...input, source: { kind: 'service', service: 'pay' } }).success).toBe(false);
    expect(statusComponentDefineInputSchema.safeParse({ ...input, status: 'operational' }).success).toBe(false);
  });
});
