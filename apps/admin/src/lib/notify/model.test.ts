import { describe, expect, it } from 'vitest';
import { channelStats, failureRows, readDeliveries, readHealth, spanOf, type DeliveryRow } from './model';

const row = (over: Partial<DeliveryRow> = {}): DeliveryRow => ({
  id: crypto.randomUUID(),
  notificationId: crypto.randomUUID(),
  channel: 'email',
  status: 'accepted',
  attempts: 1,
  attemptedAt: '2026-10-17T02:00:00.000Z',
  acceptedAt: '2026-10-17T02:00:01.000Z',
  refusalCode: null,
  createdAt: '2026-10-17T02:00:00.000Z',
  updatedAt: '2026-10-17T02:00:01.000Z',
  ...over,
});

describe('delivery reader', () => {
  it('reads rows and keeps the page size', () => {
    const read = readDeliveries([row(), row({ channel: 'inapp' })], 200);
    expect(read?.rows).toHaveLength(2);
    expect(read?.limit).toBe(200);
  });
  it('an empty list is empty, not unreadable', () => expect(readDeliveries([], 200)).toEqual({ rows: [], limit: 200 }));
  it('refuses a malformed row rather than dropping it: a missing failure must not look like health', () => {
    for (const bad of [
      null,
      {},
      row({ status: 'delivered' as never }),
      row({ attempts: -1 }),
      row({ attempts: 1.5 }),
      row({ createdAt: 'x' }),
      row({ channel: '' }),
      { ...row(), refusalCode: 5 },
    ]) {
      expect(readDeliveries([row(), bad], 200)).toBeNull();
    }
    expect(readDeliveries('nope', 200)).toBeNull();
  });
  it('reads health strictly', () => {
    expect(readHealth({ ok: true, service: 'svc-notify', fanoutEnabled: false, venueIncident: {} })).toEqual({
      ok: true,
      fanoutEnabled: false,
    });
    expect(readHealth({ ok: true, service: 'other', fanoutEnabled: true })).toBeNull();
    expect(readHealth({ ok: true, service: 'svc-notify' })).toBeNull();
  });
});

describe('per-channel figures', () => {
  const rows = [
    row({ channel: 'email' }),
    row({ channel: 'email' }),
    row({ channel: 'email', status: 'refused', refusalCode: 'channel.not_configured', acceptedAt: null }),
    row({ channel: 'email', status: 'failed', refusalCode: 'gateway.timeout', acceptedAt: null }),
    row({ channel: 'email', status: 'pending', acceptedAt: null, createdAt: '2026-10-17T01:00:00.000Z' }),
    row({ channel: 'email', status: 'pending', acceptedAt: null, createdAt: '2026-10-17T01:30:00.000Z' }),
    row({ channel: 'push', status: 'abandoned', refusalCode: 'gateway.timeout', acceptedAt: null }),
    row({ channel: 'inapp' }),
  ];
  const stats = channelStats(rows);
  const email = stats.find((s) => s.channel === 'email')!;
  it('counts every status and keeps channels apart, sorted by name', () => {
    expect(stats.map((s) => s.channel)).toEqual(['email', 'inapp', 'push']);
    expect(email.counts).toEqual({ pending: 2, accepted: 2, refused: 1, failed: 1, abandoned: 0 });
    expect(email.total).toBe(6);
  });
  it('accepted-of-settled excludes pending, and shows numerator and denominator', () => {
    expect(email.settled).toBe(4);
    expect(email.acceptedPercent).toBe(50);
  });
  it('nothing settled is "nothing settled", never 0% or 100%', () => {
    const only = channelStats([row({ status: 'pending', acceptedAt: null })])[0]!;
    expect(only.acceptedPercent).toBeNull();
  });
  it('finds the oldest pending and the most common refusal codes', () => {
    expect(email.oldestPendingCreatedAt).toBe('2026-10-17T01:00:00.000Z');
    expect(email.topRefusalCodes).toEqual([
      { code: 'channel.not_configured', count: 1 },
      { code: 'gateway.timeout', count: 1 },
    ]);
  });
  it('a channel with no rows has no entry: absent is not healthy', () => {
    expect(stats.find((s) => s.channel === 'sms')).toBeUndefined();
  });
});

describe('failures and span', () => {
  it('lists only refused, failed and abandoned, newest update first', () => {
    const a = row({ status: 'failed', updatedAt: '2026-10-17T02:10:00.000Z' });
    const b = row({ status: 'refused', updatedAt: '2026-10-17T02:20:00.000Z' });
    const c = row({ status: 'pending', updatedAt: '2026-10-17T02:30:00.000Z' });
    expect(failureRows([a, b, c, row()]).map((r) => r.id)).toEqual([b.id, a.id]);
  });
  it('the span is by last update, and a full page is flagged', () => {
    const read = readDeliveries([row({ updatedAt: '2026-10-17T02:00:00.000Z' }), row({ updatedAt: '2026-10-17T03:00:00.000Z' })], 2)!;
    expect(spanOf(read)).toEqual({ from: '2026-10-17T02:00:00.000Z', to: '2026-10-17T03:00:00.000Z', pageFull: true });
    expect(spanOf({ ...read, limit: 200 })?.pageFull).toBe(false);
    expect(spanOf({ rows: [], limit: 200 })).toBeNull();
  });
});
