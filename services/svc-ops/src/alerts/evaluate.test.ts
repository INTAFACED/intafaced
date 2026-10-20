import { describe, expect, it } from 'vitest';
import type { OpsAlertRule } from '@intafaced/contracts';
import { instanceOf, isDue, step, type InstanceState } from './evaluate.js';
import { breaches, toScaled, warehouseSignalReader } from './signals.js';
import { OpsError, OPS_WAREHOUSE_UNWIRED } from '../codes.js';

const rule: OpsAlertRule = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Ledger postings stalled',
  folder: 'ledger',
  group: 'every-minute',
  signal: 'ledger.postings.count',
  condition: { operator: 'lt', threshold: '1' },
  intervalSeconds: 60,
  pendingSeconds: 120,
  labels: { owner: 'founder' },
  annotations: {},
  noData: 'alerting',
  execError: 'alerting',
  paused: false,
  version: 1,
  createdAt: '2026-10-20T00:00:00.000Z',
  updatedAt: '2026-10-20T00:00:00.000Z',
  retiredAt: null,
};

const t = (seconds: number) => new Date(Date.UTC(2026, 9, 20, 6, 0, seconds)).toISOString();
const ok = (value: string) => ({ status: 'ok' as const, value });

describe('decimal comparison', () => {
  it('compares money strings exactly, never as numbers', () => {
    expect(breaches('gt', '0.1000000000000001', '0.1')).toBe(true);
    expect(breaches('eq', '1.50', '1.5')).toBe(true);
    expect(breaches('lt', '-2', '-1.5')).toBe(true);
    expect(breaches('gte', 'abc', '1')).toBeNull();
    expect(toScaled('1.1234567890123456789')).toBeNull();
  });
});

describe('alert step', () => {
  it('waits out the pending period before firing, then announces once with epoch 1', () => {
    const first = step(rule, null, ok('0'), t(0));
    expect(first.next).toMatchObject({ state: 'pending', epoch: 0, pendingSince: t(0) });
    expect(first.transitions).toEqual([]);
    const early = step(rule, first.next, ok('0'), t(119));
    expect(early.next.state).toBe('pending');
    expect(early.transitions).toEqual([]);
    const fires = step(rule, early.next, ok('0'), t(120));
    expect(fires.next).toMatchObject({ state: 'firing', epoch: 1, firingSince: t(120) });
    expect(fires.transitions).toEqual([{ kind: 'opened', state: 'firing', epoch: 1, at: t(120) }]);
    const still = step(rule, fires.next, ok('0'), t(180));
    expect(still.transitions).toEqual([]);
    expect(still.next.epoch).toBe(1);
  });

  it('fires at once for a pending period of zero', () => {
    const r = step({ ...rule, pendingSeconds: 0 }, null, ok('0'), t(0));
    expect(r.next.state).toBe('firing');
    expect(r.transitions).toHaveLength(1);
  });

  it('goes back to normal without any event when the condition stops holding while pending', () => {
    const pending = step(rule, null, ok('0'), t(0)).next;
    const back = step(rule, pending, ok('5'), t(60));
    expect(back.next).toMatchObject({ state: 'normal', pendingSince: null });
    expect(back.transitions).toEqual([]);
  });

  it('resolves a firing alert with the epoch it opened under, and a re-open is a new epoch', () => {
    const open = step({ ...rule, pendingSeconds: 0 }, null, ok('0'), t(0)).next;
    const closed = step(rule, open, ok('5'), t(60));
    expect(closed.transitions).toEqual([{ kind: 'resolved', epoch: 1, at: t(60) }]);
    const again = step({ ...rule, pendingSeconds: 0 }, closed.next, ok('0'), t(120));
    expect(again.transitions).toEqual([{ kind: 'opened', state: 'firing', epoch: 2, at: t(120) }]);
  });

  it('reads no data as an alert by default: health no data, state firing', () => {
    const r = step({ ...rule, pendingSeconds: 0 }, null, { status: 'no_data' }, t(0));
    expect(r.next).toMatchObject({ state: 'firing', health: 'no_data' });
    expect(r.transitions).toEqual([{ kind: 'opened', state: 'no_data', epoch: 1, at: t(0) }]);
  });

  it('raises an error alert about the rule itself when the check errors', () => {
    const r = step({ ...rule, pendingSeconds: 0 }, null, { status: 'error', code: 'ops.warehouse_unwired' }, t(0));
    expect(r.next).toMatchObject({ state: 'firing', health: 'error', lastCode: 'ops.warehouse_unwired' });
    expect(r.transitions).toEqual([{ kind: 'opened', state: 'error', epoch: 1, at: t(0) }]);
  });

  it('keeps the last state and labels it when the rule says keep last', () => {
    const keep = { ...rule, noData: 'keep_last' as const, pendingSeconds: 0 };
    const firing = step(keep, null, ok('0'), t(0)).next;
    const empty = step(keep, firing, { status: 'no_data' }, t(60));
    expect(empty.next).toMatchObject({ state: 'firing', health: 'no_data', kept: true });
    expect(empty.transitions).toEqual([]);
    const healthy = step(keep, empty.next, ok('0'), t(120));
    expect(healthy.next.kept).toBe(false);
    expect(healthy.next.health).toBe('ok');
  });

  it('lets a rule choose normal for no data', () => {
    const r = step({ ...rule, noData: 'normal' }, null, { status: 'no_data' }, t(0));
    expect(r.next).toMatchObject({ state: 'normal', health: 'no_data' });
  });

  it('treats a value it cannot compare as an unreadable check, not a healthy one', () => {
    const r = step({ ...rule, pendingSeconds: 0 }, null, ok('not-a-number'), t(0));
    expect(r.next).toMatchObject({ health: 'error', state: 'firing', lastCode: 'ops.alert_signal_value_invalid' });
  });

  it('is due only after its own interval', () => {
    const prev = { lastEvaluatedAt: t(0) } as InstanceState;
    expect(isDue(rule, null, Date.parse(t(0)))).toBe(true);
    expect(isDue(rule, prev, Date.parse(t(59)))).toBe(false);
    expect(isDue(rule, prev, Date.parse(t(60)))).toBe(true);
  });

  it('gives the same instance for the same labels in any order', () => {
    expect(instanceOf({ a: '1', b: '2' })).toBe(instanceOf({ b: '2', a: '1' }));
    expect(instanceOf({})).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('warehouse signal reader', () => {
  it('reports an unwired warehouse as an error reading with its code, never as zero', async () => {
    const reader = warehouseSignalReader({
      revenue: async () => {
        throw new OpsError(OPS_WAREHOUSE_UNWIRED, 'not wired');
      },
    });
    expect(await reader.read('ledger.postings.count')).toEqual({ status: 'error', code: OPS_WAREHOUSE_UNWIRED });
  });

  it('reports an empty or missing metric as no data, and sums a metric across dimensions exactly', async () => {
    const points = [
      { metricId: 'ledger.postings.count', value: '2', dim: 'a' },
      { metricId: 'ledger.postings.count', value: '3', dim: 'b' },
      { metricId: 'trade.fills.count', value: '9', dim: null },
    ];
    const revenue = async (empty: boolean) =>
      ({ empty, status: empty ? 'empty' : 'ok', mayLabelLive: false, freshness: 'live', points }) as never;
    expect(await warehouseSignalReader({ revenue: () => revenue(false) }).read('ledger.postings.count')).toEqual({
      status: 'ok',
      value: '5',
    });
    expect(await warehouseSignalReader({ revenue: () => revenue(false) }).read('ledger.volume.notional')).toEqual({ status: 'no_data' });
    expect(await warehouseSignalReader({ revenue: () => revenue(true) }).read('ledger.postings.count')).toEqual({ status: 'no_data' });
  });
});
