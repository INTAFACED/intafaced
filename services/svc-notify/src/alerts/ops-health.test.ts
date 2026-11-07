import { describe, expect, it } from 'vitest';
import { channelDeliveries, sweepView } from './ops-health.js';

const report = { markets: 2, fired: 12, held: 30, refused: 1, refusals: { 'alert.price_unavailable': 1 } };

describe('sweepView (J-charts-desk-18 #4 evaluation lag)', () => {
  const now = new Date('2026-11-07T10:00:30Z');

  it('reads the lag from the end of the last pass, its duration and whether it is late', () => {
    const view = sweepView(
      { startedAt: new Date('2026-11-07T10:00:00Z'), finishedAt: new Date('2026-11-07T10:00:02Z'), report },
      null,
      60_000,
      now,
    );
    expect(view).toMatchObject({ lagSeconds: 28, lastDurationMs: 2_000, late: false, last: report, lastFailure: null });
  });

  it('calls a sweep late past one interval and a half', () => {
    const view = sweepView(
      { startedAt: new Date('2026-11-07T09:58:00Z'), finishedAt: new Date('2026-11-07T09:58:59Z'), report },
      null,
      60_000,
      now,
    );
    expect(view.late).toBe(true);
  });

  it('says a sweep that never completed is unknown, never zero', () => {
    expect(sweepView(null, null, 60_000, now)).toMatchObject({ lagSeconds: null, late: null, last: null, lastDurationMs: null });
  });

  it('shows a failure only when it is newer than the last completed pass', () => {
    const record = { startedAt: new Date('2026-11-07T10:00:00Z'), finishedAt: new Date('2026-11-07T10:00:02Z'), report };
    expect(sweepView(record, { at: new Date('2026-11-07T09:59:00Z'), message: 'old' }, 60_000, now).lastFailure).toBeNull();
    expect(sweepView(record, { at: new Date('2026-11-07T10:00:20Z'), message: 'db down' }, 60_000, now).lastFailure).toEqual({
      at: '2026-11-07T10:00:20.000Z',
      message: 'db down',
    });
  });
});

describe('channelDeliveries (J-charts-desk-18 #4 deliveries and failures per channel)', () => {
  it('groups by channel, counts each status and failures as failed plus abandoned', () => {
    expect(
      channelDeliveries([
        { channel: 'inapp', status: 'accepted', n: 12 },
        { channel: 'email', status: 'accepted', n: 11 },
        { channel: 'email', status: 'failed', n: 1 },
        { channel: 'email', status: 'abandoned', n: 2 },
        { channel: 'email', status: 'refused', n: 3 },
      ]),
    ).toEqual([
      {
        channel: 'email',
        total: 17,
        failures: 3,
        byStatus: { pending: 0, accepted: 11, refused: 3, failed: 1, abandoned: 2 },
      },
      { channel: 'inapp', total: 12, failures: 0, byStatus: { pending: 0, accepted: 12, refused: 0, failed: 0, abandoned: 0 } },
    ]);
  });

  it('is empty when nothing was delivered', () => {
    expect(channelDeliveries([])).toEqual([]);
  });
});
